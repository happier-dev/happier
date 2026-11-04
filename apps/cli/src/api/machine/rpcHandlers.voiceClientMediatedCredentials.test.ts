import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';

import { accountSettingsParse, VoiceProviderContributionSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingOwnerDependencies } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/openai/src/manifest';
import { registerMachineVoiceClientMediatedCredentialRpcHandlers } from './rpcHandlers.voiceClientMediatedCredentials';

// Genuine HTTP boundary; keep the real fetch adapter and its package-owned Agent.
vi.mock('undici', async importOriginal => {
  const runtime = await importOriginal<typeof import('undici')>();
  return { ...runtime, fetch: vi.fn(runtime.fetch) };
});

function stubProviderFetch(fetchBoundary: typeof globalThis.fetch) {
  return vi.mocked(undici.fetch).mockImplementation(fetchBoundary as unknown as typeof undici.fetch);
}

const contribution = Object.freeze({ pluginId: PLUGIN_MANIFEST.id, localId: 'realtime-openai' });
const declaration = VoiceProviderContributionSchema.parse(
  PLUGIN_MANIFEST.contributes.voiceProviders?.find((provider) => provider.id === contribution.localId),
);
if (declaration.kind !== 'conversation' || !declaration.credentials) throw new Error('Expected actual OpenAI conversation declaration');
const service = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'openai-codex' });
const bindingPurpose = Object.freeze({ consumer: contribution, purpose: declaration.credentials.slot.purpose });
const materializationRequest = Object.freeze({
  kind: 'httpHeaders' as const,
  origin: 'https://api.openai.com',
  headerNames: Object.freeze(['authorization', 'chatgpt-account-id']),
});

function accountTarget(accountId: string) {
  return Object.freeze({
    kind: 'account' as const,
    account: Object.freeze({ service, accountId }),
  });
}

function projectedAuthority() {
  return Object.freeze({
    kind: 'projected' as const,
    cacheIdentity: Object.freeze({
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    }),
  });
}

function groupTarget(groupId: string) {
  return Object.freeze({
    kind: 'group' as const,
    service,
    groupId,
  });
}

function snapshot(accountId: string): ActiveAccountSettingsSnapshot {
  return {
    source: 'network',
    scopeKey: 'account-scope',
    settingsVersion: 4,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    connectedPurposeCatalog: { status: 'ready', revision: 4, record: { key: 'purposes', value: { v: 1, bindings: [{
      purpose: bindingPurpose, target: { kind: 'account', account: { service, accountId } },
    }] } } },
    settings: accountSettingsParse({
      voiceSettingsV1: { credentialBindings: [{
        contribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
        credentialBindings: { account: {} },
      }] },
    }),
  };
}

function groupSnapshot(groupId: string): ActiveAccountSettingsSnapshot {
  return {
    source: 'network',
    scopeKey: 'account-scope',
    settingsVersion: 4,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
    connectedPurposeCatalog: { status: 'ready', revision: 4, record: { key: 'purposes', value: { v: 1, bindings: [{
      purpose: bindingPurpose, target: { kind: 'group', service, groupId },
    }] } } },
    settings: accountSettingsParse({
      voiceSettingsV1: { credentialBindings: [{
        contribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
        credentialBindings: { account: {} },
      }] },
    }),
  };
}

type ResolvedAccountRef = Readonly<{
  service: Readonly<{ pluginId: string; localId: string }>;
  accountId: string;
}>;

