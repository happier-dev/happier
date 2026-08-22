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
const purpose = Object.freeze({ consumer: contribution, purpose: 'voice.client-auth' });
const materializationRequest = Object.freeze({
  kind: 'httpHeaders' as const,
  origin: 'https://api.openai.com',
  headerNames: Object.freeze(['authorization', 'chatgpt-account-id']),
});

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
      slot: { id: 'api_key', purpose: purpose.purpose, title: 'OpenAI credential' },
      requirement: { kind: 'always' },
      sources: [{
        kind: 'connectedAccount',
        service,
        operationProjections: [{
          kind: 'materializedHttpHeaders',
          operation: 'client-auth',
          phase: 'prepare',
          request: materializationRequest,
          allowedHeaderNames: materializationRequest.headerNames,
        }],
      }],
      hostMediated: { operations: [{
        id: 'client-auth',
        purpose: purpose.purpose,
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

describe('Voice client mediated Connected Account credential RPC', () => {
  it('materializes only the selected manifest-declared source and exact operation projection', async () => {
    const { handlers, registrar } = manager();
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: {
        authorization: 'Bearer account-a',
        'chatgpt-account-id': 'account-work',
      },
    }));
    const resolveVoiceProviderRuntimeLifecycle = vi.fn((candidate: typeof contribution) => (
      candidate.pluginId === contribution.pluginId && candidate.localId === contribution.localId
        ? {
            generation: '12',
            isCurrent: () => true,
            retirementSignal: new AbortController().signal,
          }
        : null
    ));
    runtimeLeaseMocks.acquire.mockResolvedValue({
      registry: {
        contributes: { voiceProviders: [{
          pluginId: contribution.pluginId,
          identity: contribution,
          definition: manifest().contributes.voiceProviders[0],
        }] },
        resolveVoiceProviderRuntimeLifecycle,
        resolveConnectedAccountPurposeBindingOwner: () => ({ materialize }),
      },
      release: runtimeLeaseMocks.release,
    });
    const activeSnapshot: ActiveAccountSettingsSnapshot = {
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
          purpose,
          target: { kind: 'account', account: { service, accountId: 'account-a' } },
        }] },
      }),
    };
    let currentSnapshot: ActiveAccountSettingsSnapshot | null = null;
    const ensureAccountSettingsSnapshot = vi.fn(async () => {
      currentSnapshot = activeSnapshot;
    });
    registerMachineVoiceClientMediatedCredentialRpcHandlers({
      rpcHandlerManager: registrar,
      getAccountSettingsSnapshot: () => currentSnapshot,
      ensureAccountSettingsSnapshot,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_CLIENT_MEDIATED_CREDENTIAL_MATERIALIZE)?.({
      contribution,
      platform: 'web',
      phase: 'prepare',
      operationId: 'client-auth',
    })).resolves.toEqual({
      ok: true,
      headers: {
        authorization: 'Bearer account-a',
        'chatgpt-account-id': 'account-work',
      },
    });
    expect(materialize).toHaveBeenCalledWith({
      purpose,
      serviceRefs: [service],
      request: materializationRequest,
      signal: expect.any(AbortSignal),
    });
    expect(resolveVoiceProviderRuntimeLifecycle).toHaveBeenCalledWith(contribution);
    expect(ensureAccountSettingsSnapshot).toHaveBeenCalledTimes(1);

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_CLIENT_MEDIATED_CREDENTIAL_MATERIALIZE)?.({
      contribution,
      platform: 'web',
      phase: 'connection',
      operationId: 'client-auth',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_voice_credential_access_unavailable',
    });
    expect(materialize).toHaveBeenCalledTimes(1);
  });
});
