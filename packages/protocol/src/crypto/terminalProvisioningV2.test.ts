import { describe, expect, it } from 'vitest';

import tweetnacl from 'tweetnacl';

import {
  openTerminalProvisioningV3Response,
  sealTerminalProvisioningV3TokenOnlyPayload,
  isTerminalProvisioningV3Payload,
  openTerminalProvisioningV3Payload,
  openTerminalProvisioningV2Payload,
  sealTerminalProvisioningV3Payload,
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

    // Pinned from the pre-extension codec with this deterministic random stream.
    expect(Buffer.from(payload).toString('hex')).toBe('4850563307a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c2122232425262728292a2b2c2d2e2f303132333435363738038421ac68edc7135402995448e77117e81672a45e7c6cf4c2adccbbc9002707396eee6a007127b87017ea460009127322e1d42c22f204cd76284a35fc425cc84ccd5c295c34fde4f0e5316eab47e18ea8');

    expect(isTerminalProvisioningV3Payload(payload)).toBe(true);
    expect(
      openTerminalProvisioningV3Payload({
        payload,
        recipientSecretKeyOrSeed: terminalSecretKey,
        ...context,
        nowMs: 2_000,
      }),
    ).toEqual(contentPrivateKey);
  });

  it('authenticates explicit token-only responses and rejects tampering without treating them as keys', () => {
    const payload = sealTerminalProvisioningV3TokenOnlyPayload({
      ...context,
      randomBytes: deterministicRandomBytesFactory(),
    });
    const input = { payload, recipientSecretKeyOrSeed: terminalSecretKey, ...context, nowMs: 2_000 };
    expect(isTerminalProvisioningV3Payload(payload)).toBe(true);
    expect(openTerminalProvisioningV3Response(input)).toEqual({ type: 'tokenOnly' });
    expect(openTerminalProvisioningV3Payload(input)).toBeNull();
    const tampered = payload.slice();
    tampered[10] ^= 1;
    expect(openTerminalProvisioningV3Response({ ...input, payload: tampered })).toBeNull();
    expect(openTerminalProvisioningV3Response({ ...input, pairingSecret: new Uint8Array(32).fill(12) })).toBeNull();
    expect(openTerminalProvisioningV3Response({ ...input, nowMs: context.expiresAtMs + 1 })).toBeNull();
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
      expect(
        openTerminalProvisioningV3Payload({
          ...candidate,
          recipientSecretKeyOrSeed: terminalSecretKey,
          terminalEphemeralPublicKey: terminalPublicKey,
          createdAtMs: context.createdAtMs,
          expiresAtMs: context.expiresAtMs,
          nowMs: 2_000,
        }),
      ).toBeNull();
    }
  });

  it('rejects an expired authenticated response', () => {
    const payload = sealTerminalProvisioningV3Payload({
      contentPrivateKey: new Uint8Array(32).fill(7),
      ...context,
      randomBytes: deterministicRandomBytesFactory(),
    });
    expect(
      openTerminalProvisioningV3Payload({
        payload,
        recipientSecretKeyOrSeed: terminalSecretKey,
        ...context,
        nowMs: context.expiresAtMs + 1,
      }),
    ).toBeNull();
  });
});
