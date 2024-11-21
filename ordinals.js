/* eslint-disable @typescript-eslint/no-var-requires */
// Integration with data on chain or offchain
// https://changelly.com/blog/bitcoin-ordinals/
// https://research.aimultiple.com/how-to-create-ordinal-inscriptions/
// https://docs.ordinals.com/guides/inscriptions.html

// It sends two transactions
// The commit transaction commits to a tapscript containing the content of the inscription
// the reveal transaction spends from that tapscript

// It's spendable once both are confirmed
// Once the reveal transaction has been mined, the inscription ID should be printed
// To make an inscription a child of another (collection), the parent inscription has to be inscribed and present in the wallet
// Rarity based on some data

const psbtUtils = require('bitcoinjs-lib/src/psbt/psbtutils');
const ECPairFactory = require('ecpair');
const assert = require('minimalistic-assert');
const bitcoinjsLib = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');

const { witnessStackToScriptWitness } = psbtUtils;

bitcoinjsLib.initEccLib(ecc);

const ECPair = ECPairFactory.default(ecc);
const network = bitcoinjsLib.networks.testnet;
const encoder = new TextEncoder();

const toXOnly = pubkey => {
  return pubkey.subarray(1, 33);
};

const createTextInscription = ({ text, postage = 10000 }) => {
  const contentType = Buffer.from(encoder.encode('text/plain;charset=utf-8'));
  const content = Buffer.from(encoder.encode(text));
  return { contentType, content, postage };
};

const createInscriptionScript = ({ xOnlyPublicKey, inscription }) => {
  assert(xOnlyPublicKey instanceof Buffer, `xOnlyPublicKey must be a Buffer`);
  assert(inscription, `inscription is required`);
  assert(inscription.content instanceof Buffer, `inscription.content must be a Buffer`);
  assert(inscription.contentType instanceof Buffer, `inscription.content must be a Buffer`);
  const protocolId = Buffer.from(encoder.encode('ord'));
  return [
    xOnlyPublicKey,
    bitcoinjsLib.opcodes.OP_CHECKSIG,
    bitcoinjsLib.opcodes.OP_0,
    bitcoinjsLib.opcodes.OP_IF,
    protocolId,
    1,
    1, // ISSUE, Buffer.from([1]) is replaced to 05 rather asMinimalOP than 0101 here https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/src/script.js#L53
    // this may not be an issue but it generates a different script address. Unsure if ordinals indexer detect 05 as the content type separator
    inscription.contentType,
    bitcoinjsLib.opcodes.OP_0,
    inscription.content,
    bitcoinjsLib.opcodes.OP_ENDIF,
  ];
};

// 390 kb - 400 kb per transaction
// Option of having many transactions in order to send bigger data

const createCommitTxData = ({ publicKey, inscription }) => {
  assert(publicKey, 'encodePublic is required');
  assert(inscription, 'inscription is required');
  const xOnlyPublicKey = toXOnly(publicKey);
  const script = createInscriptionScript({ xOnlyPublicKey, inscription });

  const outputScript = bitcoinjsLib.script.compile(script);

  const scriptTree = {
    output: outputScript,
    redeemVersion: 192,
  };

  const scriptTaproot = bitcoinjsLib.payments.p2tr({
    internalPubkey: xOnlyPublicKey,
    scriptTree,
    redeem: scriptTree,
    network,
  });

  const tapleaf = scriptTaproot.hash.toString('hex');

  const revealAddress = scriptTaproot.address;
  const tpubkey = scriptTaproot.pubkey.toString('hex');
  const cblock = scriptTaproot.witness?.[scriptTaproot.witness.length - 1].toString('hex');

  return {
    script,
    tapleaf,
    tpubkey,
    cblock,
    revealAddress,
    scriptTaproot,
    outputScript,
  };
};

const createRevealTx = async ({ commitTxData, commitTxResult, toAddress, privateKey, amount }) => {
  assert(commitTxData, `commitTxData is required`);
  assert(commitTxResult, `commitTxResult is required`);
  assert(toAddress, `toAddress is required`);
  assert(privateKey instanceof Buffer, `privateKey must be a Buffer`);
  assert(typeof amount === 'number', `amount must be a number`);

  const { cblock, scriptTaproot, outputScript } = commitTxData;

  const tapLeafScript = {
    leafVersion: scriptTaproot.redeemVersion, // 192 0xc0
    script: outputScript,
    controlBlock: Buffer.from(cblock, 'hex'),
  };

  const keypair = ECPair.fromPrivateKey(privateKey, { network });
  const psbt = new bitcoinjsLib.Psbt({ network });
  psbt.addInput({
    hash: commitTxResult.txId,
    index: commitTxResult.sendUtxoIndex,
    witnessUtxo: { value: commitTxResult.sendAmount, script: scriptTaproot.output },
    tapLeafScript: [tapLeafScript],
  });

  psbt.addOutput({
    value: amount, // generally 1000 for nfts, 549 for brc20
    address: toAddress,
  });

  await psbt.signInput(0, keypair);

  const signature = psbt.data.inputs[0].tapScriptSig[0].signature.toString('hex');

  // We have to construct our witness script in a custom finalizer

  const customFinalizer = (_inputIndex, input) => {
    const witness = [input.tapScriptSig[0].signature]
      .concat(outputScript)
      .concat(tapLeafScript.controlBlock);

    return {
      finalScriptWitness: witnessStackToScriptWitness(witness),
    };
  };

  psbt.finalizeInput(0, customFinalizer);

  const tx = psbt.extractTransaction();

  const rawTx = tx.toBuffer().toString('hex');
  const txId = tx.getId();

  const virtualSize = tx.virtualSize();

  return {
    txId,
    rawTx,
    inscriptionId: `${txId}i0`,
    virtualSize,
    signature,
  };
};

const testScript = async () => {
  const secret = 'fc7458de3d5616e7803fdc81d688b9642641be32fee74c4558ce680cac3d4111';
  const privateKey = Buffer.from(secret, 'hex');
  const keypair = ECPair.fromPrivateKey(privateKey, { network });
  console.log('fsf', keypair.privateKey.toString('hex'));
  const { publicKey } = keypair;
  const inscription = createTextInscription({ text: 'Hello!!' });
  const commitTxData = createCommitTxData({
    publicKey,
    inscription,
  });

  const padding = 549;
  const txSize = 600 + Math.floor(inscription.content.length / 4);
  const feeRate = 2;
  const minersFee = txSize * feeRate;

  const requiredAmount = 550 + minersFee + padding;

  const commitTxResult = {
    txId: 'd2e8358a8f6257ed6fc5eabe4e85951b702918a7a5d5b79a45e535e1d5d65fb2',
    sendUtxoIndex: 1,
    sendAmount: requiredAmount,
  };

  console.log('commmit Tx', commitTxData);

  const ownerAddress = 'tb1p54k30k88cuewxusuyxca7wsxg0qwgfswldfy6qdmpn8plax2qanqjxas2p';

  const revealRawTx = await createRevealTx({
    commitTxData,
    commitTxResult,
    toAddress: ownerAddress,
    privateKey: keypair.privateKey,
    amount: padding,
  });

  console.log('Reveal Tx', revealRawTx);
};

testScript();
