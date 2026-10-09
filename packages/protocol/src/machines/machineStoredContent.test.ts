import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '../crypto/base64.js';
import tweetnacl from 'tweetnacl';
import { deriveAccountMachineKeyFromRecoverySecret } from '../crypto/accountScopedCipher.js';
import { createMachineDataEncryptionKeyV1, isMachineDataEncryptionKeyTransferableV1 } from './machineStoredContent.js';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import { decodeBase64 } from '../crypto/base64.js';
import {
  computeRunnerMachineContentKeyFingerprintV1,
  sealRunnerMachineContentKeyVerifierFactV1,
  signRunnerMachineContentKeyBindingV1,
} from '../ephemeralRunner/machineContentKeyBinding.js';
import { signRunnerClaimV1 } from '../ephemeralRunner/endpoint.js';
import { signMachineInstallationProof } from './identity/installationIdentity.js';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  decodePlainMachineStoredContent,
  encodePlainMachineStoredContent,
  isPlainMachineDataKeyMarker,
  machineStoredContentMatchesAccountMode,
  machineUpdateMatchesStoredMode,
  resolvePublishedMachineDataEncryptionKeyV1,
} from './machineStoredContent.js';

function encodeJson(value: unknown): string {
  return encodeBase64(
    new TextEncoder().encode(JSON.stringify(value)),
    'base64',
  );
}

