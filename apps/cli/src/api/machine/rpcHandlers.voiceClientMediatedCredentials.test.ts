import { describe, expect, it, vi } from 'vitest';

import { accountSettingsParse, VoiceProviderContributionSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const runtimeLeaseMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(async () => undefined),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMocks.acquire,
}));

import { registerMachineVoiceClientMediatedCredentialRpcHandlers } from './rpcHandlers.voiceClientMediatedCredentials';

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

function accountTarget(accountId: string) {
  return Object.freeze({
    kind: 'account' as const,
    account: Object.freeze({ service, accountId }),
  });
}

function projectedAuthority(projectionGeneration: number) {
  return Object.freeze({
    kind: 'projected' as const,
    cacheIdentity: Object.freeze({
      pluginId: contribution.pluginId,
      contributionId: contribution.localId,
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      hostAppVersion: '1.0.0',
      hostUiApiVersion: '1',
      reactVersion: '19.0.0',
      reactNativeVersion: '0.79.0',
      platform: 'web',
      channel: 'stable',
      nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}`,
      projectionGeneration,
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
    client: { artifactId: 'browser-client', modulePath: './voice', exportName: 'activate' },
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

/**
 * Boundary double for the canonical Connected Account purpose-binding owner.
 *
 * It mirrors that owner's published `expectedAccount` contract exactly (reject
 * before materializing and again after, comparing the caller's expected account
 * against the account the binding store actually resolves) so the daemon's
 * settings-snapshot reader and the owner's binding-store reader can be made to
 * disagree the way they can in production.
 */
function connectedAccountsOwner(input: Readonly<{
  resolvedAccountId: string;
  headersByAccountId?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>) {
  const calls: Array<Readonly<{ expectedAccount: ResolvedAccountRef | undefined }>> = [];
  const materialize = vi.fn(async (request: Readonly<{
    expectedAccount?: ResolvedAccountRef;
  }>) => {
    calls.push(Object.freeze({ expectedAccount: request.expectedAccount }));
    const resolved: ResolvedAccountRef = { service, accountId: input.resolvedAccountId };
    const matches = (expected: ResolvedAccountRef | undefined): boolean => (
      !expected
      || (expected.service.pluginId === resolved.service.pluginId
        && expected.service.localId === resolved.service.localId
        && expected.accountId === resolved.accountId)
    );
    if (!matches(request.expectedAccount)) {
      throw Object.assign(new Error('resource_not_selected'), { code: 'resource_not_selected' });
    }
    const headers = input.headersByAccountId?.[input.resolvedAccountId]
      ?? {
        authorization: `Bearer ${input.resolvedAccountId}`,
        'chatgpt-account-id': input.resolvedAccountId,
      };
    if (!matches(request.expectedAccount)) {
      throw Object.assign(new Error('resource_not_selected'), { code: 'resource_not_selected' });
    }
    return { kind: 'httpHeaders' as const, headers };
  });
  return Object.freeze({ materialize, calls });
}

function registerHandler(input: Readonly<{
  registryGeneration?: number;
  materialize: ReturnType<typeof connectedAccountsOwner>['materialize'];
  currentSnapshot: ActiveAccountSettingsSnapshot | null;
}>) {
  const { handlers, registrar } = manager();
  runtimeLeaseMocks.acquire.mockResolvedValue({
    registry: {
      generation: input.registryGeneration ?? DAEMON_REGISTRY_GENERATION,
      contributes: { voiceProviders: [{
        pluginId: contribution.pluginId,
        identity: contribution,
        definition: manifest().contributes.voiceProviders[0],
      }] },
      resolveVoiceProviderRuntimeLifecycle: (candidate: typeof contribution) => (
        candidate.pluginId === contribution.pluginId && candidate.localId === contribution.localId
          ? {
              generation: '12',
              isCurrent: () => true,
              retirementSignal: new AbortController().signal,
            }
          : null
      ),
      resolveConnectedAccountPurposeBindingOwner: () => ({ materialize: input.materialize }),
    },
    release: runtimeLeaseMocks.release,
  });
  registerMachineVoiceClientMediatedCredentialRpcHandlers({
    rpcHandlerManager: registrar,
    getAccountSettingsSnapshot: () => input.currentSnapshot,
    ensureAccountSettingsSnapshot: async () => {},
  });
  const handler = handlers.get(RPC_METHODS.DAEMON_VOICE_CLIENT_MEDIATED_CREDENTIAL_MATERIALIZE);
  if (!handler) throw new Error('mediated credential handler was not registered');
  return handler;
}

describe('Voice client mediated Connected Account credential RPC', () => {
  it('materializes only the selected manifest-declared source and exact operation projection', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const handler = registerHandler({
      materialize: owner.materialize,
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
      headers: {
        authorization: 'Bearer account-a',
        'chatgpt-account-id': 'account-a',
      },
    });
    expect(owner.materialize).toHaveBeenCalledWith(expect.objectContaining({
      purpose: operationPurpose,
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
    const handler = registerHandler({
      materialize: owner.materialize,
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
      headers: { authorization: 'Bearer account-a' },
    });
    expect(owner.materialize).toHaveBeenCalledWith(expect.objectContaining({
      purpose: operationPurpose,
    }));
  });

  it.each([
    ['undeclared', { authorization: 'Bearer account-a', 'x-extra': 'nope' }],
    ['missing required', { 'chatgpt-account-id': 'account-a' }],
    ['empty', { authorization: '' }],
    ['newline', { authorization: 'Bearer account-a\r\nInjected: yes' }],
    ['case conflict', { authorization: 'Bearer account-a', Authorization: 'Bearer other' }],
  ])('rejects %s Connected Account header materialization', async (_label, headers) => {
    const owner = connectedAccountsOwner({
      resolvedAccountId: 'account-a',
      headersByAccountId: { 'account-a': headers },
    });
    const handler = registerHandler({
      materialize: owner.materialize,
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
      errorCode: 'plugin_voice_provider_operation_failed',
    });
  });

  it('rejects a caller whose projected declaration generation is not the daemon registry generation, before materializing', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const handler = registerHandler({
      registryGeneration: DAEMON_REGISTRY_GENERATION + 1,
      materialize: owner.materialize,
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
    expect(owner.materialize).not.toHaveBeenCalled();
  });

  it('produces no headers when the caller captured Account A and this daemon has already selected Account B', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-b' });
    const handler = registerHandler({
      materialize: owner.materialize,
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
    const handler = registerHandler({
      materialize: owner.materialize,
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
    const handler = registerHandler({
      registryGeneration: DAEMON_REGISTRY_GENERATION + 1,
      materialize: owner.materialize,
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
      headers: {
        authorization: 'Bearer account-b',
        'chatgpt-account-id': 'account-b',
      },
    });
  });

  it('materializes for a first-party provider compiled into the caller, which names no daemon projection', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-a' });
    const handler = registerHandler({
      materialize: owner.materialize,
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
      headers: {
        authorization: 'Bearer account-a',
        'chatgpt-account-id': 'account-a',
      },
    });
  });
  /**
   * A group selection is the one case the Connected Account owner cannot fence
   * for this caller: the concrete account is resolved daemon-side, so no
   * `expectedAccount` can be carried and the carried selection is the only
   * cross-process authority check there is.
   */
  it('produces no headers when the caller captured one account group and this daemon has selected another', async () => {
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-b' });
    const handler = registerHandler({
      materialize: owner.materialize,
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
    const owner = connectedAccountsOwner({ resolvedAccountId: 'account-b' });
    const handler = registerHandler({
      materialize: owner.materialize,
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
      headers: {
        authorization: 'Bearer account-b',
        'chatgpt-account-id': 'account-b',
      },
    });
    expect(owner.calls).toEqual([{ expectedAccount: undefined }]);
  });
});
