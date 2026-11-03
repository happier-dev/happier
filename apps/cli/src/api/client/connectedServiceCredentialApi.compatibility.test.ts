import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios');
vi.mock('./serverHttpBaseUrl', async (importOriginal) => ({
  ...await importOriginal<typeof import('./serverHttpBaseUrl')>(),
  resolveServerHttpBaseUrl: () => 'https://server.example',
}));
vi.mock('./serverEndpointFailureLog', () => ({
  logServerEndpointFailure: vi.fn(),
}));

import {
  AccountEncryptionCurrentnessUnavailableError,
  ConnectedServiceCredentialHttpClient,
} from './connectedServiceCredentialApi';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { acquireRequesterAccountEncryptionCurrentness } from './accountEncryptionCurrentnessObservation';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { projectAutomationAccountCurrentnessWitnessV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { readAccountEncryptionModeOnce } from './accountEncryptionMode';
import { projectAccountEncryptionIdentity } from '@happier-dev/sync-client';

describe('connected-service credential exact 0.2.1 response boundary', () => {
  beforeEach(() => {
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.delete).mockReset();
    vi.mocked(axios.isAxiosError).mockReset();
  });

  it('does not retain a settled mode TTL without an admitted Account socket lifetime', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ status: 200, data: { mode: 'plain', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 2 } });
    const api = new ConnectedServiceCredentialHttpClient({ token: 'unheld-token' });
    await expect(api.getAccountEncryptionMode()).resolves.toBe('plain');
    await expect(api.getAccountEncryptionMode()).resolves.toBe('e2ee');
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicit fresh-authority mode read fresh before a held socket publication', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    let current = { mode: 'plain' as 'plain' | 'e2ee', version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null };
    vi.mocked(axios.get).mockImplementation(async url => ({ status: 200,
      data: String(url).endsWith('/currentness') ? current : { mode: current.mode, updatedAt: current.updatedAt } }));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const holder = acquireRequesterAccountEncryptionCurrentness({ accountId: 'bob', token,
      serverBaseUrl: 'https://server.example' });
    try {
      await holder.read();
      const api = new ConnectedServiceCredentialHttpClient({ token });
      await expect(api.getAccountEncryptionMode()).resolves.toBe('plain');
      current = { ...current, mode: 'e2ee', version: 2, updatedAt: 2 };
      await expect(api.getAccountEncryptionMode({ refresh: true })).resolves.toBe('e2ee');
    } finally { await holder.dispose(); await channel.close(); }
  });

  it('keeps the explicit fresh-authority storage-mode boundary separate from a live identity fact', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    const current = { mode: 'plain' as const, version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: current });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const scope = { token, serverBaseUrl: 'https://server.example' };
    const holder = acquireRequesterAccountEncryptionCurrentness({ ...scope, accountId: 'bob' });
    try {
      await holder.read();
      const request = vi.fn(async () => ({ status: 200, data: { mode: 'e2ee', updatedAt: 2 } }));
      await expect(readAccountEncryptionModeOnce({ credentials: { token: scope.token }, scope, request, usage: 'fresh-authority' }))
        .resolves.toEqual({ kind: 'resolved', mode: 'e2ee' });
      expect(request).toHaveBeenCalledTimes(1);
    } finally { await holder.dispose(); await channel.close(); }
  });

  it('accepts the released no-revision response only as legacy_unfenced', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'ciphertext' },
        metadata: { kind: 'token' },
      },
    });

    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    await expect(api.getConnectedServiceCredentialSealed({
      serviceId: 'github',
      profileId: 'work',
    })).resolves.toEqual({
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
      sealed: { format: 'account_scoped_v1', ciphertext: 'ciphertext' },
      metadata: { kind: 'token' },
    });
  });

  it('reads Account encryption currentness strictly without caching it', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          mode: 'plain',
          version: 1,
          signingKeyFingerprint: null,
          contentKeyFingerprint: null,
          updatedAt: 10,
          recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          mode: 'e2ee',
          version: 2,
          signingKeyFingerprint: null,
          contentKeyFingerprint: 'content-fingerprint',
          updatedAt: 20,
          recipientEnvelopeReadiness: { status: 'available' },
        },
      });

    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    await expect(api.getAccountEncryptionCurrentness()).resolves.toMatchObject({
      mode: 'plain',
      version: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
    });
    await expect(api.getAccountEncryptionCurrentness()).resolves.toMatchObject({
      mode: 'e2ee',
      version: 2,
      recipientEnvelopeReadiness: { status: 'available' },
    });

    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      'https://server.example/v1/account/encryption/currentness',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer token',
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        },
        validateStatus: expect.any(Function),
      }),
    );
  });

  it('reads an exact claim witness freshly beside a shared encryption identity observation', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    const initial = { mode: 'plain' as const, version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null };
    let serverFact = initial;
    vi.mocked(axios.get).mockImplementation(async () => ({ status: 200, data: serverFact }));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const observation = acquireRequesterAccountEncryptionCurrentness({
      accountId: 'bob', token, serverBaseUrl: 'https://server.example',
    });
    const api = new ConnectedServiceCredentialHttpClient({ token });
    try {
      await expect(observation.read()).resolves.toEqual(projectAccountEncryptionIdentity(initial));
      // The claim response carries the newly advanced Account cursor before
      // its socket wake is necessarily delivered to the identity observation.
      serverFact = { ...initial, version: 2 };
      expect(projectAutomationAccountCurrentnessWitnessV1(await api.getAccountEncryptionCurrentness()))
        .toEqual({ mode: 'plain', version: 2, contentKeyFingerprint: null });
      vi.mocked(axios.get).mockRejectedValue(new Error('Home unavailable'));
      await expect(api.getAccountEncryptionCurrentness()).rejects.toBeInstanceOf(
        AccountEncryptionCurrentnessUnavailableError,
      );
      await expect(api.getAccountEncryptionMode()).resolves.toBe('plain');
      expect(observation.isCurrent(initial)).toBe(true);
    } finally {
      await observation.dispose();
      await channel.close();
    }
  });

  it('does not let an unregistered token borrow another authenticated holder\'s Account fact', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    const payload = Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url');
    const token = `header.${payload}.authenticated`;
    const forged = `header.${payload}.forged`;
    const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null };
    vi.mocked(axios.get).mockImplementation(async (_url, config) => (
      config?.headers?.Authorization === `Bearer ${token}`
        ? { status: 200, data: fact }
        : { status: 401, data: { error: 'unauthorized' } }
    ));
    const observation = acquireRequesterAccountEncryptionCurrentness({
      accountId: 'bob', token, serverBaseUrl: 'https://server.example',
    });
    try {
      await observation.read();
      await expect(new ConnectedServiceCredentialHttpClient({ token }).getAccountEncryptionMode()).resolves.toBe('plain');
      await expect(new ConnectedServiceCredentialHttpClient({ token: forged }).getAccountEncryptionMode()).resolves.toBe('unknown');
      expect(axios.get).toHaveBeenCalledWith('https://server.example/v1/account/encryption',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${forged}` }) }));
      expect(observation.isCurrent(fact)).toBe(true);
    } finally {
      await observation.dispose();
      await channel.close();
    }
  });

  it('borrows only for live authenticated credential holders while retaining their shared Account fact', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    const payload = Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url');
    const firstToken = `header.${payload}.first`;
    const secondToken = `header.${payload}.second`;
    const fact = { mode: 'plain' as const, version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: fact });
    const scope = { accountId: 'bob', serverBaseUrl: 'https://server.example' };
    const first = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: firstToken });
    const repeated = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: firstToken });
    const second = acquireRequesterAccountEncryptionCurrentness({ ...scope, token: secondToken });
    const firstApi = new ConnectedServiceCredentialHttpClient({ token: firstToken });
    const secondApi = new ConnectedServiceCredentialHttpClient({ token: secondToken });
    try {
      await first.read();
      // The retired credential is unavailable; the remaining holder can still
      // establish its own subscription fact after credential handover.
      vi.mocked(axios.get).mockImplementation(async (_url, config) =>
        config?.headers?.Authorization === `Bearer ${secondToken}`
          ? { status: 200, data: fact } : { status: 503, data: {} });
      await first.dispose();
      await expect(firstApi.getAccountEncryptionMode()).resolves.toBe('plain');
      await expect(secondApi.getAccountEncryptionMode()).resolves.toBe('plain');
      await repeated.dispose();
      await expect(firstApi.getAccountEncryptionMode()).resolves.toBe('unknown');
      await expect(secondApi.getAccountEncryptionMode()).resolves.toBe('plain');
      expect(second.isCurrent(fact)).toBe(true);
    } finally {
      await first.dispose();
      await repeated.dispose();
      await second.dispose();
      await channel.close();
    }
  });

  it('rejects malformed Account encryption currentness without inferring a mode', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: { mode: 'plain' },
    });

    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    await expect(api.getAccountEncryptionCurrentness()).rejects.toBeInstanceOf(
      AccountEncryptionCurrentnessUnavailableError,
    );
  });

  it('reports transport failure through the typed currentness boundary', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('network unavailable'));

    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    await expect(api.getAccountEncryptionCurrentness()).rejects.toBeInstanceOf(
      AccountEncryptionCurrentnessUnavailableError,
    );
  });

  it.each(['encryption_setup_required', 'encryption_inconsistent'] as const)(
    'retains strict 400 %s readiness as failure, never successful currentness',
    async (reason) => {
      vi.mocked(axios.get).mockResolvedValue({
        status: 400,
        data: { error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason } },
      });
      const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
      const error: unknown = await api.getAccountEncryptionCurrentness().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AccountEncryptionCurrentnessUnavailableError);
      expect(error).toMatchObject({
        code: 'account_encryption_currentness_unavailable',
        recipientEnvelopeReadiness: { status: 'unavailable', reason },
      });
      expect(error).not.toHaveProperty('mode');
      expect(error).not.toHaveProperty('version');
    },
  );

  it.each([
    [400, { error: 'migration-required', recipientEnvelopeReadiness: { status: 'available' } }],
    [400, { error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }],
    [400, { error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' }, mode: 'e2ee' }],
    [403, { error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' } }],
    [200, { error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' } }],
  ])('does not accept readiness from an invalid currentness error at HTTP %s', async (status, data) => {
    vi.mocked(axios.get).mockResolvedValue({ status, data });
    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    const error: unknown = await api.getAccountEncryptionCurrentness().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AccountEncryptionCurrentnessUnavailableError);
    expect(error).not.toHaveProperty('recipientEnvelopeReadiness', expect.anything());
  });

  it('does not infer E2EE from a malformed Account-mode response', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      data: { mode: 'unexpected' },
    });

    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');
  });

  it('does not infer E2EE from Axios 404 while resolving Account mode', async () => {
    const error = { response: { status: 404 } };
    vi.mocked(axios.get).mockRejectedValue(error);
    vi.mocked(axios.isAxiosError).mockImplementation(
      (candidate) => candidate === error,
    );

    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');
    expect(axios.get).toHaveBeenCalledWith(
      'https://server.example/v1/account/encryption',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });

  it.each([400, 500])(
    'does not infer E2EE from Axios status %i while resolving Account mode',
    async (status) => {
      const error = { response: { status } };
      vi.mocked(axios.get).mockRejectedValue(error);
      vi.mocked(axios.isAxiosError).mockImplementation(
        (candidate) => candidate === error,
      );

      const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
      await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');
    },
  );

  it('does not infer E2EE from an Account-mode transport failure', async () => {
    const error = { request: {}, message: 'network unavailable' };
    vi.mocked(axios.get).mockRejectedValue(error);
    vi.mocked(axios.isAxiosError).mockImplementation(
      (candidate) => candidate === error,
    );

    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    await expect(api.getAccountEncryptionMode()).resolves.toBe('unknown');
  });

  it.each([
    {
      storageMode: 'plain' as const,
      cleanupGroupReferences: true,
      expectedUrl:
        'https://server.example/v3/connect/github/profiles/work/credential'
        + '?cleanupGroupReferences=true'
        + '&expectedCredentialRevision=csr_0123456789ABCDEFGHJKMNPQRS',
    },
    {
      storageMode: 'e2ee' as const,
      cleanupGroupReferences: false,
      expectedUrl:
        'https://server.example/v2/connect/github/profiles/work/credential'
        + '?expectedCredentialRevision=csr_0123456789ABCDEFGHJKMNPQRS',
    },
  ])(
    'deletes a revisioned $storageMode credential through its guarded route',
    async ({
      storageMode,
      cleanupGroupReferences,
      expectedUrl,
    }) => {
      vi.mocked(axios.delete).mockResolvedValue({
        status: 200,
        data: { success: true },
      });

      const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
      await expect(api.deleteConnectedServiceCredentialRevisioned({
        storageMode,
        serviceId: 'github',
        profileId: 'work',
        expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        cleanupGroupReferences,
      })).resolves.toBeUndefined();

      expect(axios.delete).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer token',
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          },
        }),
      );
    },
  );

  it('preserves a revision conflict as a control conflict', async () => {
    vi.mocked(axios.isAxiosError).mockReturnValue(true);
    vi.mocked(axios.delete).mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'connect_credential_revision_conflict' },
      },
    });

    const api = new ConnectedServiceCredentialHttpClient({ token: 'token' });
    await expect(api.deleteConnectedServiceCredentialRevisioned({
      storageMode: 'plain',
      serviceId: 'github',
      profileId: 'work',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      cleanupGroupReferences: false,
    })).rejects.toMatchObject({
      code: 'connect_credential_revision_conflict',
      controlStatus: 'conflict',
    });
  });
});
