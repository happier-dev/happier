import { describe, expect, it } from 'vitest';

import tweetnacl from 'tweetnacl';

import {
  isTerminalProvisioningV3Payload,
  openTerminalProvisioningV2Response,
  openTerminalProvisioningV3Response,
  openTerminalProvisioningV3Payload,
  openTerminalProvisioningV2Payload,
  sealTerminalProvisioningV2TokenOnlyPayload,
  sealTerminalProvisioningV3TokenOnlyPayload,
  sealTerminalProvisioningV3Payload,
  sealTerminalProvisioningV2Payload,
  TERMINAL_PROVISIONING_V2_TOKEN_ONLY_TAG,
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

  it('seals and opens an exact token-only variant without account E2EE material', () => {
    const terminalSecretKey = new Uint8Array(32).fill(4);
    const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;

    const sealed = sealTerminalProvisioningV2TokenOnlyPayload({
      recipientPublicKey: terminalPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(openTerminalProvisioningV2Response({
      payload: sealed,
      recipientSecretKeyOrSeed: terminalSecretKey,
    })).toEqual({ type: 'tokenOnly' });
    expect(openTerminalProvisioningV2Payload({
      payload: sealed,
      recipientSecretKeyOrSeed: terminalSecretKey,
    })).toBeNull();
  });

  it('strictly rejects unknown and trailing token-only plaintext variants', () => {
    const terminalSecretKey = new Uint8Array(32).fill(6);
    const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
    const candidates = [
      new Uint8Array([TERMINAL_PROVISIONING_V2_TOKEN_ONLY_TAG + 1]),
      new Uint8Array([TERMINAL_PROVISIONING_V2_TOKEN_ONLY_TAG, 0]),
    ];

    for (const plaintext of candidates) {
      const sealed = sealBoxBundle({
        plaintext,
        recipientPublicKey: terminalPublicKey,
        randomBytes: deterministicRandomBytesFactory(),
      });
      expect(openTerminalProvisioningV2Response({
        payload: sealed,
        recipientSecretKeyOrSeed: terminalSecretKey,
      })).toBeNull();
    }
  });
});

describe('terminalProvisioningV3', () => {
  const terminalSecretKey = new Uint8Array(32).fill(9);
  const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
  const pairingSecret = new Uint8Array(32).fill(11);
  const context = {
    terminalEphemeralPublicKey: terminalPublicKey,
    pairingSecret,
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
  } as const;

  it('authenticates the sealed content key with the QR-only secret', () => {
    const contentPrivateKey = new Uint8Array(32).fill(7);
    const payload = sealTerminalProvisioningV3Payload({
      contentPrivateKey,
      ...context,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(isTerminalProvisioningV3Payload(payload)).toBe(true);
    expect(openTerminalProvisioningV3Payload({
      payload,
      recipientSecretKeyOrSeed: terminalSecretKey,
      ...context,
      nowMs: 2_000,
    })).toEqual(contentPrivateKey);
  });

  it('fails closed for tampering or a different QR secret', () => {
    const payload = sealTerminalProvisioningV3Payload({
      contentPrivateKey: new Uint8Array(32).fill(7),
      ...context,
      randomBytes: deterministicRandomBytesFactory(),
    });
    const tampered = payload.slice();
    tampered[10] ^= 1;

    for (const candidate of [
      { payload: tampered, pairingSecret },
      { payload, pairingSecret: new Uint8Array(32).fill(12) },
    ]) {
      expect(openTerminalProvisioningV3Payload({
        ...candidate,
        recipientSecretKeyOrSeed: terminalSecretKey,
        terminalEphemeralPublicKey: terminalPublicKey,
        createdAtMs: context.createdAtMs,
        expiresAtMs: context.expiresAtMs,
        nowMs: 2_000,
      })).toBeNull();
    }
  });

  it('rejects an expired authenticated response', () => {
    const payload = sealTerminalProvisioningV3Payload({
      contentPrivateKey: new Uint8Array(32).fill(7),
      ...context,
      randomBytes: deterministicRandomBytesFactory(),
    });
    expect(openTerminalProvisioningV3Payload({
      payload,
      recipientSecretKeyOrSeed: terminalSecretKey,
      ...context,
      nowMs: context.expiresAtMs + 1,
    })).toBeNull();
  });

  it('authenticates the exact token-only variant without carrying a key', () => {
    const payload = sealTerminalProvisioningV3TokenOnlyPayload({
      ...context,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(isTerminalProvisioningV3Payload(payload)).toBe(true);
    expect(openTerminalProvisioningV3Response({
      payload,
      recipientSecretKeyOrSeed: terminalSecretKey,
      ...context,
      nowMs: 2_000,
    })).toEqual({ type: 'tokenOnly' });
    expect(openTerminalProvisioningV3Payload({
      payload,
      recipientSecretKeyOrSeed: terminalSecretKey,
      ...context,
      nowMs: 2_000,
    })).toBeNull();
  });

  it('rejects a v3 envelope whose sealed inner response has an unsupported length', () => {
    const tokenOnlyPayload = sealTerminalProvisioningV3TokenOnlyPayload({
      ...context,
      randomBytes: deterministicRandomBytesFactory(),
    });
    const malformed = new Uint8Array(tokenOnlyPayload.length + 1);
    malformed.set(tokenOnlyPayload);

    expect(isTerminalProvisioningV3Payload(malformed)).toBe(false);
    expect(openTerminalProvisioningV3Response({
      payload: malformed,
      recipientSecretKeyOrSeed: terminalSecretKey,
      ...context,
      nowMs: 2_000,
    })).toBeNull();
  });
});
