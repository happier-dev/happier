import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openQualifiedConnectedAccountContentEnvelope,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { createAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from '@/plugins/testkit/admittedRuntime';

import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { requireConnectedAccountCryptoMaterial, resolveConnectedAccountCryptoMaterial } from '../accountScopedCryptoMaterial';
import { refreshQualifiedConnectedAccount } from './refreshQualifiedConnectedAccount';
import { revokeQualifiedConnectedAccount } from '../revokeQualifiedConnectedAccount';

// Genuine HTTP boundary: Node's runtime uses the package's Undici fetch.
vi.mock('undici', async importOriginal => {
  const runtime = await importOriginal<typeof import('undici')>();
  return { ...runtime, fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args) };
});

const service = Object.freeze({
  pluginId: 'happier.agent.codex',
  localId: 'openai-codex',
});
const account = Object.freeze({ service, accountId: 'account-1' });
const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
const nextCredentialRevision = 'csr_bcdefghijklmnopqrstuvw';
const createdDirectories: string[] = [];
const createdRegistries: Array<Readonly<{ dispose(): Promise<void> }>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(createdRegistries.splice(0).map(async (registry) => {
    await registry.dispose();
  }));
  await Promise.all(createdDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

async function createHarness(idToken = 'id-old', accountMode: 'plain' | 'e2ee' = 'plain', randomBytes?: (length: number) => Uint8Array, provider?: 'railway' | 'digitalocean') {
  const activeAccount = provider
    ? { service: { pluginId: `happier.machine.${provider}`, localId: `${provider}-account` }, accountId: account.accountId }
    : account;
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-qualified-refresh-'));
  createdDirectories.push(happyHomeDir);
  const fixture = await createAdmittedPluginRuntimeFixture({
    happyHomeDir,
    runtimeOptions: { pluginIds: [activeAccount.service.pluginId] },
  });
  const { registry, controller: reloadController } = fixture;
  createdRegistries.push(fixture);
  let retireOnRelease = false;
  const credentials: StoredCredentials = {
    token: 'happier-token',
    encryption: accountMode === 'plain' ? null : {
      type: 'legacy',
      secret: new Uint8Array(32).fill(5),
    },
  };
  const contentMode = accountMode === 'plain' ? { accountMode: 'plain' as const } : {
    accountMode: 'e2ee' as const,
    material: requireConnectedAccountCryptoMaterial(credentials, resolveConnectedAccountCryptoMaterial(credentials)),
  };
  const credentialSnapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
    ref: activeAccount,
    authenticationModeId: 'oauth',
    revisionSemantics: 'revisioned' as const,
    credentialRevision,
    configurationRevision: null,
    content: sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      ...contentMode,
      payload: {
        v: 1,
        values: provider ? {
          token: 'access-old', refreshToken: 'refresh-old', expiresAtMs: '900',
          oauthClientId: 'fixture-client', subject: 'fixture-user', displayName: 'Fixture account',
          ...(provider === 'digitalocean' ? { teamId: 'fixture-team' } : {}),
        } : {
          accessToken: 'access-old',
          refreshToken: 'refresh-old',
          idToken,
          providerAccountId: 'account-1',
          expiresAtMs: '900',
        },
      },
      randomBytes: (length) => new Uint8Array(length),
    }),
    metadata: {
      providerIdentity: { accountId: 'account-1' },
      displayName: 'Account 1',
      scopes: ['openid'],
    },
  });
  const getAccountEncryptionMode = vi.fn(async () => accountMode);
  const mutateCredentialHealth = vi.fn(async () => ({
    success: true as const, credentialRevision, configurationRevision: null,
  }));
  const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
    reloadController: {
      async acquireRuntimeRegistry() {
        const lease = await reloadController.acquireRuntimeRegistry();
        return {
          ...lease,
          async release() {
            await lease.release();
            if (retireOnRelease) {
              retireOnRelease = false;
              await retireAdmittedPluginRuntimeRegistry({ controller: reloadController, registry, happyHomeDir });
            }
          },
        };
      },
      isRuntimeRegistryCurrent(candidate: typeof registry) {
        return reloadController.isRuntimeRegistryCurrent(candidate);
      },
    },
    credentials,
    getAccountEncryptionMode,
    mutateCredentialHealth,
    ...(randomBytes ? { randomBytes } : {}),
    readCredential: vi.fn(async () => credentialSnapshot),
    readConfiguration: vi.fn(async () => null),
    configuration: {
      read: vi.fn(async () => null),
      secrets: {
        admit: vi.fn(async () => undefined),
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    },
  });
  const acquireRefreshLease = vi.fn(async () => ({
    acquired: true,
    leaseUntil: Date.now() + 60_000,
    ownerId: 'machine-1:runtime-1',
    credentialRevision,
  }));
  const mutateCredential = vi.fn(async (_params: Readonly<{
    token: string;
    mutation: unknown;
    signal?: AbortSignal;
  }>): ReturnType<NonNullable<Parameters<typeof refreshQualifiedConnectedAccount>[0]['mutateCredential']>> => ({
    success: true as const,
    credentialRevision: nextCredentialRevision,
    configurationRevision: null,
  }));
  return {
    credentials,
    credentialSnapshot,
    owner,
    getAccountEncryptionMode,
    acquireRefreshLease,
    mutateCredential,
    mutateCredentialHealth,
    contentMode,
    retireAfterExchange() { retireOnRelease = true; },
    isRegistryCurrent() { return reloadController.isRuntimeRegistryCurrent(registry); },
    async retireRegistry() {
      await retireAdmittedPluginRuntimeRegistry({ controller: reloadController, registry, happyHomeDir });
    },
  };
}

