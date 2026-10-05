import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountSettingsParse, VoiceProviderContributionSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingOwnerDependencies } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';


const contribution = Object.freeze({ pluginId: 'happier.voice.openai', localId: 'realtime-openai' });
const service = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'openai-codex' });
const bindingPurpose = Object.freeze({ consumer: contribution, purpose: 'voice.credential-slot' });
const operationPurpose = Object.freeze({ consumer: contribution, purpose: 'voice.client-auth' });
const materializationRequest = Object.freeze({
  kind: 'httpHeaders' as const,
  origin: 'https://api.openai.com',
  headerNames: Object.freeze(['authorization', 'chatgpt-account-id']),
});
const DAEMON_REGISTRY_GENERATION = 12;
let nextRegistryRevision = DAEMON_REGISTRY_GENERATION;

function accountTarget(accountId: string) {
  return Object.freeze({
    kind: 'account' as const,
    account: Object.freeze({ service, accountId }),
  });
}

function projectedAuthority(_projectionGeneration: number) {
  return Object.freeze({
    kind: 'projected' as const,
    cacheIdentity: Object.freeze({
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    }),
  });
}

function manager(): Readonly<{
  handlers: Map<string, RpcHandler>;
  registrar: RpcHandlerRegistrar;
}> {
  const handlers = new Map<string, RpcHandler>();
  const registrar: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
  return {
    handlers,
    registrar,
  };
}