/** Real binding owner with persistence, account projection and producer boundaries. */
function connectedAccountsOwner(input: Readonly<{
  resolvedAccountId: string;
  selectedTarget?: ReturnType<typeof accountTarget> | ReturnType<typeof groupTarget>;
  headersByAccountId?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>) {
  const calls: Array<Readonly<{ expectedAccount: ResolvedAccountRef | undefined }>> = [];
  const target = input.selectedTarget ?? accountTarget(input.resolvedAccountId);
  const account = { service, accountId: input.resolvedAccountId };
  const bindings = { v: 1 as const, bindings: [{ purpose: bindingPurpose, target }] };
  const materializeAccount: ConnectedAccountPurposeBindingOwnerDependencies['materializeAccount'] = async () => {
    const headers = input.headersByAccountId?.[input.resolvedAccountId]
      ?? {
        authorization: `Bearer ${input.resolvedAccountId}`,
        'chatgpt-account-id': input.resolvedAccountId,
      };
    return { kind: 'httpHeaders' as const, headers };
  };
  const owner = createConnectedAccountPurposeBindingOwner({
    store: {
      read: async () => bindings,
      update: async (mutate) => {
        const next = mutate(bindings);
        return next;
      },
      subscribe: () => ({ dispose() {} }),
    },
    selectTarget: async () => target,
    resolveTarget: async () => ({
      displayName: 'Selected account', account,
      ...(target.kind === 'group' ? { group: { groupId: target.groupId, generation: 1 } } : {}),
    }),
    materializeAccount,
    projectTargetAccounts: async () => { throw new Error('not a listing operation'); },
    assertTargetAccountMaterializable: async () => { throw new Error('not a listed-account operation'); },
  });
  const materialize = vi.fn(async (request: Parameters<typeof owner.materialize>[0]) => {
    calls.push(Object.freeze({ expectedAccount: request.expectedAccount }));
    return await owner.materialize(request);
  });
  return Object.freeze({ ...owner, materialize, calls });
}

const admittedFixtures: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>[] = [];
afterAll(async () => {
  const fixtures = admittedFixtures.splice(0).reverse();
  await Promise.all(fixtures.map((fixture) => fixture.lease.release()));
  for (const fixture of fixtures) await fixture.dispose();
});

async function registerHandler(input: Readonly<{
  connectedAccounts: ReturnType<typeof connectedAccountsOwner>;
  currentSnapshot: ActiveAccountSettingsSnapshot | null;
  getSnapshot?: () => ActiveAccountSettingsSnapshot | null;
}>) {
  const registrar = new RpcHandlerManager({ scopePrefix: 'machine-voice', encryptionMode: 'plain', logger() {} });
  const fixture = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: [PLUGIN_MANIFEST.id], connectedAccounts: input.connectedAccounts },
  });
  admittedFixtures.push(fixture);
  await fixture.registry.activateContributionsOnDemand([{ pluginId: contribution.pluginId, family: 'voiceProviders', localId: contribution.localId }]);
  const admitted = fixture.registry.contributes.voiceProviders?.find((provider) => (
    provider.identity.pluginId === contribution.pluginId && provider.identity.localId === contribution.localId
  ));
  if (admitted?.provenance !== 'first_party' || admitted.source.kind !== 'bundled') {
    throw new Error('Expected actual admitted bundled OpenAI declaration');
  }
  registerMachineVoiceClientMediatedCredentialRpcHandlers({
    rpcHandlerManager: registrar,
    getAccountSettingsSnapshot: input.getSnapshot ?? (() => input.currentSnapshot),
    ensureAccountSettingsSnapshot: async () => {},
  });
  return (raw: unknown) => registrar.invokeLocal(RPC_METHODS.DAEMON_VOICE_CLIENT_ACCOUNT_OPERATION, raw);
}

const ephemeralBody = JSON.stringify({ value: 'ephemeral-client-secret', expires_at: 2_000_000_000 });
const operationResponse = { status: 200, finalUrl: 'https://api.openai.com/v1/realtime/client_secrets', headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(ephemeralBody).toString('base64') };

