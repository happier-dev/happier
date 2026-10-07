import { describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, QualifiedConnectedAccountCredentialSnapshotV4Schema, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { resolveConnectedServiceCredentialResolutions, ConnectedServiceCredentialResolutionError } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';

const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
const record = buildConnectedServiceCredentialRecord({
  now: 1_000, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth',
  oauth: { accessToken: 'retained-access', refreshToken: 'retained-refresh', idToken: null, scope: null, tokenType: null, providerAccountId: 'retained-account', providerEmail: null },
});
const credentials = { token: 'fixture', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) } };

function resolve(snapshot: ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse> | null, mode: 'plain' | 'e2ee' = 'plain') {
  return resolveConnectedServiceCredentialResolutions({
    credentials: mode === 'plain' ? { token: 'fixture', encryption: null } : credentials,
    api: { getAccountEncryptionMode: async () => mode },
    bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    // HTTP response is the system boundary. Opening, retained record validation,
    // identity checks and native projection remain the real current owners.
    readCredential: async (input) => {
      expect(input.ref).toEqual(ref);
      return snapshot;
    },
  });
}

function snapshot(content: unknown, snapshotRef = ref) {
  return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
    ref: snapshotRef, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
    credentialRevision: revision, configurationRevision: null, content, metadata: { scopes: [] },
  });
}

describe('current qualified credential resolution of retained 0.2 data', () => {
  it('does not fabricate changed native material when rereading one qualified revision', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const retained = snapshot({ t: 'plain', v: record });
      const first = (await resolve(retained)).get('openai-codex');
      clock.mockReturnValue(2_000);
      const second = (await resolve(retained)).get('openai-codex');
      expect(second).toEqual(first);
    } finally {
      clock.mockRestore();
    }
  });
  it.each(['plain', 'e2ee'] as const)('opens a retained scalar payload through the qualified %s owner', async (mode) => {
    const content = mode === 'plain' ? { t: 'plain', v: record } : {
      t: 'encrypted',
      c: sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: credentials.encryption,
        payload: record,
        randomBytes: (length) => new Uint8Array(length).fill(1),
      }),
    };
    const result = (await resolve(snapshot(content), mode)).get('openai-codex');
    expect(result).toMatchObject({
      revisionSemantics: 'revisioned', credentialRevision: revision,
      record: { serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', oauth: { accessToken: 'retained-access', refreshToken: 'retained-refresh', providerAccountId: 'retained-account' } },
    });
  });

  it('rejects a retained payload whose profile assertion disagrees with the qualified row', async () => {
    await expect(resolve(snapshot({ t: 'plain', v: { ...record, profileId: 'other' } })))
      .rejects.toMatchObject({ code: 'connected_account_credential_legacy_assertion_mismatch' });
  });

  it('rejects a response for a different qualified account before native disclosure', async () => {
    await expect(resolve(snapshot({ t: 'plain', v: record }, { ...ref, accountId: 'other' })))
      .rejects.toThrow('does not match the exact qualified account');
  });

  it('preserves typed missing-credential identity', async () => {
    await expect(resolve(null)).rejects.toBeInstanceOf(ConnectedServiceCredentialResolutionError);
  });

  it('does not choose a scalar HTTP reader when account mode is unavailable', async () => {
    const readCredential = vi.fn(async () => null);
    await expect(resolveConnectedServiceCredentialResolutions({
      credentials: { token: 'fixture', encryption: null },
      api: { getAccountEncryptionMode: async () => 'unknown' as const },
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
      readCredential,
    })).rejects.toThrow('account mode is unavailable');
    expect(readCredential).not.toHaveBeenCalled();
  });
});
