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

async function createHarness(idToken = 'id-old', accountMode: 'plain' | 'e2ee' = 'plain') {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-qualified-refresh-'));
  createdDirectories.push(happyHomeDir);
  const fixture = await createAdmittedPluginRuntimeFixture({
    happyHomeDir,
    runtimeOptions: { pluginIds: [service.pluginId] },
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
    ref: account,
    authenticationModeId: 'oauth',
    revisionSemantics: 'revisioned' as const,
    credentialRevision,
    configurationRevision: null,
    content: sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      ...contentMode,
      payload: {
        v: 1,
        values: {
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
  }>) => ({
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
    ['plain', 'provider_response'], ['plain', 'after_exchange'], ['plain', 'before_persist'], ['plain', 'during_persist'],
    ['e2ee', 'provider_response'], ['e2ee', 'after_exchange'], ['e2ee', 'before_persist'], ['e2ee', 'during_persist'],
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
    } else if (timing === 'before_persist') {
      harness.getAccountEncryptionMode.mockImplementation(async () => {
        if (vi.mocked(fetch).mock.calls.length > 0) await harness.retireRegistry();
        return mode;
      });
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