function manifest() {
  const voiceProvider = VoiceProviderContributionSchema.parse({
    id: contribution.localId,
    title: 'OpenAI Realtime',
    kind: 'conversation',
    roles: ['realtime_conversation'],
    platforms: ['web'],
    capabilities: { turn: { cancelResponse: true, bargeIn: true } },
    credentials: {
      slot: { id: 'api_key', purpose: bindingPurpose.purpose, title: 'OpenAI credential' },
      requirement: { kind: 'always' },
      sources: [{
        kind: 'connectedAccount',
        service,
        operationProjections: [{
          kind: 'materializedHttpHeaders',
          operation: 'client-auth',
          phase: 'prepare',
          request: materializationRequest,
          requiredHeaderNames: ['authorization'],
          allowedHeaderNames: materializationRequest.headerNames,
        }],
      }],
      hostMediated: { operations: [{
        id: 'client-auth',
        purpose: operationPurpose.purpose,
        credentialSlotId: 'api_key',
        effect: 'read',
        request: {
          origin: 'https://api.openai.com',
          pathTemplate: '/v1/realtime/client_secrets',
          queryTemplate: [],
          headerTemplate: [],
          bodyTemplate: { kind: 'json', value: {} },
          method: 'POST',
          credential: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
          redirect: 'error',
          maxBodyBytes: 65_536,
          contentTypes: ['application/json'],
        },
        parameters: {
          schema: { type: 'object', properties: {}, additionalProperties: false },
          mapping: [],
        },
        response: { maxBytes: 65_536, contentTypes: ['application/json'] },
      }] },
    },
    client: { artifactId: 'browser-client', exportName: 'activate' },
  });
  return {
    id: contribution.pluginId,
    contributes: {
      voiceProviders: [voiceProvider],
    },
  };
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
    settings: accountSettingsParse({
      voiceSettingsV1: { credentialBindings: [{
        contribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
        credentialBindings: { account: {} },
      }] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [{
        purpose: bindingPurpose,
        target: { kind: 'account', account: { service, accountId } },
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
    settings: accountSettingsParse({
      voiceSettingsV1: { credentialBindings: [{
        contribution,
        credentialSlotId: 'api_key',
        credentialSource: { kind: 'connectedAccount' },
        credentialBindings: { account: {} },
      }] },
      connectedAccountPurposeBindingsV1: { v: 1, bindings: [{
        purpose: bindingPurpose,
        target: { kind: 'group', service, groupId },
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

async function registerHandler(input: Readonly<{
  registryGeneration?: number;
  connectedAccounts: ReturnType<typeof connectedAccountsOwner>;
  currentSnapshot: ActiveAccountSettingsSnapshot | null;
  getSnapshot?: () => ActiveAccountSettingsSnapshot | null;
}>) {
  // Initialize fixture protocol declarations before loading the runtime host.
  const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
  const { registerMachineVoiceClientMediatedCredentialRpcHandlers } = await import('./rpcHandlers.voiceClientMediatedCredentials');
  const { handlers, registrar } = manager();
  const retirement = new AbortController();
  const registryRevision = Math.max(nextRegistryRevision, input.registryGeneration ?? 0);
  nextRegistryRevision = registryRevision + 1;
  const occurrenceId = createPluginRuntimeOccurrenceId(contribution.pluginId);
  // A prepared plugin module is the daemon composition input. Registry leasing,
  // publication and currentness stay on the real controller beneath this fixture.
  const registry: ResolvedExecutablePluginRuntimeRegistry = {
      durableRevision: registryRevision,
      contributes: {
        agents: [], providers: [], actions: [], resources: [], uiViewsV2: [],
        uiRenderersV2: [], uiTranslationsV2: [], activationTargets: [],
        catalogEntriesById: {}, agentDefinitionsById: new Map(), pluginDiagnosticsByPluginId: {},
        voiceProviders: [{
        provenance: 'first_party',
        source: { kind: 'bundled' },
        pluginId: contribution.pluginId,
        manifestPath: '/plugins/openai/happier.plugin.json',
        identity: contribution,
        definition: manifest().contributes.voiceProviders[0],
      }] },
      hookHandlersByHookId: new Map(), agentRuntimesByAgentId: new Map(), scmHostingProvidersById: new Map(),
      pluginDiagnosticsByPluginId: {}, activatedPluginIds: new Set([contribution.pluginId]),
      activateContributionsOnDemand: async () => [], resolvePromptAssetBlocks: async () => [],
      resolveCaptureSource: async () => null,
      addRuntimeDisposable: (_pluginId, disposable) => disposable,
      createAgentInvocationServices: async () => {
        const { createUnavailablePluginServices } = await import('@/plugins/runtime/invocation/services/unavailable');
        return createUnavailablePluginServices();
      },
      retireConsumers: () => retirement.abort(),
      retirePluginConsumers: async () => retirement.abort(),
      dispose: async () => retirement.abort(),
      resolveVoiceProviderRuntimeLifecycle: (candidate) => (
        candidate.pluginId === contribution.pluginId && candidate.localId === contribution.localId
          ? {
              occurrenceId,
              isCurrent: () => pluginReloadController.isRuntimeRegistryCurrent(registry),
              retirementSignal: retirement.signal,
            }
          : null
      ),
      resolveConnectedAccountPurposeBindingOwner: () => input.connectedAccounts,
  };
  const adopted = await pluginReloadController.adoptPreparedRuntimeRegistry({
    registry,
    changedPluginIds: [contribution.pluginId],
    durableRevision: registryRevision,
    runningSessionDisposition: 'retainRunningSessions',
  });
  if (!adopted.ok) throw new Error('fixture runtime adoption failed');
  registerMachineVoiceClientMediatedCredentialRpcHandlers({
    rpcHandlerManager: registrar,
    getAccountSettingsSnapshot: input.getSnapshot ?? (() => input.currentSnapshot),
    ensureAccountSettingsSnapshot: async () => {},
  });
  const handler = handlers.get(RPC_METHODS.DAEMON_VOICE_CLIENT_ACCOUNT_OPERATION);
  if (!handler) throw new Error('mediated credential handler was not registered');
  return handler;
}

const ephemeralBody = JSON.stringify({ value: 'ephemeral-client-secret', expires_at: 2_000_000_000 });
const operationResponse = { status: 200, finalUrl: 'https://api.openai.com/v1/realtime/client_secrets', headers: { 'content-type': 'application/json' }, bodyBase64: Buffer.from(ephemeralBody).toString('base64') };

describe('Voice client mediated Connected Account credential RPC', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(ephemeralBody, { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  afterEach(() => { vi.restoreAllMocks(); });
  it('executes the declared mint on the machine and returns only its ephemeral response', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const providerFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ value: 'ephemeral-client-secret', expires_at: 2_000_000_000 }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-provider-private': 'hidden' } },
    ));
    try {
      const handler = await registerHandler({ connectedAccounts: owner, currentSnapshot: snapshot('account-a') });
      const result = await handler({
        contribution, platform: 'web', phase: 'prepare', operationId: 'client-auth',
        declarationAuthority: projectedAuthority(DAEMON_REGISTRY_GENERATION),
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    }));
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const handler = await registerHandler({ connectedAccounts: owner, currentSnapshot: snapshot('account-a') });
    await expect(handler({
      contribution, platform: 'web', phase: 'prepare', operationId: 'client-auth',
      declarationAuthority: { kind: 'bundled' }, expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({ ok: false, errorCode });
  });

  it('discards an ephemeral response after the selected Account changes in flight', async () => {
    let current = snapshot('account-a');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      current = snapshot('account-b');
      return new Response(ephemeralBody, { headers: { 'content-type': 'application/json' } });
    });
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const handler = await registerHandler({ connectedAccounts: owner, currentSnapshot: current, getSnapshot: () => current });
    await expect(handler({
      contribution, platform: 'web', phase: 'prepare', operationId: 'client-auth',
      declarationAuthority: { kind: 'bundled' }, expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({ ok: false, errorCode: 'plugin_voice_credential_access_unavailable' });
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
      operationId: 'client-auth',
      declarationAuthority: projectedAuthority(DAEMON_REGISTRY_GENERATION),
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
      operationId: 'client-auth',
      declarationAuthority: projectedAuthority(DAEMON_REGISTRY_GENERATION),
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
      operationId: 'client-auth',
      declarationAuthority: projectedAuthority(DAEMON_REGISTRY_GENERATION),
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
      operationId: 'client-auth',
      declarationAuthority: projectedAuthority(DAEMON_REGISTRY_GENERATION),
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
      operationId: 'client-auth',
      declarationAuthority: projectedAuthority(DAEMON_REGISTRY_GENERATION),
      expectedSelection: accountTarget('account-a'),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_credential_access_unavailable',
    });
    expect(owner.calls).toEqual([{ expectedAccount: { service, accountId: 'account-a' } }]);
  });

  it('materializes a fresh invocation that names this daemon generation and its current account', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-b' });
    const handler = await registerHandler({
      registryGeneration: DAEMON_REGISTRY_GENERATION + 1,
      connectedAccounts: owner,
      currentSnapshot: snapshot('account-b'),
    });

    await expect(handler({
      contribution,
      platform: 'web',
      phase: 'prepare',
      operationId: 'client-auth',
      declarationAuthority: projectedAuthority(DAEMON_REGISTRY_GENERATION + 1),
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
      operationId: 'client-auth',
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
      operationId: 'client-auth',
      declarationAuthority: projectedAuthority(DAEMON_REGISTRY_GENERATION),
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
      operationId: 'client-auth',
      declarationAuthority: projectedAuthority(DAEMON_REGISTRY_GENERATION),
      expectedSelection: groupTarget('group-a'),
    })).resolves.toEqual({
      ok: true,
      response: operationResponse,
    });
    expect(owner.calls).toEqual([{ expectedAccount: undefined }]);
  });
});