describe('refreshQualifiedConnectedAccount', () => {
  it.each([
    { provider: 'railway', tokenUrl: 'https://backboard.railway.com/oauth/token', remoteStatus: 'remoteUnsupported' },
    { provider: 'digitalocean', tokenUrl: 'https://cloud.digitalocean.com/v1/oauth/token', remoteStatus: 'remoteRevoked' },
  ] as const)('settles $provider rotation and Disconnect with the admitted bundled runtime', async ({ provider, tokenUrl, remoteStatus }) => {
    const harness = await createHarness(undefined, undefined, undefined, provider);
    const ref = harness.credentialSnapshot.ref;
    const request = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === tokenUrl) {
        const fields = new URLSearchParams(await new Response(init?.body).text());
        expect(fields.get('refresh_token')).toBe('refresh-old');
        expect(fields.has('client_secret')).toBe(false);
        return Response.json({ token_type: 'Bearer', access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 });
      }
      expect(url).toBe('https://cloud.digitalocean.com/v1/oauth/revoke');
      return Response.json({});
    });
    vi.stubGlobal('fetch', request);
    await expect(refreshQualifiedConnectedAccount({
      account: ref, token: harness.credentials.token, ownerId: 'machine-1:runtime-1', leaseMs: 60_000,
      operationId: 'rotate-grant', expectedCredential: harness.credentialSnapshot, resolveV4Support: () => 'advertised',
      establishedRuntimeOwner: harness.owner, acquireRefreshLease: harness.acquireRefreshLease, mutateCredential: harness.mutateCredential,
    })).resolves.toMatchObject({ status: 'refreshed', credentialRevision: nextCredentialRevision });
    const write = harness.mutateCredential.mock.calls[0]?.[0].mutation as { content: Parameters<typeof openQualifiedConnectedAccountContentEnvelope>[0]['envelope'] };
    expect(openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', ...harness.contentMode, envelope: write.content }))
      .toMatchObject({ values: { token: 'access-new', refreshToken: 'refresh-new' } });
    const deleteCredential = vi.fn(async () => ({ success: true as const }));
    await expect(revokeQualifiedConnectedAccount({
      account: ref, token: harness.credentials.token, cleanupGroupReferences: true, resolveV4Support: () => 'advertised',
      resolveRemovalReviewSupport: () => 'absent', establishedRuntimeOwner: harness.owner, deleteCredential,
    })).resolves.toMatchObject({ status: 'deleted', remoteStatus });
    expect(deleteCredential).toHaveBeenCalledWith(expect.objectContaining({ deletion: expect.objectContaining({ ref }) }));
    expect(request).toHaveBeenCalledTimes(provider === 'railway' ? 1 : 2);
  });

  it.each([
    ['plain', 'provider_response'], ['plain', 'after_exchange'], ['plain', 'during_persist'],
    ['e2ee', 'provider_response'], ['e2ee', 'after_exchange'], ['e2ee', 'during_persist'],
  ] as const)(
    'settles the rotated token in %s mode after registry retirement %s adopts a successor publication', async (mode, timing) => {
    const harness = await createHarness('id-old', mode);
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (timing === 'provider_response') await harness.retireRegistry();
      return new Response(JSON.stringify({
        access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    if (timing === 'after_exchange') {
      harness.retireAfterExchange();
    } else if (timing === 'during_persist') {
      harness.mutateCredential.mockImplementationOnce(async () => {
        await harness.retireRegistry();
        return { success: true, credentialRevision: nextCredentialRevision, configurationRevision: null };
      });
    }
    await expect(refreshQualifiedConnectedAccount({
      account, token: harness.credentials.token, ownerId: 'machine-1:runtime-1',
      leaseMs: 60_000, operationId: 'rotate-across-reload', expectedCredential: harness.credentialSnapshot,
      resolveV4Support: () => 'advertised', establishedRuntimeOwner: harness.owner,
      acquireRefreshLease: harness.acquireRefreshLease, mutateCredential: harness.mutateCredential,
    })).resolves.toMatchObject({ status: 'refreshed', credentialRevision: nextCredentialRevision });
    expect(harness.isRegistryCurrent()).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(harness.mutateCredential).toHaveBeenCalledOnce();
    const mutation = harness.mutateCredential.mock.calls[0]![0].mutation as {
      content: Parameters<typeof openQualifiedConnectedAccountContentEnvelope>[0]['envelope'];
      metadata: Parameters<typeof parseQualifiedConnectedAccountCredentialPlaintextV1>[0]['metadata'];
    };
    expect(parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: account,
      authenticationModeId: 'oauth',
      plaintext: openQualifiedConnectedAccountContentEnvelope({
        kind: 'credential', ...harness.contentMode, envelope: mutation.content,
      }),
      metadata: mutation.metadata,
    })).toMatchObject({ v: 1, values: { accessToken: 'access-new', refreshToken: 'refresh-new' } });
  });
  it('persists the rotated replacement when the caller cancels at the credential write boundary', async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    harness.mutateCredential.mockImplementationOnce(async params => {
      controller.abort();
      params.signal?.throwIfAborted();
      return { success: true, credentialRevision: nextCredentialRevision, configurationRevision: null };
    });
    await expect(refreshQualifiedConnectedAccount({
      account, token: harness.credentials.token, ownerId: 'machine-1:runtime-1',
      leaseMs: 60_000, operationId: 'cancel-after-exchange', signal: controller.signal,
      expectedCredential: harness.credentialSnapshot, resolveV4Support: () => 'advertised',
      establishedRuntimeOwner: harness.owner, acquireRefreshLease: harness.acquireRefreshLease,
      mutateCredential: harness.mutateCredential,
    })).resolves.toMatchObject({ status: 'refreshed', credentialRevision: nextCredentialRevision });
    expect(controller.signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(harness.mutateCredential).toHaveBeenCalledOnce();
    expect(harness.mutateCredential.mock.calls[0]![0]).not.toHaveProperty('signal');
  });

  it('cancels before the exchange when the caller aborts during lease admission', async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn());
    harness.acquireRefreshLease.mockImplementationOnce(async () => {
      controller.abort();
      return { acquired: true, leaseUntil: Date.now() + 60_000, ownerId: 'machine-1:runtime-1', credentialRevision };
    });
    await expect(refreshQualifiedConnectedAccount({
      account, token: harness.credentials.token, ownerId: 'machine-1:runtime-1',
      leaseMs: 60_000, operationId: 'cancel-before-exchange', signal: controller.signal,
      expectedCredential: harness.credentialSnapshot, resolveV4Support: () => 'advertised',
      establishedRuntimeOwner: harness.owner, acquireRefreshLease: harness.acquireRefreshLease,
      mutateCredential: harness.mutateCredential,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.mutateCredential).not.toHaveBeenCalled();
  });

  it.each(['not_attempted', 'unknown', 'confirmed'] as const)(
    'identifies a successful provider exchange when credential persistence is %s', async (persistenceOutcome) => {
      // Entropy is a genuine system boundary. Fail while sealing the E2EE
      // replacement, after exchange but before the Home write is attempted.
      const harness = persistenceOutcome === 'not_attempted'
        ? await createHarness('id-old', 'e2ee', () => { throw new Error('Credential encryption entropy unavailable'); })
        : await createHarness();
      vi.stubGlobal('fetch', vi.fn(async () => {
        return new Response(JSON.stringify({
          access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }));
      if (persistenceOutcome === 'unknown') {
        harness.mutateCredential.mockRejectedValueOnce(new Error('credential write response lost'));
      } else if (persistenceOutcome === 'confirmed') {
        harness.mutateCredential.mockImplementationOnce(async () => {
          return { success: true, credentialRevision: nextCredentialRevision, configurationRevision: 'unexpected-configuration' };
        });
      }

      await expect(refreshQualifiedConnectedAccount({
        account, token: harness.credentials.token, ownerId: 'machine-1:runtime-1',
        leaseMs: 60_000, operationId: 'refresh-settlement-failure', expectedCredential: harness.credentialSnapshot,
        resolveV4Support: () => 'advertised', establishedRuntimeOwner: harness.owner,
        acquireRefreshLease: harness.acquireRefreshLease, mutateCredential: harness.mutateCredential,
      })).rejects.toMatchObject({
        providerExchange: 'succeeded', persistenceOutcome,
        ...(persistenceOutcome === 'not_attempted' ? { cause: expect.objectContaining({
          message: 'Credential encryption entropy unavailable',
        }) } : {}),
      });
      // A rotated token must never cause a second OAuth exchange on settlement failure.
      expect(fetch).toHaveBeenCalledOnce();
      expect(harness.mutateCredential).toHaveBeenCalledTimes(persistenceOutcome === 'not_attempted' ? 0 : 1);
      expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    },
  );

  it('keeps provider rejection distinct from a successful exchange with failed persistence', async () => {
    const harness = await createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })));
    await expect(refreshQualifiedConnectedAccount({
      account, token: harness.credentials.token, ownerId: 'machine-1:runtime-1',
      leaseMs: 60_000, operationId: 'refresh-provider-rejected', expectedCredential: harness.credentialSnapshot,
      resolveV4Support: () => 'advertised', establishedRuntimeOwner: harness.owner,
      acquireRefreshLease: harness.acquireRefreshLease, mutateCredential: harness.mutateCredential,
    })).resolves.toMatchObject({ status: 'not_connected', result: { status: 'reconnectRequired' } });
    expect(harness.mutateCredential).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('backfills a retained account email on normal refresh even when OpenAI returns no new ID token', async () => {
    const idToken = `header.${Buffer.from(JSON.stringify({
      'https://api.openai.com/profile': { email: 'retained@example.test' },
    })).toString('base64url')}.signature`;
    const harness = await createHarness(idToken);
    expect(harness.credentialSnapshot.metadata.providerIdentity).toEqual({ accountId: 'account-1' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(refreshQualifiedConnectedAccount({
      account, token: harness.credentials.token, ownerId: 'machine-1:runtime-1',
      leaseMs: 60_000, operationId: 'retained-email-refresh', expectedCredential: harness.credentialSnapshot,
      resolveV4Support: () => 'advertised', establishedRuntimeOwner: harness.owner,
      acquireRefreshLease: harness.acquireRefreshLease, mutateCredential: harness.mutateCredential,
    })).resolves.toMatchObject({ status: 'refreshed', result: {
      providerIdentity: { accountId: 'account-1', email: 'retained@example.test' },
    } });
    expect(harness.mutateCredential).toHaveBeenCalledWith(expect.objectContaining({ mutation: expect.objectContaining({
      metadata: expect.objectContaining({ providerIdentity: { accountId: 'account-1', email: 'retained@example.test' } }),
    }) }));
  });

  it.each([
    ['busy', 'connected_account_refresh_lease_not_acquired'],
    ['owner', 'connected_account_refresh_lease_owner_mismatch'],
    ['revision', 'connected_account_refresh_lease_revision_mismatch'],
  ] as const)('preserves a %s lease refusal without invoking the provider', async (wiring, code) => {
    const harness = await createHarness();
    vi.stubGlobal('fetch', vi.fn());
    harness.acquireRefreshLease.mockResolvedValue({
      acquired: wiring !== 'busy',
      leaseUntil: Date.now() + 60_000,
      ownerId: wiring === 'owner' ? 'another-machine:runtime' : 'machine-1:runtime-1',
      credentialRevision: wiring === 'revision' ? nextCredentialRevision : credentialRevision,
    });

    await expect(refreshQualifiedConnectedAccount({
      account, token: harness.credentials.token, ownerId: 'machine-1:runtime-1',
      leaseMs: 60_000, operationId: 'refused-refresh', expectedCredential: harness.credentialSnapshot,
      resolveV4Support: () => 'advertised', establishedRuntimeOwner: harness.owner,
      acquireRefreshLease: harness.acquireRefreshLease, mutateCredential: harness.mutateCredential,
    })).rejects.toMatchObject({ code });
    expect(fetch).not.toHaveBeenCalled();
    expect(harness.mutateCredential).not.toHaveBeenCalled();
  });

  it('fails closed before acquiring a raw V4 lease when atomic support is absent', async () => {
    const harness = await createHarness();

    await expect(refreshQualifiedConnectedAccount({
      account,
      token: harness.credentials.token,
      ownerId: 'machine-1:runtime-1',
      leaseMs: 60_000,
      operationId: 'refresh-preflight',
      expectedCredential: harness.credentialSnapshot,
      resolveV4Support: () => 'absent',
      establishedRuntimeOwner: harness.owner,
      acquireRefreshLease: harness.acquireRefreshLease,
      mutateCredential: harness.mutateCredential,
    })).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });

    expect(harness.acquireRefreshLease).not.toHaveBeenCalled();
    expect(harness.mutateCredential).not.toHaveBeenCalled();
  });

  it('refuses an unfenced snapshot before acquiring a refresh lease', async () => {
    const harness = await createHarness();
    const expectedCredential = {
      ...harness.credentialSnapshot,
      revisionSemantics: 'legacy_unfenced' as const,
      credentialRevision: null,
    };

    await expect(refreshQualifiedConnectedAccount({
      account,
      token: harness.credentials.token,
      ownerId: 'machine-1:runtime-1',
      leaseMs: 60_000,
      operationId: 'refresh-unfenced',
      expectedCredential,
      resolveV4Support: () => 'advertised',
      establishedRuntimeOwner: harness.owner,
      acquireRefreshLease: harness.acquireRefreshLease,
      mutateCredential: harness.mutateCredential,
    })).rejects.toThrow('requires a revisioned credential snapshot');

    expect(harness.acquireRefreshLease).not.toHaveBeenCalled();
    expect(harness.mutateCredential).not.toHaveBeenCalled();
  });

  it('runs the real current plugin refresh leaf and settles its exact staged replacement through K', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      id_token: 'id-new',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const harness = await createHarness();

    await expect(refreshQualifiedConnectedAccount({
      account,
      token: harness.credentials.token,
      ownerId: 'machine-1:runtime-1',
      leaseMs: 60_000,
      operationId: 'refresh-1',
      expectedCredential: harness.credentialSnapshot,
      resolveV4Support: () => 'advertised',
      establishedRuntimeOwner: harness.owner,
      acquireRefreshLease: harness.acquireRefreshLease,
      mutateCredential: harness.mutateCredential,
    })).resolves.toMatchObject({
      status: 'refreshed',
      credentialRevision: nextCredentialRevision,
      result: {
        status: 'connected',
        displayName: 'ChatGPT',
      },
    });

    expect(harness.acquireRefreshLease).toHaveBeenCalledWith({
      token: 'happier-token',
      lease: {
        ref: account,
        expectedCredentialRevision: credentialRevision,
        ownerId: 'machine-1:runtime-1',
        ttlMs: 60_000,
      },
    });
    expect(harness.mutateCredential).toHaveBeenCalledOnce();
    const mutation = harness.mutateCredential.mock.calls[0]![0].mutation as {
      content: Parameters<typeof openQualifiedConnectedAccountContentEnvelope>[0]['envelope'];
      metadata: {
        providerIdentity: { accountId: string };
        displayName?: string;
        scopes?: readonly string[];
      };
    } & Readonly<Record<string, unknown>>;
    expect(mutation).toMatchObject({
      ref: account,
      authenticationModeId: 'oauth',
      expectedCredentialRevision: credentialRevision,
      expectedConfigurationRevision: null,
      refreshLeaseOwnerId: 'machine-1:runtime-1',
      metadata: {
        providerIdentity: { accountId: 'account-1' },
        displayName: 'ChatGPT',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
      },
    });
    const plaintext = openQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      envelope: mutation.content,
    });
    expect(parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: account,
      authenticationModeId: 'oauth',
      plaintext,
      metadata: mutation.metadata,
    })).toEqual({
      v: 1,
      values: {
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        idToken: 'id-new',
        providerAccountId: 'account-1',
        lastRefreshAtMs: expect.any(String),
      },
    });
  });

  it('does not report refresh success or mutate K when the remote outcome is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('response lost');
    }));
    const harness = await createHarness();

    await expect(refreshQualifiedConnectedAccount({
      account,
      token: harness.credentials.token,
      ownerId: 'machine-1:runtime-1',
      leaseMs: 60_000,
      operationId: 'refresh-2',
      expectedCredential: harness.credentialSnapshot,
      resolveV4Support: () => 'advertised',
      establishedRuntimeOwner: harness.owner,
      acquireRefreshLease: harness.acquireRefreshLease,
      mutateCredential: harness.mutateCredential,
    })).resolves.toMatchObject({
      status: 'outcome_unknown',
      result: { status: 'outcomeUnknown' },
    });

    expect(harness.mutateCredential).not.toHaveBeenCalled();
  });
});
