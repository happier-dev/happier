import { describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, QualifiedConnectedAccountCredentialSnapshotV4Schema, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { resolveConnectedServiceCredentialResolutions, ConnectedServiceCredentialResolutionError } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';

import axios from '@/api/client/credentialAxios';
import { buildConnectedServiceCredentialSpawnErrorResult } from './diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';

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

  it.each(['native-import', 'device'])('projects admitted OAuth material independently of its %s acquisition mode', async authenticationModeId => {
    const qualified = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ...snapshot({ t: 'plain', v: { v: 1, values: {
        accessToken: 'imported-access', refreshToken: 'imported-refresh', idToken: 'imported-id',
        providerAccountId: 'imported-provider-account', expiresAtMs: '9000000',
      } } }), authenticationModeId,
    });
    const result = (await resolve(qualified)).get('openai-codex');
    expect(result).toMatchObject({ credentialRevision: revision, record: {
      serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: 9000000,
      oauth: { accessToken: 'imported-access', refreshToken: 'imported-refresh', idToken: 'imported-id',
        raw: { happierQualifiedConnectedAccountCredentialV1: { ref, authenticationModeId } } },
    } });
  });

  it('refuses an imported payload that cannot produce native OAuth credentials', async () => {
    const qualified = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ...snapshot({ t: 'plain', v: { v: 1, values: { unrelated: 'not-oauth' } } }), authenticationModeId: 'native-import',
    });
    await expect(resolve(qualified)).rejects.toThrow();
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

  it.each([
    [{ error: 'connect_credential_not_found' }, 'confirmed_missing'],
    [{ error: 'route_not_found' }, 'unknown'],
  ] as const)('carries typed V4 credential absence through the spawn diagnostic', async (data, kind) => {
    const http = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 404, data });
    try {
      const admission = resolveConnectedServiceCredentialResolutions({
        credentials: { token: 'fixture', encryption: null },
        api: { getAccountEncryptionMode: async () => 'plain' },
        bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
      });
      const error = await admission.catch((error: unknown) => error);
      expect(error).toMatchObject({ kind, serviceId: 'openai-codex', profileId: 'work' });
      const diagnostic = buildConnectedServiceCredentialSpawnErrorResult({ agentId: 'codex', error });
      expect(diagnostic).toMatchObject({
        errorDetail: { kind: 'launch_error', code: kind === 'confirmed_missing'
          ? 'connected_service_profile_missing'
          : 'connected_service_credential_resolution_unavailable' },
      });
    } finally {
      http.mockRestore();
    }
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
