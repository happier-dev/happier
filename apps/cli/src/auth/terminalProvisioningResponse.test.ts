import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
  sealBoxBundle,
  sealTerminalProvisioningV2TokenOnlyPayload,
  sealTerminalProvisioningV3TokenOnlyPayload,
  sealTerminalProvisioningV3Payload,
  TERMINAL_PROVISIONING_V2_TOKEN_ONLY_TAG,
} from '@happier-dev/protocol';

import {
  createTerminalPairingAuthentication,
  openTerminalProvisioningResponse,
  readTerminalPairingRequirement,
} from './terminalProvisioningResponse';

function deterministicRandomBytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(length);
}

describe('openTerminalProvisioningResponse', () => {
  const terminalSecretKey = new Uint8Array(32).fill(9);
  const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
  const pairing = {
    secret: new Uint8Array(32).fill(11),
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
  } as const;

  it('creates one-hour QR authentication context from local randomness', () => {
    expect(createTerminalPairingAuthentication({
      nowMs: 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(13),
    })).toEqual({
      secret: new Uint8Array(32).fill(13),
      createdAtMs: 1_000,
      expiresAtMs: 3_601_000,
    });
  });

  it('reads the opt-in v3 requirement and rejects unknown values', () => {
    expect(readTerminalPairingRequirement({})).toBeNull();
    expect(readTerminalPairingRequirement({ HAPPIER_TERMINAL_PAIRING_REQUIRE: ' v3 ' })).toBe('v3');
    expect(() => readTerminalPairingRequirement({
      HAPPIER_TERMINAL_PAIRING_REQUIRE: 'future',
    })).toThrow('HAPPIER_TERMINAL_PAIRING_REQUIRE');
  });

  it('authenticates v3 responses before returning a data key', () => {
    const machineKey = new Uint8Array(32).fill(7);
    const payload = sealTerminalProvisioningV3Payload({
      contentPrivateKey: machineKey,
      terminalEphemeralPublicKey: terminalPublicKey,
      pairingSecret: pairing.secret,
      createdAtMs: pairing.createdAtMs,
      expiresAtMs: pairing.expiresAtMs,
      randomBytes: deterministicRandomBytes,
    });

    expect(openTerminalProvisioningResponse({
      payload,
      terminalSecretKey,
      terminalPublicKey,
      pairing,
      requirement: null,
      nowMs: 2_000,
    })).toEqual({ type: 'dataKey', key: machineKey, authenticated: true });
  });

  it('fails closed for a v3-shaped response when pairing context is missing or wrong', () => {
    const payload = sealTerminalProvisioningV3Payload({
      contentPrivateKey: new Uint8Array(32).fill(7),
      terminalEphemeralPublicKey: terminalPublicKey,
      pairingSecret: pairing.secret,
      createdAtMs: pairing.createdAtMs,
      expiresAtMs: pairing.expiresAtMs,
      randomBytes: deterministicRandomBytes,
    });

    expect(openTerminalProvisioningResponse({
      payload,
      terminalSecretKey,
      terminalPublicKey,
      pairing: null,
      requirement: null,
      nowMs: 2_000,
    })).toBeNull();
    expect(openTerminalProvisioningResponse({
      payload,
      terminalSecretKey,
      terminalPublicKey,
      pairing: { ...pairing, secret: new Uint8Array(32).fill(12) },
      requirement: null,
      nowMs: 2_000,
    })).toBeNull();
  });

  it('continues to accept legacy v2 and v1 responses during the expansion window', () => {
    const v2Plaintext = new Uint8Array(33);
    v2Plaintext[0] = 0;
    v2Plaintext.set(new Uint8Array(32).fill(7), 1);
    const v2Payload = sealBoxBundle({
      plaintext: v2Plaintext,
      recipientPublicKey: terminalPublicKey,
      randomBytes: deterministicRandomBytes,
    });
    const v1Payload = sealBoxBundle({
      plaintext: new Uint8Array(32).fill(5),
      recipientPublicKey: terminalPublicKey,
      randomBytes: deterministicRandomBytes,
    });

    expect(openTerminalProvisioningResponse({
      payload: v2Payload,
      terminalSecretKey,
      terminalPublicKey,
      pairing,
      requirement: null,
      nowMs: 2_000,
    })).toEqual({ type: 'dataKey', key: new Uint8Array(32).fill(7), authenticated: false });
    expect(openTerminalProvisioningResponse({
      payload: v1Payload,
      terminalSecretKey,
      terminalPublicKey,
      pairing,
      requirement: null,
      nowMs: 2_000,
    })).toEqual({ type: 'legacy', key: new Uint8Array(32).fill(5), authenticated: false });
  });

  it('rejects legacy responses when authenticated v3 pairing is required', () => {
    const legacyPayload = sealBoxBundle({
      plaintext: new Uint8Array(32).fill(5),
      recipientPublicKey: terminalPublicKey,
      randomBytes: deterministicRandomBytes,
    });

    expect(openTerminalProvisioningResponse({
      payload: legacyPayload,
      terminalSecretKey,
      terminalPublicKey,
      pairing,
      nowMs: 2_000,
      requirement: 'v3',
    })).toBeNull();
  });

  it('returns an authenticated token-only result without account E2EE material', () => {
    const payload = sealTerminalProvisioningV3TokenOnlyPayload({
      terminalEphemeralPublicKey: terminalPublicKey,
      pairingSecret: pairing.secret,
      createdAtMs: pairing.createdAtMs,
      expiresAtMs: pairing.expiresAtMs,
      randomBytes: deterministicRandomBytes,
    });

    expect(openTerminalProvisioningResponse({
      payload,
      terminalSecretKey,
      terminalPublicKey,
      pairing,
      requirement: null,
      nowMs: 2_000,
      supportsTokenOnly: true,
    })).toEqual({ type: 'tokenOnly', authenticated: true });
  });

  it('rejects authenticated token-only when the reader capability was not activated', () => {
    const payload = sealTerminalProvisioningV3TokenOnlyPayload({
      terminalEphemeralPublicKey: terminalPublicKey,
      pairingSecret: pairing.secret,
      createdAtMs: pairing.createdAtMs,
      expiresAtMs: pairing.expiresAtMs,
      randomBytes: deterministicRandomBytes,
    });

    expect(openTerminalProvisioningResponse({
      payload,
      terminalSecretKey,
      terminalPublicKey,
      pairing,
      requirement: null,
      nowMs: 2_000,
      supportsTokenOnly: false,
    })).toBeNull();
  });

  it('rejects an unauthenticated token-only v2 response during fail-closed activation', () => {
    const payload = sealTerminalProvisioningV2TokenOnlyPayload({
      recipientPublicKey: terminalPublicKey,
      randomBytes: deterministicRandomBytes,
    });

    expect(openTerminalProvisioningResponse({
      payload,
      terminalSecretKey,
      terminalPublicKey,
      pairing,
      requirement: null,
      nowMs: 2_000,
    })).toBeNull();
  });

  it('strictly rejects unknown and trailing response variants', () => {
    for (const plaintext of [
      new Uint8Array([TERMINAL_PROVISIONING_V2_TOKEN_ONLY_TAG + 1]),
      new Uint8Array([TERMINAL_PROVISIONING_V2_TOKEN_ONLY_TAG, 0]),
    ]) {
      const payload = sealBoxBundle({
        plaintext,
        recipientPublicKey: terminalPublicKey,
        randomBytes: deterministicRandomBytes,
      });
      expect(openTerminalProvisioningResponse({
        payload,
        terminalSecretKey,
        terminalPublicKey,
        pairing,
        requirement: null,
        nowMs: 2_000,
      })).toBeNull();
    }
  });
});
