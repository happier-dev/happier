import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openQualifiedConnectedAccountContentEnvelope,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { refreshQualifiedConnectedAccount } from './refreshQualifiedConnectedAccount';

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

async function createHarness() {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-qualified-refresh-'));
  createdDirectories.push(happyHomeDir);
  const registry = await resolveExecutablePluginRuntimeRegistry({
    happyHomeDir,
    pluginIds: [service.pluginId],
  });
  createdRegistries.push(registry);
  let generationCurrent = true;
  const credentials: Credentials = {
    token: 'happier-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(5),
    },
  };
  const credentialSnapshot = {
    ref: account,
    authenticationModeId: 'oauth',
    revisionSemantics: 'revisioned' as const,
    credentialRevision,
    configurationRevision: null,
    content: sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      payload: {
        v: 1,
        values: {
          accessToken: 'access-old',
          refreshToken: 'refresh-old',
          idToken: 'id-old',
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
  };
  const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
    reloadController: {
      async acquireRuntimeRegistry() {
        return {
          registry,
          source: 'active' as const,
          durableRevision: registry.durableRevision ?? -1,
          release: vi.fn(async () => undefined),
        };
      },
      isRuntimeRegistryCurrent(candidate: typeof registry) {
        return generationCurrent && candidate === registry;
      },
    },
    credentials,
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    readCredential: vi.fn(async () => credentialSnapshot),
    readConfiguration: vi.fn(async () => null),
    configuration: {
      read: vi.fn(async () => null),
      secrets: {
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
    acquireRefreshLease,
    mutateCredential,
    setGenerationCurrent(value: boolean) {
      generationCurrent = value;
    },
  };
}

describe('refreshQualifiedConnectedAccount', () => {
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
        displayName: 'account-1',
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
        displayName: 'account-1',
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