describe('machineStoredContent', () => {
  it('distinguishes standalone owner material from both historical Account key forms', () => {
    const secret = new Uint8Array(32).fill(17);
    const standalone = new Uint8Array(32).fill(19);
    const legacy = { type: 'legacy' as const, secret };
    const dataKey = { type: 'dataKey' as const, machineKey: secret };
    const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: standalone,
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(secret).publicKey, randomBytes: tweetnacl.randomBytes }));
    const predicate = (openedDataEncryptionKey: Uint8Array | null, accountScopedMaterial: typeof legacy | typeof dataKey, publishedDataEncryptionKey: string | null = envelope) =>
      isMachineDataEncryptionKeyTransferableV1({ openedDataEncryptionKey, accountScopedMaterial, publishedDataEncryptionKey });
    expect(predicate(secret, legacy)).toBe(false);
    expect(predicate(deriveAccountMachineKeyFromRecoverySecret(secret), legacy)).toBe(false);
    expect(predicate(secret, dataKey)).toBe(false);
    expect(predicate(standalone, legacy)).toBe(true);
    expect(predicate(standalone, dataKey)).toBe(true);
    expect(predicate(standalone, legacy, null)).toBe(false);
    expect(predicate(null, legacy)).toBe(false);
    const produced = createMachineDataEncryptionKeyV1({ material: dataKey,
      dataKeyPublicKey: tweetnacl.box.keyPair.fromSecretKey(secret).publicKey, randomBytes: tweetnacl.randomBytes });
    const opened = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(encodeBase64(produced.dataEncryptionKey)), recipientSecretKeyOrSeed: secret });
    expect(opened).toEqual(produced.encryptionKey);
    expect(predicate(opened, dataKey, encodeBase64(produced.dataEncryptionKey))).toBe(true);
  });
  it('selects authenticated resource mode and refuses foreign legacy or unready access', () => {
    const dataKey = new Uint8Array(32).fill(9);
    const access = { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'use', resourceMode: 'e2ee', accessState: 'ready' };
    const resolve = (overrides: Record<string, unknown> = {}) => resolvePublishedMachineDataEncryptionKeyV1({
      machine: { id: 'machine', access, dataEncryptionKey: 'sealed', ...overrides },
      viewerAccountId: 'viewer', expectedAccountMode: 'plain', openedDataEncryptionKey: dataKey,
    });
    expect(resolve()).toEqual({ status: 'e2ee', dataKey });
    expect(resolve({ dataEncryptionKey: null })).toEqual({ status: 'unavailable' });
    expect(resolve({ access: { ...access, accessState: 'key_pending' } })).toEqual({ status: 'unavailable' });
    expect(resolve({ access: { ...access, resourceMode: 'plain' }, dataEncryptionKey: null })).toEqual({ status: 'plain' });
    expect(resolve({ access: { ...access, resourceMode: 'invalid' } })).toEqual({ status: 'unavailable' });
    expect(resolve({ access: null, dataEncryptionKey: null })).toEqual({ status: 'unavailable' });
    expect(resolvePublishedMachineDataEncryptionKeyV1({ machine: { id: 'owned', dataEncryptionKey: null },
      openedDataEncryptionKey: null, expectedAccountMode: 'plain' })).toEqual({ status: 'plain' });
    expect(resolvePublishedMachineDataEncryptionKeyV1({ machine: { id: 'owned', dataEncryptionKey: 'sealed' },
      openedDataEncryptionKey: dataKey, expectedAccountMode: 'plain' })).toEqual({ status: 'unavailable' });
  });
  it('preserves the existing plain marker and round-trips strict plain content', () => {
    const value = { host: 'machine-a', nested: { ready: true } };

    expect(MACHINE_PLAIN_DATA_KEY_MARKER).toBe(
      encodeJson({ t: 'plain', v: null }),
    );
    expect(isPlainMachineDataKeyMarker(MACHINE_PLAIN_DATA_KEY_MARKER)).toBe(true);
    expect(isPlainMachineDataKeyMarker(
      new TextEncoder().encode(JSON.stringify({ t: 'plain', v: null })),
    )).toBe(true);
    expect(decodePlainMachineStoredContent(
      encodePlainMachineStoredContent(value),
    )).toEqual(value);
  });

  it('normalizes optional undefined object fields to their JSON wire representation', () => {
    const encoded = encodePlainMachineStoredContent({
      status: 'running',
      serviceLabel: undefined,
      nested: {
        present: true,
        absent: undefined,
      },
    });

    expect(decodePlainMachineStoredContent(encoded)).toEqual({
      status: 'running',
      nested: {
        present: true,
      },
    });
  });

  it('reads additive stored envelope fields and writes back only canonical content', () => {
    const value = { host: 'machine-a', nested: { ready: true } };
    const stored = encodeJson({ t: 'plain', v: value, future: { authority: 'ignored' } });
    const opened = decodePlainMachineStoredContent(stored);
    expect(opened).toEqual(value);
    expect(encodePlainMachineStoredContent(opened)).toBe(encodeJson({ t: 'plain', v: value }));
    expect(isPlainMachineDataKeyMarker(encodeJson({ t: 'plain', v: null, extra: true }))).toBe(true);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'e2ee', metadata: stored, dataEncryptionKey: 'wrapped-key',
    })).toBe(false);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'plain', metadata: stored, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toBe(false);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'plain', metadata: stored, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, storedRead: true,
    })).toBe(true);
  });

  it('rejects malformed and non-plain Machine envelopes', () => {
    const invalidValues = [
      'not-base64',
      encodeJson({ t: 'encrypted', c: 'ciphertext' }),
      encodeJson({ t: 'plain' }),
    ];

    for (const value of invalidValues) {
      expect(() => decodePlainMachineStoredContent(value)).toThrow(
        'Invalid plaintext machine content',
      );
    }
    expect(isPlainMachineDataKeyMarker(encodeJson({ t: 'plain', v: 'not-null' }))).toBe(false);
    expect(() => encodePlainMachineStoredContent(undefined)).toThrow(
      'Invalid plaintext machine content',
    );
  });

  it('enforces account-mode/content agreement without classifying encrypted bytes', () => {
    const plainMetadata = encodePlainMachineStoredContent({ host: 'machine-a' });
    const encryptedEnvelope = encodeJson({ t: 'encrypted', c: 'ciphertext' });

    expect(machineStoredContentMatchesAccountMode({
      mode: 'plain',
      metadata: plainMetadata,
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toBe(true);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'plain',
      metadata: 'opaque-ciphertext',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toBe(false);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'plain',
      metadata: encryptedEnvelope,
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toBe(false);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'e2ee',
      metadata: 'opaque-ciphertext',
      dataEncryptionKey: 'opaque-wrapped-key',
    })).toBe(true);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'e2ee',
      metadata: plainMetadata,
      dataEncryptionKey: 'opaque-wrapped-key',
    })).toBe(false);
    expect(machineStoredContentMatchesAccountMode({
      mode: 'e2ee',
      metadata: 'opaque-ciphertext',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    })).toBe(false);
  });

  it('uses the persisted Machine marker as update authority, including database bytes', () => {
    const plainMarkerBytes = new TextEncoder().encode(
      JSON.stringify({ t: 'plain', v: null }),
    );
    const plainState = encodePlainMachineStoredContent({ status: 'running' });

    expect(machineUpdateMatchesStoredMode({
      dataEncryptionKey: plainMarkerBytes,
      daemonState: plainState,
    })).toBe(true);
    expect(machineUpdateMatchesStoredMode({
      dataEncryptionKey: plainMarkerBytes,
      daemonState: 'opaque-ciphertext',
    })).toBe(false);
    expect(machineUpdateMatchesStoredMode({
      dataEncryptionKey: new Uint8Array([1, 2, 3]),
      daemonState: 'opaque-ciphertext',
    })).toBe(true);
    expect(machineUpdateMatchesStoredMode({
      dataEncryptionKey: new Uint8Array([1, 2, 3]),
      daemonState: plainState,
    })).toBe(false);
  });

  it('accepts a Runner key only with the creator-authenticated exact Machine tuple', () => {
    const accountSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const dataKey = new Uint8Array(32).fill(11);
    const payload = {
      v: 1 as const,
      purpose: 'happier.ephemeral-runner.machine-content-key' as const,
      homeServerIdentityId: 'home-one',
      activationId: '11111111-1111-4111-8111-111111111111',
      creatorAccountId: 'account-one',
      machineId: 'machine-one',
      installationId: 'installation-one',
      machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(dataKey),
    };
    const binding = signRunnerMachineContentKeyBindingV1({
      payload,
      activationSigningSecretKey: accountSigning.secretKey,
    });
    const projection = {
      id: 'machine-one',
      kind: 'ephemeral_session_runner',
      installationId: 'installation-one',
      dataEncryptionKey: 'wrapped-runner-key',
      runnerContentKeyBinding: binding,
    };

    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: projection,
      openedDataEncryptionKey: dataKey,
      expectedRunnerBinding: {
        homeServerIdentityId: payload.homeServerIdentityId,
        creatorAccountId: payload.creatorAccountId,
        machineId: payload.machineId,
        accountSigningPublicKeyBase64Url: encodeBase64(accountSigning.publicKey, 'base64url'),
      },
    })).toEqual({ status: 'e2ee', dataKey });

    for (const machine of [
      { ...projection, installationId: 'installation-two' },
      { ...projection, runnerContentKeyBinding: null },
      { ...projection, dataEncryptionKey: null },
    ]) {
      expect(resolvePublishedMachineDataEncryptionKeyV1({
        machine,
        openedDataEncryptionKey: dataKey,
        expectedRunnerBinding: {
          homeServerIdentityId: payload.homeServerIdentityId,
          creatorAccountId: payload.creatorAccountId,
          machineId: payload.machineId,
          accountSigningPublicKeyBase64Url: encodeBase64(accountSigning.publicKey, 'base64url'),
        },
      })).toEqual({ status: 'unavailable' });
    }

    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: projection,
      openedDataEncryptionKey: new Uint8Array(32).fill(12),
      expectedRunnerBinding: {
        homeServerIdentityId: payload.homeServerIdentityId,
        creatorAccountId: payload.creatorAccountId,
        machineId: payload.machineId,
        accountSigningPublicKeyBase64Url: encodeBase64(accountSigning.publicKey, 'base64url'),
      },
    })).toEqual({ status: 'unavailable' });

    for (const key of [
      'homeServerIdentityId',
      'activationId',
      'creatorAccountId',
      'machineId',
      'installationId',
      'machineContentKeyFingerprint',
    ] as const) {
      expect(resolvePublishedMachineDataEncryptionKeyV1({
        machine: {
          ...projection,
          runnerContentKeyBinding: {
            ...binding,
            [key]: `${binding[key]}-substituted`,
          },
        },
        openedDataEncryptionKey: dataKey,
        expectedRunnerBinding: {
          homeServerIdentityId: payload.homeServerIdentityId,
          creatorAccountId: payload.creatorAccountId,
          machineId: payload.machineId,
          accountSigningPublicKeyBase64Url: encodeBase64(accountSigning.publicKey, 'base64url'),
        },
      })).toEqual({ status: 'unavailable' });
    }

    // A reader without creator device custody supplies Account material instead,
    // and the verifier comes from the creator-sealed fact — never a Home field.
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(21) };
    const scope = {
      homeServerIdentityId: payload.homeServerIdentityId,
      creatorAccountId: payload.creatorAccountId,
      machineId: payload.machineId,
    };
    const carried = {
      ...binding,
      creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
        payload: {
          v: 1,
          activationId: payload.activationId,
          machineId: payload.machineId,
          activationSigningPublicKey: encodeBase64(accountSigning.publicKey, 'base64url'),
        },
        material,
        randomBytes: (length: number) => new Uint8Array(length).fill(3),
      }),
    };
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: { ...projection, runnerContentKeyBinding: carried },
      openedDataEncryptionKey: dataKey,
      expectedRunnerBinding: { ...scope, accountScopedMaterial: material },
    })).toEqual({ status: 'e2ee', dataKey });
    // No fact, another Account's material, and no trust input at all all fail closed.
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: projection,
      openedDataEncryptionKey: dataKey,
      expectedRunnerBinding: { ...scope, accountScopedMaterial: material },
    })).toEqual({ status: 'unavailable' });
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: { ...projection, runnerContentKeyBinding: carried },
      openedDataEncryptionKey: dataKey,
      expectedRunnerBinding: {
        ...scope,
        accountScopedMaterial: { type: 'dataKey', machineKey: new Uint8Array(32).fill(22) },
      },
    })).toEqual({ status: 'unavailable' });
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: { ...projection, runnerContentKeyBinding: carried },
      openedDataEncryptionKey: dataKey,
      expectedRunnerBinding: scope,
    })).toEqual({ status: 'unavailable' });

    for (const key of ['homeServerIdentityId', 'creatorAccountId', 'machineId'] as const) {
      expect(resolvePublishedMachineDataEncryptionKeyV1({
        machine: projection,
        openedDataEncryptionKey: dataKey,
        expectedRunnerBinding: {
          homeServerIdentityId: key === 'homeServerIdentityId'
            ? `${payload.homeServerIdentityId}-substituted`
            : payload.homeServerIdentityId,
          creatorAccountId: key === 'creatorAccountId'
            ? `${payload.creatorAccountId}-substituted`
            : payload.creatorAccountId,
          machineId: key === 'machineId'
            ? `${payload.machineId}-substituted`
            : payload.machineId,
          accountSigningPublicKeyBase64Url: encodeBase64(accountSigning.publicKey, 'base64url'),
        },
      })).toEqual({ status: 'unavailable' });
    }

    const substitutedSigner = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: projection,
      openedDataEncryptionKey: dataKey,
      expectedRunnerBinding: {
        homeServerIdentityId: payload.homeServerIdentityId,
        creatorAccountId: payload.creatorAccountId,
        machineId: payload.machineId,
        accountSigningPublicKeyBase64Url: encodeBase64(substitutedSigner.publicKey, 'base64url'),
      },
    })).toEqual({ status: 'unavailable' });
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: projection,
      openedDataEncryptionKey: dataKey,
    })).toEqual({ status: 'unavailable' });
  });

  it('keeps Plain Runner keylessness and released ordinary Machine fallback distinct', () => {
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'runner-plain',
        kind: 'ephemeral_session_runner',
        installationId: 'installation-one',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        runnerContentKeyBinding: null,
      },
      openedDataEncryptionKey: null,
      expectedAccountMode: 'plain',
    })).toEqual({ status: 'plain' });
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'runner-plain',
        kind: 'ephemeral_session_runner',
        installationId: 'installation-one',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        runnerContentKeyBinding: null,
      },
      openedDataEncryptionKey: null,
      expectedAccountMode: 'e2ee',
    })).toEqual({ status: 'unavailable' });
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'runner-plain',
        kind: 'ephemeral_session_runner',
        installationId: 'installation-one',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        runnerContentKeyBinding: null,
      },
      openedDataEncryptionKey: null,
    })).toEqual({ status: 'unavailable' });
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'runner-broken',
        kind: 'ephemeral_session_runner',
        installationId: 'installation-one',
        dataEncryptionKey: null,
        runnerContentKeyBinding: null,
      },
      openedDataEncryptionKey: null,
    })).toEqual({ status: 'unavailable' });
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'ordinary-legacy',
        kind: 'persistent',
        dataEncryptionKey: null,
      },
      openedDataEncryptionKey: null,
    })).toEqual({ status: 'legacy' });
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'ordinary-substituted-plain',
        kind: 'persistent',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      },
      openedDataEncryptionKey: null,
      expectedAccountMode: 'e2ee',
    })).toEqual({ status: 'unavailable' });
  });

  it('never lets the Home-published kind choose the branch for a Machine the reader trusts as a Runner', () => {
    const substituted = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const homeKnownKey = new Uint8Array(32).fill(41);
    const accountMode = 'e2ee' as const;

    // A hostile Home relabels a known Runner, drops the binding and publishes an
    // envelope it sealed to the Account content public key it holds.
    for (const kind of ['persistent', undefined] as const) {
      expect(resolvePublishedMachineDataEncryptionKeyV1({
        machine: {
          id: 'machine-one',
          ...(kind === undefined ? {} : { kind }),
          installationId: 'installation-one',
          dataEncryptionKey: 'home-substituted-envelope',
          runnerContentKeyBinding: null,
        },
        openedDataEncryptionKey: homeKnownKey,
        expectedAccountMode: accountMode,
        trustedMachineKind: 'ephemeral_session_runner',
        expectedRunnerBinding: {
          homeServerIdentityId: 'home-one',
          creatorAccountId: 'account-one',
          machineId: 'machine-one',
          accountSigningPublicKeyBase64Url: encodeBase64(substituted.publicKey, 'base64url'),
        },
      })).toEqual({ status: 'unavailable' });
    }

    // The binding the server writes only at Runner materialization is itself a
    // Runner classification, so the same relabelling with the binding still
    // present may not take the released persistent fallback either.
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'machine-one',
        kind: 'persistent',
        installationId: 'installation-one',
        dataEncryptionKey: 'home-substituted-envelope',
        runnerContentKeyBinding: { v: 1, tampered: true },
      },
      openedDataEncryptionKey: homeKnownKey,
      expectedAccountMode: accountMode,
    })).toEqual({ status: 'unavailable' });

    // A genuinely persistent Machine keeps both released behaviours.
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'machine-two',
        kind: 'persistent',
        dataEncryptionKey: 'ordinary-envelope',
      },
      openedDataEncryptionKey: homeKnownKey,
      expectedAccountMode: accountMode,
    })).toEqual({ status: 'e2ee', dataKey: homeKnownKey });
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: { id: 'machine-two', dataEncryptionKey: null },
      openedDataEncryptionKey: null,
      expectedAccountMode: accountMode,
    })).toEqual({ status: 'legacy' });
  });

  it('verifies a trusted Runner through the creator binding even when the Home relabels it persistent', () => {
    const accountSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const dataKey = new Uint8Array(32).fill(11);
    const payload = {
      v: 1 as const,
      purpose: 'happier.ephemeral-runner.machine-content-key' as const,
      homeServerIdentityId: 'home-one',
      activationId: '11111111-1111-4111-8111-111111111111',
      creatorAccountId: 'account-one',
      machineId: 'machine-one',
      installationId: 'installation-one',
      machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(dataKey),
    };
    const binding = signRunnerMachineContentKeyBindingV1({
      payload,
      activationSigningSecretKey: accountSigning.secretKey,
    });

    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'machine-one',
        kind: 'persistent',
        installationId: 'installation-one',
        dataEncryptionKey: 'wrapped-runner-key',
        runnerContentKeyBinding: binding,
      },
      openedDataEncryptionKey: dataKey,
      trustedMachineKind: 'ephemeral_session_runner',
      expectedRunnerBinding: {
        homeServerIdentityId: payload.homeServerIdentityId,
        creatorAccountId: payload.creatorAccountId,
        machineId: payload.machineId,
        accountSigningPublicKeyBase64Url: encodeBase64(accountSigning.publicKey, 'base64url'),
      },
    })).toEqual({ status: 'e2ee', dataKey });

    // The same relabelled row with a key the binding does not fingerprint must
    // fail closed: the persistent branch would have accepted it unexamined.
    expect(resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'machine-one',
        kind: 'persistent',
        installationId: 'installation-one',
        dataEncryptionKey: 'wrapped-runner-key',
        runnerContentKeyBinding: binding,
      },
      openedDataEncryptionKey: new Uint8Array(32).fill(12),
      trustedMachineKind: 'ephemeral_session_runner',
      expectedRunnerBinding: {
        homeServerIdentityId: payload.homeServerIdentityId,
        creatorAccountId: payload.creatorAccountId,
        machineId: payload.machineId,
        accountSigningPublicKeyBase64Url: encodeBase64(accountSigning.publicKey, 'base64url'),
      },
    })).toEqual({ status: 'unavailable' });
  });

  it('binds a Session-selected Runner only through its activation-signed claim for that exact Session', () => {
    const activationSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const installationSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
    const dataKey = new Uint8Array(32).fill(11);
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(21) };
    const activationId = '11111111-1111-4111-8111-111111111111';
    const signingPublicKey = encodeBase64(activationSigning.publicKey, 'base64url');
    // Every published fact below is exactly what a genuine Runner B carries;
    // the Home only chooses which Session it says B was activated for.
    function claimFor(overrides: Readonly<{ sessionId?: string; machineId?: string; signer?: Uint8Array }> = {}) {
      const machineId = overrides.machineId ?? 'machine-one';
      return signRunnerClaimV1({
        activationSecretKey: overrides.signer ?? activationSigning.secretKey,
        payload: {
          v: 1,
          purpose: 'happier.ephemeral-session-runner.claim',
          binding: {
            activationId,
            homeServerIdentityId: 'srv_home_one',
            creatorAccountId: 'account-one',
            creatorTokenEpoch: 0,
            activationExpiresAt: null,
            workspace: { kind: 'choose_on_endpoint' },
            sessionId: overrides.sessionId ?? 'session-b',
            machineId,
            activationSigningPublicKey: signingPublicKey,
            authoringCommitment: encodeBase64(new Uint8Array(32).fill(4), 'base64url'),
            artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
            endpointFactsRecipient: { mode: 'plain', creatorAccountId: 'account-one' },
          },
          runnerBoxPublicKey: encodeBase64(tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)).publicKey, 'base64url'),
          installation: {
            installationId: 'installation-one',
            publicKey: encodeBase64(installationSigning.publicKey, 'base64url'),
            proof: signMachineInstallationProof({
              payload: { version: 1, installationId: 'installation-one', machineId, accountId: 'account-one' },
              privateKey: installationSigning.secretKey,
            }),
          },
          protocolEpoch: 1,
        },
      });
    }
    const binding = {
      ...signRunnerMachineContentKeyBindingV1({
        payload: {
          v: 1,
          purpose: 'happier.ephemeral-runner.machine-content-key',
          homeServerIdentityId: 'srv_home_one',
          activationId,
          creatorAccountId: 'account-one',
          machineId: 'machine-one',
          installationId: 'installation-one',
          machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(dataKey),
        },
        activationSigningSecretKey: activationSigning.secretKey,
      }),
      creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
        payload: { v: 1, activationId, machineId: 'machine-one', activationSigningPublicKey: signingPublicKey },
        material,
        randomBytes: (length: number) => new Uint8Array(length).fill(3),
      }),
    };
    const resolve = (runnerClaim: unknown, sessionId: string) => resolvePublishedMachineDataEncryptionKeyV1({
      machine: {
        id: 'machine-one',
        kind: 'ephemeral_session_runner',
        installationId: 'installation-one',
        dataEncryptionKey: 'wrapped-runner-key',
        runnerContentKeyBinding: binding,
        runnerClaim,
      },
      openedDataEncryptionKey: dataKey,
      expectedRunnerBinding: {
        homeServerIdentityId: 'srv_home_one',
        creatorAccountId: 'account-one',
        machineId: 'machine-one',
        accountScopedMaterial: material,
        sessionId,
      },
    });

    expect(resolve(claimFor(), 'session-b')).toEqual({ status: 'e2ee', dataKey });
    // An authentic Runner B key is not proof that B holds Session A.
    expect(resolve(claimFor(), 'session-a')).toEqual({ status: 'unavailable' });
    expect(resolve(null, 'session-b')).toEqual({ status: 'unavailable' });
    const genuine = claimFor();
    expect(resolve({
      ...genuine,
      payload: { ...genuine.payload, binding: { ...genuine.payload.binding, sessionId: 'session-a' } },
    }, 'session-a')).toEqual({ status: 'unavailable' });
    // A claim signed by another activation identity, or naming another Machine, is not B's.
    expect(resolve(claimFor({ signer: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).secretKey }), 'session-b'))
      .toEqual({ status: 'unavailable' });
    expect(resolve(claimFor({ machineId: 'machine-two' }), 'session-b')).toEqual({ status: 'unavailable' });
  });
});
