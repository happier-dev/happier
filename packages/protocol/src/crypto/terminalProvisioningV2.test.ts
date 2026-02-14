import { describe, expect, it } from 'vitest';

import tweetnacl from 'tweetnacl';

import {
  openTerminalProvisioningV2Payload,
  sealTerminalProvisioningV2Payload,
  TERMINAL_PROVISIONING_V2_VERSION_BYTE,
} from './terminalProvisioningV2.js';
import { sealBoxBundle } from './boxBundle.js';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

describe('terminalProvisioningV2', () => {
  it('seals and opens a v2 terminal provisioning payload', () => {
    const contentPrivateKey = new Uint8Array(32).fill(7);
    const terminalSecretKey = new Uint8Array(32).fill(9);
    const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

    const sealed = sealTerminalProvisioningV2Payload({
      contentPrivateKey,
      recipientPublicKey: terminalPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openTerminalProvisioningV2Payload({
      payload: sealed,
      recipientSecretKeyOrSeed: terminalSecretKey,
    });

    expect(opened).not.toBeNull();
    expect(Array.from(opened!)).toEqual(Array.from(contentPrivateKey));
  });

  it('rejects payloads with the wrong version byte', () => {
    const contentPrivateKey = new Uint8Array(32).fill(3);
    const terminalSecretKey = new Uint8Array(32).fill(2);
    const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

    const badPlaintext = new Uint8Array(33);
    badPlaintext[0] = (TERMINAL_PROVISIONING_V2_VERSION_BYTE + 1) & 0xff;
    badPlaintext.set(contentPrivateKey, 1);
    const sealed = sealBoxBundle({
      plaintext: badPlaintext,
      recipientPublicKey: terminalPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openTerminalProvisioningV2Payload({
      payload: sealed,
      recipientSecretKeyOrSeed: terminalSecretKey,
    });

    expect(opened).toBeNull();
  });

  it('rejects payloads that open but are malformed', () => {
    const terminalSecretKey = new Uint8Array(32).fill(1);
    const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

    const malformedPlaintext = new Uint8Array([TERMINAL_PROVISIONING_V2_VERSION_BYTE, 1, 2, 3]); // too short
    const malformedSealed = sealBoxBundle({
      plaintext: malformedPlaintext,
      recipientPublicKey: terminalPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const malformedOpened = openTerminalProvisioningV2Payload({
      payload: malformedSealed,
      recipientSecretKeyOrSeed: terminalSecretKey,
    });
    expect(malformedOpened).toBeNull();
  });
});