describe('Voice client mediated Connected Account credential RPC', () => {
  beforeEach(() => {
    stubProviderFetch(async () => new Response(ephemeralBody, { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  afterEach(() => { vi.mocked(undici.fetch).mockReset(); vi.restoreAllMocks(); });
  it('executes the declared mint on the machine and returns only its ephemeral response', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const providerFetch = stubProviderFetch(async () => new Response(
      JSON.stringify({ value: 'ephemeral-client-secret', expires_at: 2_000_000_000 }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-provider-private': 'hidden' } },
    ));
    try {
      const handler = await registerHandler({ connectedAccounts: owner, currentSnapshot: snapshot('account-a') });
      const result = await handler({
        contribution, platform: 'web', phase: 'prepare', operationId: 'client-auth', parameters: { body: {} },
        declarationAuthority: projectedAuthority(),
        expectedSelection: accountTarget('account-a'),
      });
      expect(result).toEqual({
        ok: true,
        response: {
          status: 200, finalUrl: 'https://api.openai.com/v1/realtime/client_secrets',
          headers: { 'content-type': 'application/json' },
          bodyBase64: Buffer.from(JSON.stringify({ value: 'ephemeral-client-secret', expires_at: 2_000_000_000 })).toString('base64'),
        },
      });
      expect(providerFetch).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/client_secrets', expect.objectContaining({
        method: 'POST', redirect: 'error', headers: expect.objectContaining({ authorization: 'Bearer account-a' }),
      }));
      expect(JSON.stringify(result)).not.toContain('Bearer account-a');
    } finally { providerFetch.mockRestore(); }
  });
  it.each([
    [401, { error: 'private provider text' }, 'plugin_voice_credential_access_unavailable'],
    [200, { value: 'Bearer account-a' }, 'plugin_voice_provider_operation_failed'],
  ] as const)('does not disclose rejected HTTP artifacts (status %s)', async (status, body, errorCode) => {
    stubProviderFetch(async () => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    }));
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const handler = await registerHandler({ connectedAccounts: owner, currentSnapshot: snapshot('account-a') });
    await expect(handler({
      contribution, platform: 'web', phase: 'prepare', operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: { kind: 'bundled' }, expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({ ok: false, errorCode });
  });

  it('finishes an admitted mint after same-Account selection changes and uses the new selection next time', async () => {
    let current = snapshot('account-a');
    let completedHttp = false;
    stubProviderFetch(async () => {
      current = snapshot('account-b');
      completedHttp = true;
      return new Response(ephemeralBody, { headers: { 'content-type': 'application/json' } });
    });
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const handler = await registerHandler({ connectedAccounts: owner, currentSnapshot: current, getSnapshot: () => current });
    const request = {
      contribution, platform: 'web', phase: 'prepare', operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: { kind: 'bundled' }, expectedSelection: accountTarget('account-a'),
    };
    const result = await handler(request);
    expect(completedHttp).toBe(true);
    expect(result).toMatchObject({ ok: true });
    await expect(handler(request)).resolves.toEqual({ ok: false, errorCode: 'plugin_voice_credential_access_unavailable' });
  });

  it('discards an ephemeral response after switching the owning Happier Account', async () => {
    let current = snapshot('account-a');
    let completedHttp = false;
    stubProviderFetch(async () => {
      current = { ...snapshot('account-b'), scopeKey: 'another-happier-account' };
      completedHttp = true;
      return new Response(ephemeralBody, { headers: { 'content-type': 'application/json' } });
    });
    const handler = await registerHandler({ connectedAccounts: connectedAccountsOwner({ resolvedAccountId: 'account-a' }),
      currentSnapshot: current, getSnapshot: () => current });
    await expect(handler({
      contribution, platform: 'web', phase: 'prepare', operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: { kind: 'bundled' }, expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({ ok: false, errorCode: 'plugin_voice_credential_access_unavailable' });
    expect(completedHttp).toBe(true);
  });

  it('materializes only the selected manifest-declared source and exact operation projection', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const handler = await registerHandler({
      connectedAccounts: owner,
      currentSnapshot: snapshot('account-a'),
    });

    await expect(handler({
      contribution,
      platform: 'web',
      phase: 'prepare',
      operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: projectedAuthority(),
      expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({
      ok: true,
      response: operationResponse,
    });
    expect(owner.materialize).toHaveBeenCalledWith(expect.objectContaining({
      purpose: bindingPurpose,
      serviceRefs: [service],
      request: materializationRequest,
      expectedAccount: { service, accountId: 'account-a' },
    }));

    await expect(handler({
      contribution,
      platform: 'web',
      phase: 'connection',
      operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: projectedAuthority(),
      expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_credential_access_unavailable',
    });
    expect(owner.materialize).toHaveBeenCalledTimes(1);
  });

  it('accepts the required Codex authorization header without its optional account header', async () => {
    const owner = connectedAccountsOwner({
      resolvedAccountId: 'account-a',
      headersByAccountId: {
        'account-a': { authorization: 'Bearer account-a' },
      },
    });
    const handler = await registerHandler({
      connectedAccounts: owner,
      currentSnapshot: snapshot('account-a'),
    });

    await expect(handler({
      contribution,
      platform: 'web',
      phase: 'prepare',
      operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: projectedAuthority(),
      expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({
      ok: true,
      response: operationResponse,
    });
    expect(owner.materialize).toHaveBeenCalledTimes(1);
  });

  it('produces no headers when the caller captured Account A and this daemon has already selected Account B', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-b' });
    const handler = await registerHandler({
      connectedAccounts: owner,
      currentSnapshot: snapshot('account-b'),
    });

    await expect(handler({
      contribution,
      platform: 'web',
      phase: 'prepare',
      operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: projectedAuthority(),
      expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_credential_access_unavailable',
    });
    expect(owner.materialize).not.toHaveBeenCalled();
  });

  it('produces no headers when the Connected Account binding resolves an account the settings snapshot does not name', async () => {
    // The daemon's Account Settings snapshot and the Connected Account binding
    // store are separate readers. Only the caller's expected account, handed to
    // the binding owner, can fence the case where they disagree.
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-b' });
    const handler = await registerHandler({
      connectedAccounts: owner,
      currentSnapshot: snapshot('account-a'),
    });

    await expect(handler({
      contribution,
      platform: 'web',
      phase: 'prepare',
      operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: projectedAuthority(),
      expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_credential_access_unavailable',
    });
    expect(owner.calls).toEqual([{ expectedAccount: { service, accountId: 'account-a' } }]);
  });

  it('materializes a fresh invocation against this daemon’s current runtime and account', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-b' });
    const handler = await registerHandler({
      connectedAccounts: owner,
      currentSnapshot: snapshot('account-b'),
    });

    await expect(handler({
      contribution,
      platform: 'web',
      phase: 'prepare',
      operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: projectedAuthority(),
      expectedSelection: accountTarget('account-b'),
    })).resolves.toEqual({
      ok: true,
      response: operationResponse,
    });
  });

  it('materializes for a first-party provider compiled into the caller, which names no daemon projection', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const handler = await registerHandler({
      connectedAccounts: owner,
      currentSnapshot: snapshot('account-a'),
    });

    await expect(handler({
      contribution,
      platform: 'web',
      phase: 'prepare',
      operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: { kind: 'bundled' },
      expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({
      ok: true,
      response: operationResponse,
    });
  });
  /**
   * A group selection is the one case the Connected Account owner cannot fence
   * for this caller: the concrete account is resolved daemon-side, so no
   * `expectedAccount` can be carried and the carried selection is the only
   * cross-process authority check there is.
   */
  it('produces no headers when the caller captured one account group and this daemon has selected another', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-b', selectedTarget: groupTarget('group-b') });
    const handler = await registerHandler({
      connectedAccounts: owner,
      currentSnapshot: groupSnapshot('group-b'),
    });

    await expect(handler({
      contribution,
      platform: 'web',
      phase: 'prepare',
      operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: projectedAuthority(),
      expectedSelection: groupTarget('group-a'),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_credential_access_unavailable',
    });
    expect(owner.materialize).not.toHaveBeenCalled();
  });

  it('materializes a group selection the caller and this daemon both name', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-b', selectedTarget: groupTarget('group-a') });
    const handler = await registerHandler({
      connectedAccounts: owner,
      currentSnapshot: groupSnapshot('group-a'),
    });

    await expect(handler({
      contribution,
      platform: 'web',
      phase: 'prepare',
      operationId: 'client-auth', parameters: { body: {} },
      declarationAuthority: projectedAuthority(),
      expectedSelection: groupTarget('group-a'),
    })).resolves.toEqual({
      ok: true,
      response: operationResponse,
    });
    expect(owner.calls).toEqual([{ expectedAccount: undefined }]);
  });
});
