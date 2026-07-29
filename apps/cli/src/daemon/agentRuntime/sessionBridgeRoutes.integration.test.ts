import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RequestError } from '@agentclientprotocol/sdk';
import {
  AgentRuntimeJsonValueV1Schema,
  AgentSessionConversationRollbackRequestV1Schema,
  AgentSessionRuntimeEventV1Schema,
  type AgentSessionStartupInstructionsMarkerV1,
} from '@happier-dev/protocol/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import type {
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeFactory,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type {
  AgentSessionRealtimeLifecycleEvent,
} from '@happier-dev/plugin-sdk/experimental/agent-runtime/realtime';
import { GROK_ACP_RUNTIME_DEFINITION } from '@happier-dev/plugins-grok/agent/acp/definition';
import { requestAcpHistoryExtension } from '@/agent/acp/history/acpHistoryExtensionMethods';
import {
  applyChildAcpReverseOperation,
  type ChildAcpReverseSession,
} from '@/agent/runtime/session/process/agentRuntimeDaemonAcpReverseSessionClient';
import {
  AgentRuntimeDaemonSessionDescriptorV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';
import {
  AgentRuntimeDaemonAcpChildOperationV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonAcpReverseSessionProtocol';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import {
  ProviderConnectionIdSchema,
  readHookEventEnvelopeV1,
  type ProviderRuntimeBindingBasisV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import type {
  ExternalSessionHostOperationOwner,
} from '@/session/external/hostOperationOwner';
import type {
  HostExternalTranscriptFollowEvent,
} from '@/session/external/privateContract';

const runtimeLeaseMock = vi.hoisted(() => ({
  acquire: vi.fn(),
}));
const { loggerDebugMock } = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMock.acquire,
}));
vi.mock('@/ui/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/logger')>();
  return {
    ...actual,
    logger: new Proxy(actual.logger, {
      get(target, property, receiver) {
        if (property === 'debug') return loggerDebugMock;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
});

import { createAgentRuntimeSessionBridgeRoutes } from './sessionBridgeRoutes';

function createEmptyRuntimeAuthorityProjection(pluginId: string) {
  return {
    permissionsByPluginId: new Map([[pluginId, new Set<string>()]]),
    runtimeCapabilitiesByPluginId: new Map([[pluginId, new Set<string>()]]),
    contributes: {},
  };
}

function createEmptyRuntimeAuthorityDescriptor() {
  return {
    permissions: [],
    runtimeCapabilities: [],
  };
}

describe('daemon Agent runtime session bridge route', () => {
  beforeEach(() => {
    runtimeLeaseMock.acquire.mockReset();
    loggerDebugMock.mockClear();
  });

  it('proxies the declared session realtime lifecycle through the held daemon generation', async () => {
    const pluginId = 'happier.agent.realtime-fixture';
    const agentId = 'realtime-fixture';
    const voiceRetirement = new AbortController();
    const terminalListeners = new Set<
      (event: AgentSessionRealtimeLifecycleEvent) => void
    >();
    const realtimeHandle = {
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
      watch(listener: (event: AgentSessionRealtimeLifecycleEvent) => void) {
        terminalListeners.add(listener);
        return {
          dispose() {
            terminalListeners.delete(listener);
          },
        };
      },
      dispose: vi.fn(async () => undefined),
    };
    const inspect = vi.fn(async () => ({
      status: 'available' as const,
      transport: 'webrtc' as const,
    }));
    const start = vi.fn(async () => ({
      status: 'started' as const,
      transport: {
        kind: 'webrtc' as const,
        answerSdp: 'v=0\r\na=answer:daemon-route\r\n',
      },
      handle: realtimeHandle,
    }));
    let exposeRealtimeConversation = true;
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
      send: async () => ({ status: 'admitted' }),
      watch: () => ({ dispose() {} }),
      async dispose() {},
      ...(exposeRealtimeConversation
        ? { realtimeConversation: { inspect, start } }
        : {}),
    }));
    const release = vi.fn(async () => undefined);
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        ...createEmptyRuntimeAuthorityProjection(pluginId),
        agentRuntimesByAgentId: new Map([[agentId, {
          hasPrimaryRuntime: true,
          pluginId,
          pluginVersion: '1.0.0',
          agentId,
          generation: 'generation-1',
          isCurrent: () => true,
          retirementSignal: new AbortController().signal,
          createRuntime: async () => ({ sessions: { open } }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
        resolvePromptAssetBlocks: async () => [],
        resolveContributionRuntimeLifecycle: () => ({
          generation: 'voice-generation-1',
          isCurrent: () => !voiceRetirement.signal.aborted,
          retirementSignal: voiceRetirement.signal,
        }),
        contributes: {
          voiceProviders: [{
            pluginId,
            identity: { pluginId, localId: 'realtime-fixture' },
            manifestDigest: 'manifest:realtime-fixture',
            definition: {
              id: 'realtime-fixture',
              title: 'Realtime fixture',
              kind: 'conversation',
              roles: ['realtime_conversation'],
              platforms: ['web'],
              capabilities: {
                readiness: { requirements: [] },
                turn: { cancelResponse: false, bargeIn: false },
              },
              execution: {
                kind: 'experimental_agent_session_realtime',
                agent: { pluginId, localId: agentId },
              },
              settings: {
                schemaVersion: 2,
                fields: [],
                connectedServicesBinding: {
                  id: 'account',
                  title: 'Account',
                  agent: { pluginId, localId: agentId },
                  serviceIds: ['openai-codex'],
                },
              },
              client: {
                artifactId: 'realtime-fixture',
                modulePath: './voice',
                exportName: 'activate',
              },
            },
          }],
        },
        hookHandlersByHookId: new Map(),
        readHookEventEnvelopeV1,
      },
      release,
    });
    const routes = createAgentRuntimeSessionBridgeRoutes({});
    const descriptor = AgentRuntimeDaemonSessionDescriptorV1Schema.parse({
      v: 1 as const,
      pluginId,
      pluginVersion: '1.0.0',
      agentId,
      backendId: agentId,
      generation: 'generation-1',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      runtimeSurfaces: {
        terminal: false,
        realtimeConversation: {
          providers: [{
            identity: { pluginId, localId: 'realtime-fixture' },
            manifestDigest: 'manifest:realtime-fixture',
            generation: 'voice-generation-1',
            declaration: {
              id: 'realtime-fixture',
              title: 'Realtime fixture',
              kind: 'conversation',
              roles: ['realtime_conversation'],
              platforms: ['web'],
              capabilities: {
                readiness: { requirements: [] },
                turn: { cancelResponse: false, bargeIn: false },
              },
              execution: {
                kind: 'experimental_agent_session_realtime',
                agent: { pluginId, localId: agentId },
              },
              settings: {
                schemaVersion: 2,
                fields: [],
                connectedServicesBinding: {
                  id: 'account',
                  title: 'Account',
                  agent: { pluginId, localId: agentId },
                  serviceIds: ['openai-codex'],
                },
              },
              client: {
                artifactId: 'realtime-fixture',
                modulePath: './voice',
                exportName: 'activate',
              },
            },
          }],
        },
      },
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    });
    const context = {
      token: 'bridge-token',
      sessionId: 'session-realtime',
      pluginId,
      agentId,
      generation: 'generation-1',
    };
    const request = {
      kind: 'create' as const,
      sessionId: context.sessionId,
      cwd: '/workspace',
    };
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-realtime',
        descriptor,
        request,
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.open',
        requestId: 'open-realtime',
        descriptor,
        request,
        featureDecisions: {},
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.inspect',
        requestId: 'inspect-realtime',
        provider: {
          identity: { pluginId, localId: 'realtime-fixture' },
          generation: 'voice-generation-1',
        },
      },
    })).resolves.toEqual({
      ok: true,
      result: { status: 'available', transport: 'webrtc' },
    });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.inspect',
        requestId: 'inspect-realtime-stale-provider',
        provider: {
          identity: { pluginId, localId: 'realtime-fixture' },
          generation: 'voice-generation-stale',
        },
      },
    })).resolves.toEqual({
      ok: true,
      result: {
        status: 'unavailable',
        reason: 'feature_unavailable',
        diagnostic: {
          code: 'agent_realtime_provider_authority_stale',
          severity: 'info',
        },
      },
    });
    const started = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.start',
        requestId: 'start-realtime',
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=offer:daemon-route\r\n',
        },
        provider: {
          identity: { pluginId, localId: 'realtime-fixture' },
          generation: 'voice-generation-1',
        },
      },
    });
    if (
      !started.ok
      || typeof started.result !== 'object'
      || started.result === null
      || !('handleId' in started.result)
      || typeof started.result.handleId !== 'string'
    ) {
      throw new Error('Expected daemon realtime handle id');
    }
    const watch = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.handle.watch',
        requestId: 'watch-realtime',
        handleId: started.result.handleId,
      },
    });
    for (const listener of terminalListeners) {
      listener({ kind: 'terminal', reason: 'upstream_closed' });
    }
    await expect(watch).resolves.toEqual({
      ok: true,
      result: { kind: 'terminal', reason: 'upstream_closed' },
    });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.handle.stop',
        requestId: 'stop-realtime',
        handleId: started.result.handleId,
      },
    })).resolves.toEqual({
      ok: true,
      result: { status: 'stopped' },
    });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.handle.dispose',
        requestId: 'dispose-realtime',
        handleId: started.result.handleId,
      },
    })).resolves.toEqual({ ok: true, result: null });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(realtimeHandle.stop).toHaveBeenCalledTimes(1);
    expect(realtimeHandle.dispose).toHaveBeenCalledTimes(1);

    const explicitlyDisposedStarted = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.start',
        requestId: 'start-realtime-explicit-dispose',
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=offer:explicit-dispose\r\n',
        },
        provider: {
          identity: { pluginId, localId: 'realtime-fixture' },
          generation: 'voice-generation-1',
        },
      },
    });
    if (
      !explicitlyDisposedStarted.ok
      || typeof explicitlyDisposedStarted.result !== 'object'
      || explicitlyDisposedStarted.result === null
      || !('handleId' in explicitlyDisposedStarted.result)
      || typeof explicitlyDisposedStarted.result.handleId !== 'string'
    ) {
      throw new Error('Expected explicit-disposal realtime handle id');
    }
    const explicitDisposeWatch = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.handle.watch',
        requestId: 'watch-realtime-explicit-dispose',
        handleId: explicitlyDisposedStarted.result.handleId,
      },
    });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.handle.dispose',
        requestId: 'dispose-realtime-explicit',
        handleId: explicitlyDisposedStarted.result.handleId,
      },
    })).resolves.toEqual({ ok: true, result: null });
    await expect(explicitDisposeWatch).resolves.toEqual({
      ok: true,
      result: { kind: 'terminal', reason: 'aborted' },
    });

    const parentDisposeContext = {
      ...context,
      sessionId: 'session-realtime-parent-dispose',
    };
    const parentDisposeRequest = {
      ...request,
      sessionId: parentDisposeContext.sessionId,
    };
    await expect(routes.dispatch({
      v: 1,
      context: parentDisposeContext,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-realtime-parent-dispose',
        descriptor,
        request: parentDisposeRequest,
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context: parentDisposeContext,
      operation: {
        kind: 'session.open',
        requestId: 'open-realtime-parent-dispose',
        descriptor,
        request: parentDisposeRequest,
        featureDecisions: {},
      },
    })).resolves.toMatchObject({ ok: true });
    const parentDisposedStarted = await routes.dispatch({
      v: 1,
      context: parentDisposeContext,
      operation: {
        kind: 'runtime.realtimeConversation.start',
        requestId: 'start-realtime-parent-dispose',
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=offer:parent-dispose\r\n',
        },
        provider: {
          identity: { pluginId, localId: 'realtime-fixture' },
          generation: 'voice-generation-1',
        },
      },
    });
    if (
      !parentDisposedStarted.ok
      || typeof parentDisposedStarted.result !== 'object'
      || parentDisposedStarted.result === null
      || !('handleId' in parentDisposedStarted.result)
      || typeof parentDisposedStarted.result.handleId !== 'string'
    ) {
      throw new Error('Expected parent-disposal realtime handle id');
    }
    const parentDisposeWatch = routes.dispatch({
      v: 1,
      context: parentDisposeContext,
      operation: {
        kind: 'runtime.realtimeConversation.handle.watch',
        requestId: 'watch-realtime-parent-dispose',
        handleId: parentDisposedStarted.result.handleId,
      },
    });
    await expect(routes.dispatch({
      v: 1,
      context: parentDisposeContext,
      operation: {
        kind: 'session.dispose',
        requestId: 'dispose-session-realtime-parent',
        reason: 'session_closed',
      },
    })).resolves.toEqual({ ok: true, result: null });
    await expect(parentDisposeWatch).resolves.toEqual({
      ok: true,
      result: {
        kind: 'terminal',
        reason: 'agent_session_disposed',
      },
    });
    expect(realtimeHandle.dispose).toHaveBeenCalledTimes(3);

    exposeRealtimeConversation = false;
    const unavailableContext = {
      ...context,
      sessionId: 'session-realtime-unavailable',
    };
    const unavailableRequest = {
      ...request,
      sessionId: unavailableContext.sessionId,
    };
    await expect(routes.dispatch({
      v: 1,
      context: unavailableContext,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-realtime-unavailable',
        descriptor,
        request: unavailableRequest,
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context: unavailableContext,
      operation: {
        kind: 'session.open',
        requestId: 'open-realtime-unavailable',
        descriptor,
        request: unavailableRequest,
        featureDecisions: {},
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context: unavailableContext,
      operation: {
        kind: 'runtime.realtimeConversation.inspect',
        requestId: 'inspect-realtime-unavailable',
        provider: {
          identity: { pluginId, localId: 'realtime-fixture' },
          generation: 'voice-generation-1',
        },
      },
    })).resolves.toEqual({
      ok: true,
      result: {
        status: 'unavailable',
        reason: 'unsupported_runtime',
        diagnostic: {
          code: 'agent_realtime_runtime_unavailable',
          severity: 'info',
        },
      },
    });

    const retiringStarted = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.start',
        requestId: 'start-realtime-provider-retirement',
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=offer:provider-retirement\r\n',
        },
        provider: {
          identity: { pluginId, localId: 'realtime-fixture' },
          generation: 'voice-generation-1',
        },
      },
    });
    if (
      !retiringStarted.ok
      || typeof retiringStarted.result !== 'object'
      || retiringStarted.result === null
      || !('handleId' in retiringStarted.result)
      || typeof retiringStarted.result.handleId !== 'string'
    ) {
      throw new Error('Expected provider-retirement realtime handle id');
    }
    const retirementWatch = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.handle.watch',
        requestId: 'watch-realtime-provider-retirement',
        handleId: retiringStarted.result.handleId,
      },
    });
    voiceRetirement.abort('provider_retired');
    await expect(retirementWatch).resolves.toEqual({
      ok: true,
      result: {
        kind: 'terminal',
        reason: 'aborted',
        diagnostic: {
          code: 'agent_realtime_provider_retired',
          severity: 'info',
        },
      },
    });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.handle.dispose',
        requestId: 'dispose-realtime-provider-retirement',
        handleId: retiringStarted.result.handleId,
      },
    })).resolves.toEqual({ ok: true, result: null });
    expect(realtimeHandle.dispose).toHaveBeenCalledTimes(4);

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.dispose',
        requestId: 'dispose-session-realtime',
        reason: 'session_closed',
      },
    })).resolves.toEqual({ ok: true, result: null });
    await expect(routes.dispatch({
      v: 1,
      context: unavailableContext,
      operation: {
        kind: 'session.dispose',
        requestId: 'dispose-session-realtime-unavailable',
        reason: 'session_closed',
      },
    })).resolves.toEqual({ ok: true, result: null });
  });

  it('resolves defaulted and explicit prompt assets plus tool prompts through the held daemon generation', async () => {
    let current = true;
    const resolvePromptAssetBlocks = vi.fn(async (params: Readonly<{
      selectedAsset?: Readonly<{ pluginId: string; localId: string }>;
    }>) => Object.freeze([{
      id: params.selectedAsset
        ? `prompt_asset.${params.selectedAsset.pluginId}.${params.selectedAsset.localId}`
        : 'prompt_asset.default',
      scope: 'session' as const,
      text: params.selectedAsset ? 'Explicit asset' : 'Default asset',
    }]));
    const release = vi.fn(async () => undefined);
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
      send: async () => ({ status: 'admitted' }),
      watch: () => ({ dispose() {} }),
      async dispose() {},
    }));
    const transformHandler = vi.fn(async (event: Readonly<{
      payload: Readonly<Record<string, unknown>>;
    }>) => ({
      ...event.payload,
      prompt: `${String(event.payload.prompt)} [daemon transform]`,
    }));
    const sessionInputTransformHandler = vi.fn(async (event: Readonly<{
      payload: Readonly<Record<string, unknown>>;
    }>) => ({
      ...event.payload,
      text: `${String(event.payload.text)} [daemon input transform]`,
    }));
    const hookRegistration = {
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId: 'happier.hooks.prompt',
      manifestPath: '/plugins/happier.hooks.prompt/plugin.json',
      manifestDigest: 'sha256:hook',
      daemonEntryPath: '/plugins/happier.hooks.prompt/daemon.mjs',
      sourceSpec: {
        kind: 'path' as const,
        locator: '/plugins/happier.hooks.prompt',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
      },
      definition: {
        hookApiVersion: 1 as const,
        id: 'agent.context.before' as const,
        category: 'augmentation' as const,
        scope: 'agent' as const,
        executionKind: 'augment' as const,
        handler: {
          target: 'plugin' as const,
          exportName: 'transform',
        },
      },
    };
    const lease = {
      registry: {
        ...createEmptyRuntimeAuthorityProjection('happier.agent.novel-reviewer'),
        agentRuntimesByAgentId: new Map([['novel-reviewer', {
          hasPrimaryRuntime: true,
          pluginId: 'happier.agent.novel-reviewer',
          pluginVersion: '1.2.3',
          agentId: 'novel-reviewer',
          generation: 'generation-1',
          isCurrent: () => current,
          retirementSignal: new AbortController().signal,
          createRuntime: async () => ({ sessions: { open } }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
        resolvePromptAssetBlocks,
        contributes: {
          tools: [{
            definition: {
              id: 'inspect',
              name: 'inspect',
              title: 'Inspect',
              promptSnippet: 'Inspect before changing.',
              promptGuidelines: ['Keep evidence bounded.'],
            },
          }],
        },
        hookHandlersByHookId: new Map([[
          'agent.context.before',
          [{
            pluginId: hookRegistration.pluginId,
            hookId: hookRegistration.definition.id,
            priority: 0,
            registrationIndex: 0,
            manifestPath: hookRegistration.manifestPath,
            manifestDigest: hookRegistration.manifestDigest,
            daemonEntryPath: hookRegistration.daemonEntryPath,
            exportName: 'transform',
            registration: hookRegistration,
            handler: transformHandler,
          }],
        ], [
          'session.input.transform',
          [{
            pluginId: hookRegistration.pluginId,
            hookId: 'session.input.transform',
            priority: 0,
            registrationIndex: 1,
            manifestPath: hookRegistration.manifestPath,
            manifestDigest: hookRegistration.manifestDigest,
            daemonEntryPath: hookRegistration.daemonEntryPath,
            registration: {
              ...hookRegistration,
              definition: {
                ...hookRegistration.definition,
                id: 'session.input.transform' as const,
                scope: 'session' as const,
              },
            },
            handler: sessionInputTransformHandler,
          }],
        ]]),
        readHookEventEnvelopeV1,
      },
      release,
    };
    runtimeLeaseMock.acquire.mockResolvedValue(lease);
    const connectionId =
      ProviderConnectionIdSchema.parse('pc_bridge-route');
    const selection = {
      agentTargetKey: 'backend:novel-reviewer',
      providerConnectionId: connectionId,
      modelId: 'model-next',
    } as const;
    const runtimeBindingBasis = {
      v: 1,
      deployment: { kind: 'external' },
      agentTargetKey: selection.agentTargetKey,
      connectionId,
      contributionKey: 'provider.test',
      endpoint: {
        endpointTemplateId: 'responses',
        normalizedUrl: 'https://provider.example/v1',
        protocol: 'openai-responses',
        publicHeaders: {},
      },
      runtimeCredentialTransport: {
        id: 'bearer',
        protocols: ['openai-responses'],
        uses: ['runtime'],
        destination: {
          kind: 'httpHeader',
          name: 'authorization',
          format: 'bearer',
        },
      },
      prepared: { v: 1, materialization: 'spawnEnv' },
      adapterVersion: 1,
      credentialAuthorization: {
        connectionSecurityFingerprint: 'connection-security',
        grantFingerprint: 'grant',
        selectedSecretBindingId: 'secret-a',
        selectedSecretRecordFingerprint: 'secret-record-a',
      },
      agentSupport: {
        acceptsProtocols: ['openai-responses'],
        required: { streaming: true },
        credentialSupport: {
          supportsNoAuth: false,
          apiKeyTransports: [{
            protocol: 'openai-responses',
            destination: {
              kind: 'httpHeader',
              names: ['authorization'],
              formats: ['bearer'],
            },
          }],
        },
        authIsolation: {
          suppressConnectedServiceIds: [],
          ownedEnvKeys: [],
        },
        materialization: 'spawnEnv',
        applyPolicy: 'live',
        supportsFreeformModelIds: true,
      },
    } satisfies ProviderRuntimeBindingBasisV1;
    const sessionBindingMetadata = {
      v: 1,
      connectionId,
      contributionKey: 'provider.test',
      connectionRevision: 1,
      model: { id: selection.modelId, name: 'Model Next' },
      protocol: 'openai-responses',
      materialization: 'spawnEnv',
      compatibilityFingerprint: 'compatibility',
      bindingSecurityFingerprint: 'binding-security',
      runtimeBindingBasis,
      displaySnapshot: {
        providerName: 'Provider',
        connectionName: 'Connection',
        connectionRole: 'default',
        connectionDisplayNameMode: 'automatic',
      },
    } satisfies SessionProviderBindingMetadataV1;
    const authorization = {
      selection,
      policy: 'live' as const,
      model: sessionBindingMetadata.model!,
      sessionBindingMetadata,
      runtimeBindingBasis,
    };
    const authorizeProviderModelTransition =
      vi.fn(async () => authorization);
    const routes = createAgentRuntimeSessionBridgeRoutes({
      authorizeProviderModelTransition,
    });
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.novel-reviewer',
      pluginVersion: '1.2.3',
      agentId: 'novel-reviewer',
      backendId: 'novel-reviewer',
      generation: 'generation-1',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: 'session-turn-contributions',
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-turn-contributions',
        descriptor,
        request: {
          kind: 'create',
          sessionId: context.sessionId,
          cwd: '/workspace',
        },
      },
    })).resolves.toMatchObject({ ok: true });

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.modelTransition.authorize',
        requestId: 'authorize-provider-model-transition',
        selection,
      },
    })).resolves.toEqual({
      ok: true,
      result: authorization,
    });
    expect(authorizeProviderModelTransition)
      .toHaveBeenCalledExactlyOnceWith({
        sessionId: context.sessionId,
        agentId: context.agentId,
        lease,
        selection,
      });
    expect(authorization).not.toHaveProperty('providerBinding');
    expect(authorization).not.toHaveProperty('materialization');

    const defaulted = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.turnContributions.resolve',
        requestId: 'resolve-defaulted-prompt',
        request: {
          kind: 'prompt',
          machineId: 'machine-1',
          featureIds: ['execution.runs'],
        },
      },
    });
    expect(defaulted).toMatchObject({
      ok: true,
      result: {
        promptAssetBlocks: [{ id: 'prompt_asset.default', text: 'Default asset' }],
        toolPromptContributions: [{
          id: 'inspect',
          promptSnippet: 'Inspect before changing.',
        }],
      },
    });

    const explicit = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.turnContributions.resolve',
        requestId: 'resolve-explicit-prompt',
        request: {
          kind: 'prompt',
          selectedAsset: {
            pluginId: 'happier.review.deepsec',
            localId: 'review-prompt',
          },
        },
      },
    });
    expect(explicit).toMatchObject({
      ok: true,
      result: {
        promptAssetBlocks: [{
          id: 'prompt_asset.happier.review.deepsec.review-prompt',
          text: 'Explicit asset',
        }],
      },
    });
    expect(resolvePromptAssetBlocks).toHaveBeenNthCalledWith(1, expect.objectContaining({
      agentId: 'novel-reviewer',
      sessionId: context.sessionId,
      machineId: 'machine-1',
      featureIds: ['execution.runs'],
      signal: expect.any(AbortSignal),
    }));
    expect(resolvePromptAssetBlocks).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agentId: 'novel-reviewer',
      selectedAsset: {
        pluginId: 'happier.review.deepsec',
        localId: 'review-prompt',
      },
      signal: expect.any(AbortSignal),
    }));

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.turnContributions.resolve',
        requestId: 'transform-agent-context',
        request: {
          kind: 'transformAgentContext',
          payload: {
            sessionId: context.sessionId,
            agentId: descriptor.agentId,
            runtimeFamily: 'hostSession',
            prompt: 'Original',
            messages: [{ role: 'user', content: 'Original' }],
            timestampMs: 1,
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'transformAgentContext',
        payload: { prompt: 'Original [daemon transform]' },
      },
    });
    expect(transformHandler).toHaveBeenCalledOnce();

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.turnContributions.resolve',
        requestId: 'transform-session-input',
        request: {
          kind: 'transformSessionInput',
          payload: {
            sessionId: context.sessionId,
            localId: 'input-1',
            text: 'Original input',
            meta: {},
            timestampMs: 2,
          },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'transformSessionInput',
        payload: { text: 'Original input [daemon input transform]' },
      },
    });
    expect(sessionInputTransformHandler).toHaveBeenCalledOnce();

    current = false;
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.modelTransition.authorize',
        requestId: 'authorize-retired-provider-model-transition',
        selection,
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'plugin_generation_stale' },
    });
    expect(authorizeProviderModelTransition).toHaveBeenCalledOnce();

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.turnContributions.resolve',
        requestId: 'resolve-retired-prompt',
        request: { kind: 'prompt' },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'plugin_generation_stale' },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('dispatches native runtime stream deltas through the held daemon plugin generation', async () => {
    let runtimeListener: Parameters<AgentSessionRuntime['watch']>[0] | null = null;
    let releaseFirstToken!: () => void;
    const firstTokenGate = new Promise<void>((resolve) => {
      releaseFirstToken = resolve;
    });
    const completedTokenTexts: string[] = [];
    const streamHandler = vi.fn(async (event: Readonly<{
      payload: Readonly<Record<string, unknown>>;
    }>) => {
      const tokenText = String(event.payload.tokenText);
      if (tokenText === 'considering') await firstTokenGate;
      completedTokenTexts.push(tokenText);
    });
    const release = vi.fn(async () => undefined);
    const readHookEventEnvelope = vi.fn(readHookEventEnvelopeV1);
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
      send: async () => ({ status: 'admitted' }),
      watch(listener) {
        runtimeListener = listener;
        return { dispose() {} };
      },
      async dispose() {},
    }));
    const hookRegistration = {
      provenance: 'external' as const,
      source: { kind: 'path' as const },
      pluginId: 'happier.hooks.stream-observer',
      manifestPath: '/plugins/happier.hooks.stream-observer/plugin.json',
      manifestDigest: 'sha256:stream-hook',
      daemonEntryPath: '/plugins/happier.hooks.stream-observer/daemon.mjs',
      sourceSpec: {
        kind: 'path' as const,
        locator: '/plugins/happier.hooks.stream-observer',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
      },
      definition: {
        hookApiVersion: 1 as const,
        id: 'agent.stream.token' as const,
        category: 'lifecycle' as const,
        scope: 'agent' as const,
        executionKind: 'observe' as const,
        purity: 'observer' as const,
        supportedRuntimes: ['hostSession'] as const,
      },
    };
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        ...createEmptyRuntimeAuthorityProjection('happier.agent.novel-reviewer'),
        agentRuntimesByAgentId: new Map([['novel-reviewer', {
          hasPrimaryRuntime: true,
          pluginId: 'happier.agent.novel-reviewer',
          pluginVersion: '1.2.3',
          agentId: 'novel-reviewer',
          generation: 'generation-stream',
          isCurrent: () => true,
          retirementSignal: new AbortController().signal,
          createRuntime: async () => ({ sessions: { open } }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
        hookHandlersByHookId: new Map([[
          'agent.stream.token',
          [{
            pluginId: hookRegistration.pluginId,
            hookId: hookRegistration.definition.id,
            priority: 0,
            registrationIndex: 0,
            manifestPath: hookRegistration.manifestPath,
            manifestDigest: hookRegistration.manifestDigest,
            daemonEntryPath: hookRegistration.daemonEntryPath,
            registration: hookRegistration,
            handler: streamHandler,
          }],
        ]]),
        readHookEventEnvelopeV1: readHookEventEnvelope,
      },
      release,
    });
    const routes = createAgentRuntimeSessionBridgeRoutes();
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.novel-reviewer',
      pluginVersion: '1.2.3',
      agentId: 'novel-reviewer',
      backendId: 'novel-reviewer',
      generation: 'generation-stream',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: 'session-stream',
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };
    const request = {
      kind: 'create' as const,
      sessionId: context.sessionId,
      cwd: '/workspace',
    };

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-stream',
        descriptor,
        request,
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.open',
        requestId: 'open-stream',
        descriptor,
        request,
        featureDecisions: {},
      },
    })).resolves.toMatchObject({ ok: true });
    const emitRuntimeEvent =
      runtimeListener as Parameters<AgentSessionRuntime['watch']>[0] | null;
    if (!emitRuntimeEvent) throw new Error('Expected the daemon runtime watcher');

    emitRuntimeEvent({
      sequence: 0,
      sessionId: context.sessionId,
      emittedAtMs: 42,
      kind: 'message-delta',
      turnId: 'turn-stream',
      channel: 'reasoning',
      text: 'considering',
    });
    emitRuntimeEvent({
      sequence: 1,
      sessionId: context.sessionId,
      emittedAtMs: 43,
      kind: 'message-delta',
      turnId: 'turn-stream',
      channel: 'assistant',
      text: 'answering',
    });

    await vi.waitFor(() => expect(streamHandler).toHaveBeenCalled());
    expect(streamHandler).toHaveBeenCalledOnce();
    expect(streamHandler).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        eventId: 'agent.stream.token',
        agentId: descriptor.agentId,
        happySessionId: context.sessionId,
        turnId: 'turn-stream',
        payload: {
          sessionId: context.sessionId,
          agentId: descriptor.agentId,
          runtimeFamily: 'hostSession',
          turnId: 'turn-stream',
          tokenText: 'considering',
          streamKind: 'thinking',
          timestampMs: 42,
        },
      }),
      expect.any(Object),
    );

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-stream',
        afterSequence: -1,
      },
    })).resolves.toMatchObject({
      ok: true,
      result: {
        events: [
          expect.objectContaining({
            kind: 'message-delta',
            text: 'considering',
          }),
          expect.objectContaining({
            kind: 'message-delta',
            text: 'answering',
          }),
        ],
      },
    });
    expect(completedTokenTexts).toEqual([]);

    releaseFirstToken();
    await vi.waitFor(() => expect(streamHandler).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(completedTokenTexts).toEqual([
      'considering',
      'answering',
    ]));

    streamHandler.mockRejectedValueOnce(new Error('hook rejected'));
    emitRuntimeEvent({
      sequence: 2,
      sessionId: context.sessionId,
      emittedAtMs: 44,
      kind: 'message-delta',
      turnId: 'turn-stream',
      channel: 'assistant',
      text: 'private hook rejection trigger',
    });
    await vi.waitFor(() => {
      expect(loggerDebugMock).toHaveBeenCalledWith(
        '[plugins] Plugin hook handler failed',
        {
          error: 'plugin_hook_handler_failed',
          hookId: 'agent.stream.token',
          pluginId: hookRegistration.pluginId,
        },
      );
    });
    expect(streamHandler).toHaveBeenCalledTimes(3);

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.dispose',
        requestId: 'dispose-stream',
        reason: 'session_closed',
      },
    })).resolves.toMatchObject({ ok: true });
    emitRuntimeEvent({
      sequence: 3,
      sessionId: context.sessionId,
      emittedAtMs: 45,
      kind: 'message-delta',
      turnId: 'turn-stream',
      channel: 'assistant',
      text: 'after disposal',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(streamHandler).toHaveBeenCalledTimes(3);
  });

  it('snapshots and freezes validated host startup instructions before runtime invocation', async () => {
    let receivedStartupInstructionsFrozen = false;
    let mutationApplied: boolean | undefined;
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(async (runtimeRequest) => {
      if (runtimeRequest.kind === 'fork' || !runtimeRequest.startupInstructions) {
        throw new Error('Expected startup instructions on create');
      }
      receivedStartupInstructionsFrozen = Object.isFrozen(
        runtimeRequest.startupInstructions,
      );
      mutationApplied = Reflect.set(
        runtimeRequest.startupInstructions,
        'revision',
        999,
      );
      return {
        send: async () => ({ status: 'admitted' }),
        watch: () => ({ dispose() {} }),
        async dispose() {},
      };
    });
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        ...createEmptyRuntimeAuthorityProjection('happier.agent.codex'),
        agentRuntimesByAgentId: new Map([['codex', {
          hasPrimaryRuntime: true,
          pluginId: 'happier.agent.codex',
          pluginVersion: '1.2.3',
          agentId: 'codex',
          generation: 'generation-1',
          startupInstructionsVersions: [1],
          isCurrent: () => true,
          retirementSignal: new AbortController().signal,
          createRuntime: async () => ({ sessions: { open } }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
      },
      release: vi.fn(async () => undefined),
    });
    const startupInstructionsSentinel = 'Global Voice developer instructions.';
    const startupInstructions = {
      v: 1 as const,
      id: 'happier.global_voice_agent',
      revision: 1,
      instructions: startupInstructionsSentinel,
    };
    let finishStartupInstructionsMarkerPersistence!: () => void;
    const startupInstructionsMarkerPersistence = new Promise<void>(
      (resolve) => {
        finishStartupInstructionsMarkerPersistence = resolve;
      },
    );
    const onStartupInstructionsApplied = vi.fn(async (
      _sessionId: string,
      _marker: AgentSessionStartupInstructionsMarkerV1,
    ) => {
      await startupInstructionsMarkerPersistence;
    });
    const routes = createAgentRuntimeSessionBridgeRoutes({
      resolveStartupInstructions: () => startupInstructions,
      onStartupInstructionsApplied,
    });
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.2.3',
      agentId: 'codex',
      backendId: 'codex',
      generation: 'generation-1',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: 'session-startup',
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };
    const request = {
      kind: 'create' as const,
      sessionId: context.sessionId,
      cwd: '/workspace',
    };

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-startup',
        descriptor,
        request,
      },
    })).resolves.toMatchObject({ ok: true });
    let openSettled = false;
    const openResponse = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.open',
        requestId: 'open-startup',
        descriptor,
        request,
        featureDecisions: {},
      },
    }).finally(() => {
      openSettled = true;
    });
    await vi.waitFor(() => {
      expect(onStartupInstructionsApplied).toHaveBeenCalledTimes(1);
    });
    expect(openSettled).toBe(false);
    finishStartupInstructionsMarkerPersistence();
    await expect(openResponse).resolves.toMatchObject({ ok: true });

    expect(open).toHaveBeenCalledWith(
      { ...request, startupInstructions },
      expect.any(Object),
    );
    expect(receivedStartupInstructionsFrozen).toBe(true);
    expect(mutationApplied).toBe(false);
    expect(onStartupInstructionsApplied).toHaveBeenCalledWith(
      context.sessionId,
      {
        v: 1,
        id: startupInstructions.id,
        revision: startupInstructions.revision,
      },
    );
    const appliedMarker = onStartupInstructionsApplied.mock.calls[0]?.[1];
    expect(Object.isFrozen(appliedMarker)).toBe(true);
    expect(JSON.stringify(appliedMarker)).not.toContain(
      startupInstructionsSentinel,
    );
  });

  it('fails before runtime invocation when startup instructions are unsupported', async () => {
    const open = vi.fn<AgentSessionRuntimeFactory['open']>();
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        ...createEmptyRuntimeAuthorityProjection('happier.agent.other'),
        agentRuntimesByAgentId: new Map([['other', {
          hasPrimaryRuntime: true,
          pluginId: 'happier.agent.other',
          pluginVersion: '1.0.0',
          agentId: 'other',
          generation: 'generation-1',
          isCurrent: () => true,
          retirementSignal: new AbortController().signal,
          createRuntime: async () => ({ sessions: { open } }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
      },
      release: vi.fn(async () => undefined),
    });
    const routes = createAgentRuntimeSessionBridgeRoutes({
      resolveStartupInstructions: () => ({
        v: 1,
        id: 'happier.global_voice_agent',
        revision: 1,
        instructions: 'Global Voice developer instructions.',
      }),
    });
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.other',
      pluginVersion: '1.0.0',
      agentId: 'other',
      backendId: 'other',
      generation: 'generation-1',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };

    await expect(routes.dispatch({
      v: 1,
      context: {
        token: 'bridge-token',
        sessionId: 'session-unsupported',
        pluginId: descriptor.pluginId,
        agentId: descriptor.agentId,
        generation: descriptor.generation,
      },
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-unsupported',
        descriptor,
        request: {
          kind: 'create',
          sessionId: 'session-unsupported',
          cwd: '/workspace',
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        message: 'Selected Agent runtime does not support startup instructions',
      },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('activates one daemon runtime and opens ACP exactly once through the child effect', async () => {
    let current = true;
    let daemonAcpRuntime: AgentSessionRuntime | undefined;
    const completionEvidenceAdmissions: boolean[] = [];
    let retainedCompletionEvidenceSubmit: (() => boolean) | undefined;
    const watch = vi.fn<AgentSessionRuntime['watch']>(() => ({
      dispose: vi.fn(),
    }));
    const send: AgentSessionRuntime['send'] = async () => ({
      status: 'admitted',
    });
    const childBackedRuntime: AgentSessionRuntime = Object.freeze({
      send,
      watch,
      async dispose() {},
    });
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(
      async (request, context) => {
        daemonAcpRuntime = await context.protocols.acp.open(request, {
          transport: {
            kind: 'stdio',
            executable: { kind: 'systemTool', id: 'agent-acp' },
          },
          definition: GROK_ACP_RUNTIME_DEFINITION,
          extensions: {
            notifications: {
              'x.test/session/prompt_complete': (params, extensionContext) => {
                if (!extensionContext.currentTurn) {
                  throw new Error('Expected a current-turn completion handle');
                }
                const evidence = {
                  providerSessionId: 'provider-session-1',
                  promptId: extensionContext.currentTurn.turnId,
                  outcome: { kind: 'completed' as const },
                };
                const mode = z.object({
                  mode: z.enum(['retain', 'duplicate']),
                }).passthrough().safeParse(params).data?.mode;
                if (mode === 'retain') {
                  retainedCompletionEvidenceSubmit = () =>
                    extensionContext.currentTurn!.submitCompletionEvidence(evidence);
                  return;
                }
                if (mode === 'duplicate') {
                  completionEvidenceAdmissions.push(
                    extensionContext.currentTurn.submitCompletionEvidence(evidence),
                  );
                  return;
                }
                completionEvidenceAdmissions.push(
                  extensionContext.currentTurn.submitCompletionEvidence({
                    ...evidence,
                    providerSessionId: 'foreign-provider-session',
                  }),
                  extensionContext.currentTurn.submitCompletionEvidence({
                    ...evidence,
                    promptId: 'foreign-turn',
                  }),
                  extensionContext.currentTurn.submitCompletionEvidence({
                    ...evidence,
                    outcome: { kind: 'future' as never },
                  }),
                  extensionContext.currentTurn.submitCompletionEvidence(evidence),
                  extensionContext.currentTurn.submitCompletionEvidence(evidence),
                );
              },
            },
          },
        });
        return childBackedRuntime;
      },
    );
    const createRuntime = vi.fn(async () => ({
      sessions: Object.freeze({ open }),
    }));
    const release = vi.fn(async () => undefined);
    const releaseManagedExecutable = vi.fn();
    const resolveSystemTool = vi.fn(async () => Object.freeze({
      grantId: 'agent-acp-grant',
      toolId: 'agent-acp',
      displayName: 'Agent ACP',
      source: 'system' as const,
      executablePath: '/resolved/bin/agent-acp',
      launch: Object.freeze({
        kind: 'binary' as const,
        executablePath: '/resolved/bin/agent-acp',
        args: Object.freeze(['--resolved-prefix']),
        env: Object.freeze({ RESOLVED_ACP: '1' }),
      }),
    }));
    const exec = createStablePluginExecService({
      allowedExecutables: [
        { kind: 'systemTool', id: 'agent-acp' },
        { kind: 'managedDependency', id: 'managed-acp' },
      ],
      signal: new AbortController().signal,
      isGenerationCurrent: () => current,
      async resolveExecutable(executable) {
        expect(executable).toEqual({
          kind: 'managedDependency',
          id: 'managed-acp',
        });
        return Object.freeze({
          command: '/resolved/bin/managed-acp',
          args: ['serve'],
          env: { MANAGED_ACP: '1' },
          release: releaseManagedExecutable,
        });
      },
      async resolvePath() {
        throw new Error('Path resolution was not expected');
      },
      systemTools: Object.freeze({
        resolve: resolveSystemTool,
      }),
    });
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        ...createEmptyRuntimeAuthorityProjection('happier.agent.grok'),
        agentRuntimesByAgentId: new Map([[
          'grok',
          {
            hasPrimaryRuntime: true,
            pluginId: 'happier.agent.grok',
            pluginVersion: '1.2.3',
            agentId: 'grok',
            generation: 'generation-7',
            immutableGenerationId: 'sha256:abc',
            isCurrent: () => current,
            retirementSignal: new AbortController().signal,
            createRuntime,
          },
        ]]),
        createAgentInvocationServices: () => Object.freeze({ exec }),
      },
      release,
    });
    const routes = createAgentRuntimeSessionBridgeRoutes();
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'generation-7',
      immutableGenerationId: 'sha256:abc',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: 'session-1',
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };
    const request = {
      kind: 'create' as const,
      sessionId: 'session-1',
      cwd: '/workspace',
    };

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-1',
        descriptor,
        request,
      },
    })).resolves.toMatchObject({ ok: true });

    const opening = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.open',
        requestId: 'open-1',
        descriptor,
        request,
        featureDecisions: {},
      },
    });
    const poll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-1',
        afterSequence: -1,
      },
    });
    expect(poll).toMatchObject({
      ok: true,
      result: {
        effects: [{
          kind: 'acp.session.open',
          options: {
            resolvedExecutable: {
              kind: 'systemTool',
              toolId: 'agent-acp',
              command: '/resolved/bin/agent-acp',
              args: ['--resolved-prefix'],
              env: { RESOLVED_ACP: '1' },
            },
          },
        }],
      },
    });
    expect(resolveSystemTool).toHaveBeenCalledWith({
      toolId: 'agent-acp',
      purpose: 'agent-acp:grok',
      cwd: '/workspace',
      preferredPath: undefined,
      signal: expect.any(AbortSignal),
    });
    if (!poll.ok) throw new Error('Expected an ACP open effect');
    const result = z.object({
      effects: z.array(z.object({
        effectId: z.string(),
        reverseSessionId: z.string(),
      }).passthrough()),
    }).passthrough().parse(poll.result);
    const [effect] = result.effects;
    if (!effect) throw new Error('Expected an ACP open effect');
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-1',
        effectId: effect.effectId,
        result: {
          reverseSessionId: effect.reverseSessionId,
          methods: [],
        },
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(opening).resolves.toMatchObject({ ok: true });
    const runtimeContext: AgentSessionRuntimeContext | undefined =
      open.mock.calls[0]?.[1];
    if (!runtimeContext) throw new Error('Expected the daemon runtime context');
    if (!daemonAcpRuntime) throw new Error('Expected the daemon ACP runtime');

    expect(runtimeLeaseMock.acquire).toHaveBeenCalledOnce();
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(result.effects).toHaveLength(1);

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'acp.session.event',
        requestId: 'acp-event-history-provider-session',
        reverseSessionId: effect.reverseSessionId,
        event: {
          sequence: 0,
          sessionId: 'session-1',
          emittedAtMs: 1,
          kind: 'provider-session-id',
          providerSessionId: 'provider-session-1',
        },
      },
    })).resolves.toMatchObject({ ok: true });
    const checkpointProjectionCallbackId = z.object({
      options: z.object({
        definition: z.object({
          history: z.object({
            projectUserMessageProviderCheckpointCallbackId: z.string(),
          }).passthrough(),
        }).passthrough(),
      }).passthrough(),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(poll.result).effects[0],
    ).options.definition.history.projectUserMessageProviderCheckpointCallbackId;
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'acp.callback.history.projectUserMessageProviderCheckpoint',
        requestId: 'project-history-checkpoint',
        reverseSessionId: effect.reverseSessionId,
        callbackId: checkpointProjectionCallbackId,
        input: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'exact user prompt' },
          _meta: { modelId: 'grok-4.5', promptIndex: 42 },
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'grok_prompt_index', promptIndex: 42 },
    });
    const rollbackCallbackId = z.object({
      options: z.object({
        definition: z.object({
          history: z.object({
            createConversationRollbackCallbackId: z.string(),
          }).passthrough(),
        }).passthrough(),
      }).passthrough(),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(poll.result).effects[0],
    ).options.definition.history.createConversationRollbackCallbackId;
    const rollbackControlResponse = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'acp.callback.history.createConversationRollback',
        requestId: 'create-history-rollback-control',
        reverseSessionId: effect.reverseSessionId,
        callbackId: rollbackCallbackId,
        historySessionId: 'history-session-1',
      },
    });
    if (!rollbackControlResponse.ok) {
      throw new Error('Expected a Grok conversation rollback control');
    }
    const { controlId } = z.object({ controlId: z.string() }).parse(
      rollbackControlResponse.result,
    );
    let rewindScenario: 'legacy-success' | 'canonical-method-not-found' =
      'legacy-success';
    const providerRequestExtension = vi.fn(async (method: string): Promise<JsonValue> => {
      if (
        rewindScenario === 'legacy-success'
        && method === 'x.ai/rewind/points'
      ) {
        throw RequestError.methodNotFound(method);
      }
      if (
        rewindScenario === 'canonical-method-not-found'
        && method === 'x.ai/rewind/execute'
      ) {
        throw RequestError.methodNotFound(method);
      }
      return method.endsWith('/rewind/points')
        ? { points: [] }
        : { success: true };
    });
    const historySessionsById: ChildAcpReverseSession['historySessionsById'] =
      new Map();
    const methods: ChildAcpReverseSession['methods'] = new Set();
    const childReverseSession: ChildAcpReverseSession = Object.freeze({
      runtime: childBackedRuntime,
      methods,
      completionEvidence: { current: null },
      historySessionsById,
      async drainForwardedEvents() {},
      async dispose() {},
    });
    historySessionsById.set('history-session-1', Object.freeze({
      getProviderSessionId: () => 'provider-session-1',
      requestExtension: async (extensionMethods, params, options) =>
        await requestAcpHistoryExtension({
          methods: extensionMethods,
          params,
          ...(options ? { options } : {}),
          requestExtension: providerRequestExtension,
        }),
    }));
    const takeNextHistoryExtensionEffect = async (requestId: string) => {
      const historyPoll = await routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'channel.poll',
          requestId,
          afterSequence: -1,
        },
      });
      if (!historyPoll.ok) throw new Error('Expected a history rollback effect');
      const historyEffect = AgentRuntimeDaemonAcpChildOperationV1Schema.parse(
        z.object({ effects: z.array(z.unknown()) }).parse(historyPoll.result)
          .effects.find((candidate) => (
            z.object({ kind: z.string() }).passthrough().safeParse(candidate).data
              ?.kind === 'acp.historySession.requestExtension'
          )),
      );
      if (historyEffect.kind !== 'acp.historySession.requestExtension') {
        throw new Error('Expected an ACP history request-extension effect');
      }
      expect(historyEffect.historySessionId).toBe('history-session-1');
      expect(historyEffect.methods).toHaveLength(1);
      return historyEffect;
    };
    const completeNextHistoryExtensionEffect = async (requestId: string) => {
      const historyEffect = await takeNextHistoryExtensionEffect(`${requestId}-poll`);
      const result = AgentRuntimeJsonValueV1Schema.parse(
        await applyChildAcpReverseOperation(childReverseSession, historyEffect),
      );
      await expect(routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'effect.complete',
          requestId: `${requestId}-complete`,
          effectId: historyEffect.effectId,
          result,
        },
      })).resolves.toMatchObject({ ok: true });
      return historyEffect;
    };
    const failNextHistoryExtensionEffect = async (
      requestId: string,
      expectedMessage: string,
    ) => {
      const historyEffect = await takeNextHistoryExtensionEffect(`${requestId}-poll`);
      await expect(applyChildAcpReverseOperation(
        childReverseSession,
        historyEffect,
      )).rejects.toThrow(expectedMessage);
      await expect(routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'effect.fail',
          requestId: `${requestId}-fail`,
          effectId: historyEffect.effectId,
          error: {
            code: 'agent_runtime_bridge_request_failed',
            message: expectedMessage,
          },
        },
      })).resolves.toMatchObject({ ok: true });
      return historyEffect;
    };
    const rollbackRequest = AgentSessionConversationRollbackRequestV1Schema.parse({
      operationId: 'rollback-operation-1',
      target: { kind: 'beforeTurn', turnId: 'turn-2' },
      affectedTurns: [{
        turnId: 'turn-2',
        providerCheckpoint: {
          kind: 'grok_prompt_index',
          promptIndex: 4,
        },
      }],
      providerSessionId: 'provider-session-1',
      runtimeIncarnationId: 'runtime-incarnation-1',
    });
    const appliedRollback = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'acp.callback.history.rollback',
        requestId: 'apply-history-rollback',
        reverseSessionId: effect.reverseSessionId,
        controlId,
        request: rollbackRequest,
      },
    });
    await failNextHistoryExtensionEffect(
      'legacy-probe-canonical',
      '"Method not found": x.ai/rewind/points',
    );
    await completeNextHistoryExtensionEffect('legacy-probe-observed');
    await completeNextHistoryExtensionEffect('legacy-execute');
    await expect(appliedRollback).resolves.toMatchObject({
      ok: true,
      result: { status: 'applied' },
    });
    expect(providerRequestExtension.mock.calls.map(([method]) => method)).toEqual([
      'x.ai/rewind/points',
      '_x.ai/rewind/points',
      '_x.ai/rewind/execute',
    ]);
    expect(providerRequestExtension).toHaveBeenLastCalledWith(
      '_x.ai/rewind/execute',
      {
        sessionId: 'provider-session-1',
        targetPromptIndex: 4,
        force: true,
        mode: 'conversation_only',
      },
      undefined,
    );

    rewindScenario = 'canonical-method-not-found';
    const ambiguousRollbackRequest =
      AgentSessionConversationRollbackRequestV1Schema.parse({
        ...rollbackRequest,
        operationId: 'rollback-operation-2',
      });
    const ambiguousRollback = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'acp.callback.history.rollback',
        requestId: 'ambiguous-history-rollback',
        reverseSessionId: effect.reverseSessionId,
        controlId,
        request: ambiguousRollbackRequest,
      },
    });
    await completeNextHistoryExtensionEffect('canonical-probe');
    await failNextHistoryExtensionEffect(
      'canonical-method-not-found-execute',
      '"Method not found": x.ai/rewind/execute',
    );
    await expect(ambiguousRollback).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'outcomeUnknown',
        diagnostic: { code: 'grok_rollback_outcome_unknown' },
      },
    });
    expect(providerRequestExtension.mock.calls.map(([method]) => method)).toEqual([
      'x.ai/rewind/points',
      '_x.ai/rewind/points',
      '_x.ai/rewind/execute',
      'x.ai/rewind/points',
      'x.ai/rewind/execute',
    ]);
    expect(providerRequestExtension.mock.calls.filter(([method]) => (
      method.endsWith('/rewind/execute')
    ))).toHaveLength(2);

    if (!daemonAcpRuntime) throw new Error('Expected the daemon ACP runtime');
    const establishingCompletionTurn = daemonAcpRuntime.send({
      inputIds: ['completion-input-1'],
      input: { text: 'establish completion turn' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    });
    const establishingCompletionPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-establish-completion-turn',
        afterSequence: -1,
      },
    });
    if (!establishingCompletionPoll.ok) {
      throw new Error('Expected an ACP send effect for completion turn');
    }
    const establishingCompletionEffect = z.object({
      effectId: z.string(),
      kind: z.literal('acp.session.send'),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) })
        .parse(establishingCompletionPoll.result).effects[0],
    );
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-establish-completion-turn',
        effectId: establishingCompletionEffect.effectId,
        result: { status: 'admitted' },
      },
    });
    await expect(establishingCompletionTurn).resolves.toMatchObject({
      status: 'admitted',
    });

    const completionCallback = z.object({
      callbackId: z.string(),
      kind: z.literal('notification'),
      method: z.literal('x.test/session/prompt_complete'),
    }).parse(
      z.object({
        options: z.object({
          extensions: z.array(z.unknown()),
        }).passthrough(),
      }).passthrough().parse(
        z.object({ effects: z.array(z.unknown()) }).parse(poll.result).effects[0],
      ).options.extensions[0],
    );
    const completionCallbackOperation = {
      kind: 'acp.callback.extension.notification' as const,
      reverseSessionId: effect.reverseSessionId,
      callbackId: completionCallback.callbackId,
      params: {},
      context: {
        method: completionCallback.method,
        providerSessionId: 'provider-session-1',
        currentTurn: {
          turnId: 'turn-1',
          completionEvidenceId: 'completion-evidence-1',
        },
      },
    };
    const firstCompletionCallback = await routes.dispatch({
      v: 1,
      context,
      operation: {
        ...completionCallbackOperation,
        requestId: 'completion-callback-1',
      },
    });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        ...completionCallbackOperation,
        requestId: 'completion-callback-2',
        params: { mode: 'duplicate' },
      },
    })).resolves.toMatchObject({ ok: true });
    expect(completionEvidenceAdmissions).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(firstCompletionCallback).toMatchObject({
      ok: true,
      result: {
        completionEvidence: {
          providerSessionId: 'provider-session-1',
          promptId: 'turn-1',
          outcome: { kind: 'completed' },
        },
      },
    });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        ...completionCallbackOperation,
        requestId: 'completion-callback-retained',
        params: { mode: 'retain' },
        context: {
          ...completionCallbackOperation.context,
          currentTurn: {
            turnId: 'turn-2',
            completionEvidenceId: 'completion-evidence-2',
          },
        },
      },
    })).resolves.toMatchObject({ ok: true });
    expect(retainedCompletionEvidenceSubmit).toEqual(expect.any(Function));

    const managedOpening = runtimeContext.protocols.acp.open(request, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'managedDependency', id: 'managed-acp' },
      },
    });
    const managedPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-managed-open',
        afterSequence: -1,
      },
    });
    if (!managedPoll.ok) throw new Error('Expected a managed ACP open effect');
    const managedEffect = z.object({
      effectId: z.string(),
      reverseSessionId: z.string(),
      kind: z.literal('acp.session.open'),
      options: z.object({
        resolvedExecutable: z.object({
          kind: z.literal('managedDependency'),
          dependencyId: z.literal('managed-acp'),
          command: z.literal('/resolved/bin/managed-acp'),
          args: z.tuple([z.literal('serve')]),
          env: z.object({ MANAGED_ACP: z.literal('1') }).strict(),
        }).strict(),
      }).passthrough(),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(managedPoll.result).effects[0],
    );
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-managed-open',
        effectId: managedEffect.effectId,
        result: {
          reverseSessionId: managedEffect.reverseSessionId,
          methods: [],
        },
      },
    });
    const managedRuntime = await managedOpening;
    expect(releaseManagedExecutable).not.toHaveBeenCalled();
    const managedDisposal = managedRuntime.dispose();
    const managedDisposePoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-managed-dispose',
        afterSequence: -1,
      },
    });
    if (!managedDisposePoll.ok) throw new Error('Expected a managed ACP dispose effect');
    const managedDisposeEffect = z.object({
      effectId: z.string(),
      kind: z.literal('acp.session.dispose'),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(managedDisposePoll.result).effects[0],
    );
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-managed-dispose',
        effectId: managedDisposeEffect.effectId,
        result: null,
      },
    });
    await managedDisposal;
    expect(releaseManagedExecutable).toHaveBeenCalledOnce();

    const approval = runtimeContext.ui.requestApproval({
      title: 'Run Bash?',
      description: 'Inspect the working tree',
      subject: {
        kind: 'tool',
        name: 'Bash',
        input: { command: 'git status --short' },
      },
      allowSessionPersistence: true,
    });
    const approvalPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-approval',
        afterSequence: -1,
      },
    });
    if (!approvalPoll.ok) throw new Error('Expected a tool-approval effect');
    const approvalEffect = z.object({
      effectId: z.string(),
      kind: z.literal('ui.requestApproval'),
      request: z.object({
        title: z.literal('Run Bash?'),
        description: z.literal('Inspect the working tree'),
        subject: z.object({
          kind: z.literal('tool'),
          name: z.literal('Bash'),
          input: z.object({ command: z.literal('git status --short') }).strict(),
        }).strict(),
        allowSessionPersistence: z.literal(true),
      }).strict(),
    }).strict().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(approvalPoll.result).effects[0],
    );
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-approval',
        effectId: approvalEffect.effectId,
        result: { status: 'approved', persistence: 'session' },
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(approval).resolves.toEqual({
      status: 'approved',
      persistence: 'session',
    });

    const rejectedQuestions = runtimeContext.ui.askQuestions([{
      id: 'reason',
      prompt: 'Why?',
      type: 'text',
    }]);
    const questionsPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-questions-rejection',
        afterSequence: -1,
      },
    });
    if (!questionsPoll.ok) throw new Error('Expected a questions effect');
    const questionsEffect = z.object({
      effectId: z.string(),
      kind: z.literal('ui.askQuestions'),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(questionsPoll.result)
        .effects.find((candidate) => (
          z.object({ kind: z.string() }).passthrough().safeParse(candidate).data
            ?.kind === 'ui.askQuestions'
        )),
    );
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.fail',
        requestId: 'fail-questions',
        effectId: questionsEffect.effectId,
        error: {
          code: 'raw_interaction_transport_failure',
          message: 'raw interaction transport failure',
        },
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(rejectedQuestions).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'plugin_ui_questions_unavailable' },
    });

    let replayedProviderIdentity = false;
    daemonAcpRuntime.watch(async (event) => {
      if (
        !replayedProviderIdentity
        && event.kind === 'provider-session-id'
        && event.providerSessionId === 'provider-session-1'
      ) {
        replayedProviderIdentity = true;
        return;
      }
      throw new Error('daemon ACP listener rejected');
    });
    expect(replayedProviderIdentity).toBe(true);
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'acp.session.event',
        requestId: 'acp-event-listener-rejection',
        reverseSessionId: effect.reverseSessionId,
        event: {
          sequence: 0,
          sessionId: 'session-1',
          emittedAtMs: 1,
          kind: 'provider-session-id',
          providerSessionId: 'provider-session-1',
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'agent_runtime_daemon_bridge_failed',
        message: 'daemon ACP listener rejected',
      },
    });

    const hookOpen = runtimeContext.session.services.sessionHooks.startServer({
      permissionRequestTimeoutMsForTool: (toolName) => (
        toolName === 'fallback'
          ? undefined
          : toolName === 'unbounded'
            ? null
            : 42
      ),
    });
    const hookPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-hooks',
        afterSequence: -1,
      },
    });
    if (!hookPoll.ok) throw new Error('Expected a hook-open effect');
    const hookEffect = z.object({
      effectId: z.string(),
      callbackId: z.string(),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(hookPoll.result).effects[0],
    );
    for (const [toolName, expected] of [
      ['fallback', { kind: 'undefined' }],
      ['unbounded', { kind: 'value', value: null }],
      ['bounded', { kind: 'value', value: 42 }],
    ] as const) {
      await expect(routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'session.hooks.callback',
          requestId: `hook-${toolName}`,
          callbackId: hookEffect.callbackId,
          callbackKind: 'permissionTimeoutForTool',
          payload: toolName,
        },
      })).resolves.toEqual({ ok: true, result: expected });
    }
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-hooks',
        effectId: hookEffect.effectId,
        result: { handleId: 'hook-handle-1', port: 31_337 },
      },
    });
    await expect(hookOpen).resolves.toMatchObject({ port: 31_337 });

    const cancelController = new AbortController();
    const refresh = runtimeContext.session.services.auth.refreshRuntimeAuth(
      { serviceId: 'openai' },
      { signal: cancelController.signal },
    );
    const refreshPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-refresh',
        afterSequence: -1,
      },
    });
    if (!refreshPoll.ok) throw new Error('Expected an auth-refresh effect');
    const refreshEffect = z.object({
      effectId: z.string(),
      kind: z.literal('session.auth.refreshRuntimeAuth'),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(refreshPoll.result)
        .effects.find((candidate) => (
          z.object({ kind: z.string() }).passthrough().safeParse(candidate).data
            ?.kind === 'session.auth.refreshRuntimeAuth'
        )),
    );
    cancelController.abort();
    await expect(refresh).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    const cancelPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-cancel',
        afterSequence: -1,
      },
    });
    if (!cancelPoll.ok) throw new Error('Expected an effect-cancel effect');
    const cancelEffect = z.object({
      effectId: z.string(),
      kind: z.literal('effect.cancel'),
      targetEffectId: z.string(),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(cancelPoll.result)
        .effects.find((candidate) => (
          z.object({ kind: z.string() }).passthrough().safeParse(candidate).data
            ?.kind === 'effect.cancel'
        )),
    );
    expect(cancelEffect.targetEffectId).toBe(refreshEffect.effectId);
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-cancel',
        effectId: cancelEffect.effectId,
        result: null,
      },
    });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-refresh-late',
        effectId: refreshEffect.effectId,
        result: { status: 'refreshed' },
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-refresh-late-duplicate',
        effectId: refreshEffect.effectId,
        result: { status: 'refreshed' },
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(refresh).rejects.toMatchObject({ name: 'AbortError' });

    const followController = new AbortController();
    const following = runtimeContext.session.services.transcripts.fileFollow.follow({
      path: '/tmp/agent-transcript.jsonl',
      startAt: 'end',
      signal: followController.signal,
      onLine() {},
    });
    const followPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-follow',
        afterSequence: -1,
      },
    });
    if (!followPoll.ok) throw new Error('Expected a transcript-follow effect');
    const followEffect = z.object({
      effectId: z.string(),
      kind: z.literal('session.transcripts.fileFollow.follow'),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(followPoll.result)
        .effects.find((candidate) => (
          z.object({ kind: z.string() }).passthrough().safeParse(candidate).data
            ?.kind === 'session.transcripts.fileFollow.follow'
        )),
    );
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-follow',
        effectId: followEffect.effectId,
        result: { handleId: 'follow-handle-1', id: 'follow-1' },
      },
    });
    await expect(following).resolves.toMatchObject({ id: 'follow-1' });
    followController.abort();
    const closePoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-follow-close',
        afterSequence: -1,
      },
    });
    if (!closePoll.ok) throw new Error('Expected a transcript-close effect');
    const closeEffect = z.object({
      effectId: z.string(),
      kind: z.literal('session.transcripts.fileFollow.close'),
      handleId: z.literal('follow-handle-1'),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(closePoll.result)
        .effects.find((candidate) => (
          z.object({ kind: z.string() }).passthrough().safeParse(candidate).data
            ?.kind === 'session.transcripts.fileFollow.close'
        )),
    );
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-follow-close',
        effectId: closeEffect.effectId,
        result: null,
      },
    });

    const retiringApproval = runtimeContext.ui.requestApproval({
      title: 'Run Bash before retirement?',
      subject: {
        kind: 'tool',
        name: 'Bash',
        input: { command: 'pwd' },
      },
    });
    current = false;
    expect(retainedCompletionEvidenceSubmit?.()).toBe(false);
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.hooks.callback',
        requestId: 'hook-stale',
        callbackId: hookEffect.callbackId,
        callbackKind: 'permissionTimeoutForTool',
        payload: 'bounded',
      },
    })).resolves.toMatchObject({ ok: false });
    await expect(retiringApproval).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'plugin_generation_stale' },
    });
    await expect(runtimeContext.ui.requestApproval({
      title: 'Run Bash after retirement?',
      subject: {
        kind: 'tool',
        name: 'Bash',
        input: { command: 'pwd' },
      },
    })).resolves.toMatchObject({
      status: 'unavailable',
      diagnostic: { code: 'plugin_generation_stale' },
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('settles ACP send effects only after the host acknowledges every preceding turn event', async () => {
    const release = vi.fn(async () => undefined);
    const resolveSystemTool = vi.fn(async () => Object.freeze({
      grantId: 'agent-acp-grant',
      toolId: 'agent-acp',
      displayName: 'Agent ACP',
      source: 'system' as const,
      executablePath: '/resolved/bin/agent-acp',
      launch: Object.freeze({
        kind: 'binary' as const,
        executablePath: '/resolved/bin/agent-acp',
        args: Object.freeze([]),
        env: Object.freeze({}),
      }),
    }));
    const exec = createStablePluginExecService({
      allowedExecutables: [{ kind: 'systemTool', id: 'agent-acp' }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
      async resolveExecutable() {
        throw new Error('Managed dependency resolution was not expected');
      },
      async resolvePath() {
        throw new Error('Path resolution was not expected');
      },
      systemTools: Object.freeze({ resolve: resolveSystemTool }),
    });
    const replayedDuringOpen: unknown[] = [];
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(
      async (request, context) => {
        const session = await context.protocols.acp.open(request, {
          transport: {
            kind: 'stdio',
            executable: { kind: 'systemTool', id: 'agent-acp' },
          },
        });
        session.watch((event) => {
          replayedDuringOpen.push(event);
        });
        return session;
      },
    );
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        ...createEmptyRuntimeAuthorityProjection('happier.agent.grok'),
        agentRuntimesByAgentId: new Map([[
          'grok',
          {
            hasPrimaryRuntime: true,
            pluginId: 'happier.agent.grok',
            pluginVersion: '1.2.3',
            agentId: 'grok',
            generation: 'generation-ack',
            immutableGenerationId: 'sha256:ack',
            isCurrent: () => true,
            retirementSignal: new AbortController().signal,
            createRuntime: async () => ({ sessions: Object.freeze({ open }) }),
          },
        ]]),
        createAgentInvocationServices: () => Object.freeze({ exec }),
      },
      release,
    });
    const routes = createAgentRuntimeSessionBridgeRoutes();
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'generation-ack',
      immutableGenerationId: 'sha256:ack',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: 'session-ack',
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };
    const request = {
      kind: 'create' as const,
      sessionId: 'session-ack',
      cwd: '/workspace',
    };
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-ack',
        descriptor,
        request,
      },
    });
    const opening = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.open',
        requestId: 'open-ack',
        descriptor,
        request,
        featureDecisions: {},
      },
    });
    const openPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-open-ack',
        afterSequence: -1,
      },
    });
    if (!openPoll.ok) throw new Error('Expected an ACP open effect');
    const openEffect = z.object({
      kind: z.literal('acp.session.open'),
      effectId: z.string(),
      reverseSessionId: z.string(),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(openPoll.result).effects[0],
    );
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'acp.session.event',
        requestId: 'provider-identity-before-open-completes',
        reverseSessionId: openEffect.reverseSessionId,
        event: {
          sequence: 0,
          sessionId: 'session-ack',
          emittedAtMs: 1,
          kind: 'provider-session-id',
          providerSessionId: 'provider-ack',
        },
      },
    })).resolves.toMatchObject({ ok: true });
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-open-ack',
        effectId: openEffect.effectId,
        result: {
          reverseSessionId: openEffect.reverseSessionId,
          methods: ['updateConfiguration'],
        },
      },
    });
    await expect(opening).resolves.toMatchObject({ ok: true });
    expect(replayedDuringOpen).toEqual([expect.objectContaining({
      kind: 'provider-session-id',
      providerSessionId: 'provider-ack',
    })]);
    const identityPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-pre-watch-provider-identity',
        afterSequence: -1,
      },
    });
    if (!identityPoll.ok) {
      throw new Error('Expected the provider identity buffered during ACP open');
    }
    expect(z.object({
      events: z.array(AgentSessionRuntimeEventV1Schema),
    }).passthrough().parse(identityPoll.result).events).toEqual([{
      sequence: 0,
      sessionId: 'session-ack',
      emittedAtMs: 1,
      kind: 'provider-session-id',
      providerSessionId: 'provider-ack',
    }]);

    const runTurn = async (
      ordinal: number,
      firstSequence: number,
      eventInputs: readonly Readonly<Record<string, unknown>>[],
      pendingPoll?: Promise<Awaited<ReturnType<typeof routes.dispatch>>>,
    ) => {
      const sending = routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'session.send',
          requestId: `send-${ordinal}`,
          request: {
            inputIds: [`input-${ordinal}`],
            input: { text: `turn ${ordinal}` },
            delivery: { kind: 'newTurn', turnId: `turn-${ordinal}` },
          },
        },
      });
      const effectPoll = await (pendingPoll ?? routes.dispatch({
          v: 1,
          context,
          operation: {
            kind: 'channel.poll',
            requestId: `poll-send-${ordinal}`,
            afterSequence: firstSequence - 1,
          },
        }));
      if (!effectPoll.ok) throw new Error('Expected an ACP send effect');
      const sendEffect = z.object({
        kind: z.literal('acp.session.send'),
        effectId: z.string(),
      }).passthrough().parse(
        z.object({ effects: z.array(z.unknown()) }).parse(effectPoll.result).effects[0],
      );
      for (const [index, event] of eventInputs.entries()) {
        await routes.dispatch({
          v: 1,
          context,
          operation: {
            kind: 'acp.session.event',
            requestId: `event-${ordinal}-${index}`,
            reverseSessionId: openEffect.reverseSessionId,
            event: AgentSessionRuntimeEventV1Schema.parse({
              sequence: firstSequence + index,
              sessionId: 'session-ack',
              emittedAtMs: firstSequence + index + 1,
              ...event,
            }),
          },
        });
      }
      await routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'effect.complete',
          requestId: `complete-send-${ordinal}`,
          effectId: sendEffect.effectId,
          result: { status: 'admitted' },
        },
      });
      let sendSettled = false;
      void sending.then(() => { sendSettled = true; });
      await Promise.resolve();
      expect(sendSettled).toBe(false);

      const eventPoll = await routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'channel.poll',
          requestId: `poll-events-${ordinal}`,
          afterSequence: firstSequence - 1,
        },
      });
      if (!eventPoll.ok) throw new Error('Expected the complete turn event batch');
      const events = z.object({
        events: z.array(z.object({ sequence: z.number(), kind: z.string() }).passthrough()),
      }).passthrough().parse(eventPoll.result).events;
      expect(events.map((event) => event.kind)).toEqual(
        eventInputs.map((event) => event.kind),
      );
      const lastSequence = firstSequence + eventInputs.length - 1;
      const acknowledging = routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'channel.poll',
          requestId: `ack-events-${ordinal}`,
          afterSequence: lastSequence,
        },
      });
      await expect(sending).resolves.toMatchObject({
        ok: true,
        result: { status: 'admitted' },
      });
      return { events, nextPoll: acknowledging };
    };

    const firstTurn = await runTurn(1, 1, [
      {
        kind: 'input-accepted',
        inputIds: ['input-1'],
        delivery: { kind: 'newTurn', turnId: 'turn-1' },
      },
      { kind: 'turn-start', turnId: 'turn-1', startedBy: 'host' },
      {
        kind: 'tool-call',
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        toolName: 'read',
        input: { path: '/workspace/README.md' },
      },
      {
        kind: 'tool-result',
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        output: { text: 'contents' },
      },
      {
        kind: 'message-delta',
        turnId: 'turn-1',
        channel: 'assistant',
        text: 'complete first response',
      },
      {
        kind: 'turn-rollback-boundary',
        turnId: 'turn-1',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 0 },
      },
      { kind: 'turn-complete', turnId: 'turn-1' },
    ]);
    expect(firstTurn.events.at(-2)).toMatchObject({
      kind: 'turn-rollback-boundary',
      turnId: 'turn-1',
      providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 0 },
    });

    const updating = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.updateConfiguration',
        requestId: 'update-after-first-turn',
        request: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: null, updatedAtMs: 1 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: {
            reasoningEffort: { value: 'high', updatedAtMs: 2 },
          },
        },
      },
    });
    const updatePoll = await firstTurn.nextPoll;
    if (!updatePoll.ok) throw new Error('Expected a configuration effect after turn one');
    const updateEffect = z.object({
      kind: z.literal('acp.session.updateConfiguration'),
      effectId: z.string(),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(updatePoll.result).effects[0],
    );
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-update-after-first-turn',
        effectId: updateEffect.effectId,
        result: { status: 'applied', changed: ['options.reasoningEffort'] },
      },
    });
    await expect(updating).resolves.toMatchObject({
      ok: true,
      result: { status: 'applied' },
    });
    const successorPoll = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-successor',
        afterSequence: 7,
      },
    });
    const secondTurn = await runTurn(2, 8, [
      {
        kind: 'input-accepted',
        inputIds: ['input-2'],
        delivery: { kind: 'newTurn', turnId: 'turn-2' },
      },
      { kind: 'turn-start', turnId: 'turn-2', startedBy: 'host' },
      {
        kind: 'message-delta',
        turnId: 'turn-2',
        channel: 'assistant',
        text: 'complete second response',
      },
      { kind: 'turn-complete', turnId: 'turn-2' },
    ], successorPoll);
    const disposal = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.dispose',
        requestId: 'dispose-after-successor',
        reason: 'session_closed',
      },
    });
    await secondTurn.nextPoll;
    await disposal;
    expect(release).toHaveBeenCalledOnce();
  });

  it('returns completion evidence on the callback response and keeps the handle available', async () => {
    const release = vi.fn(async () => undefined);
    const completionAdmissions: boolean[] = [];
    let daemonAcpRuntime: AgentSessionRuntime | undefined;
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(async (request, context) => {
      daemonAcpRuntime = await context.protocols.acp.open(request, {
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: 'agent-acp' },
        },
        extensions: {
          notifications: {
            'x.test/session/prompt_complete': (_params, extensionContext) => {
              if (!extensionContext.currentTurn) {
                throw new Error('Expected a current-turn completion handle');
              }
              completionAdmissions.push(
                extensionContext.currentTurn.submitCompletionEvidence({
                  providerSessionId: 'provider-session-1',
                  promptId: extensionContext.currentTurn.turnId,
                  outcome: { kind: 'completed' },
                }),
              );
            },
          },
        },
      });
      return Object.freeze({
        send: async () => ({ status: 'admitted' as const }),
        watch: () => ({ dispose() {} }),
        async dispose() {},
      });
    });
    const exec = createStablePluginExecService({
      allowedExecutables: [{ kind: 'systemTool', id: 'agent-acp' }],
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
      async resolveExecutable() {
        throw new Error('Managed dependency resolution was not expected');
      },
      async resolvePath() {
        throw new Error('Path resolution was not expected');
      },
      systemTools: Object.freeze({
        resolve: async () => Object.freeze({
          grantId: 'agent-acp-grant',
          toolId: 'agent-acp',
          displayName: 'Agent ACP',
          source: 'system' as const,
          executablePath: '/resolved/bin/agent-acp',
          launch: Object.freeze({
            kind: 'binary' as const,
            executablePath: '/resolved/bin/agent-acp',
            args: Object.freeze([]),
            env: Object.freeze({}),
          }),
        }),
      }),
    });
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        ...createEmptyRuntimeAuthorityProjection('happier.agent.grok'),
        agentRuntimesByAgentId: new Map([['grok', {
          hasPrimaryRuntime: true,
          pluginId: 'happier.agent.grok',
          pluginVersion: '1.2.3',
          agentId: 'grok',
          generation: 'generation-7',
          isCurrent: () => true,
          retirementSignal: new AbortController().signal,
          createRuntime: async () => ({ sessions: { open } }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({ exec }),
      },
      release,
    });
    const routes = createAgentRuntimeSessionBridgeRoutes();
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'generation-7',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: 'session-rejected-completion',
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };
    const request = {
      kind: 'create' as const,
      sessionId: context.sessionId,
      cwd: '/workspace',
    };

    try {
      await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-rejected-completion',
        descriptor,
        request,
      },
    });
    const opening = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.open',
        requestId: 'open-rejected-completion',
        descriptor,
        request,
        featureDecisions: {},
      },
    });
    const openPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-rejected-completion-open',
        afterSequence: -1,
      },
    });
    if (!openPoll.ok) throw new Error('Expected an ACP open effect');
    const openEffect = z.object({
      effectId: z.string(),
      reverseSessionId: z.string(),
      options: z.object({
        extensions: z.array(z.object({
          callbackId: z.string(),
          method: z.string(),
        }).passthrough()),
      }).passthrough(),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) }).parse(openPoll.result).effects[0],
    );
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-rejected-completion-open',
        effectId: openEffect.effectId,
        result: {
          reverseSessionId: openEffect.reverseSessionId,
          methods: [],
        },
      },
    });
    await expect(opening).resolves.toMatchObject({ ok: true });
    const extension = openEffect.options.extensions[0];
    if (!extension) throw new Error('Expected completion extension metadata');
    if (!daemonAcpRuntime) throw new Error('Expected the daemon ACP runtime');
    const establishingCompletionTurn = daemonAcpRuntime.send({
      inputIds: ['completion-input-1'],
      input: { text: 'establish completion turn' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    });
    const establishingCompletionPoll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-establish-completion-turn',
        afterSequence: -1,
      },
    });
    if (!establishingCompletionPoll.ok) {
      throw new Error('Expected an ACP send effect for completion turn');
    }
    const establishingCompletionEffect = z.object({
      effectId: z.string(),
      kind: z.literal('acp.session.send'),
    }).passthrough().parse(
      z.object({ effects: z.array(z.unknown()) })
        .parse(establishingCompletionPoll.result).effects[0],
    );
    await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-establish-completion-turn',
        effectId: establishingCompletionEffect.effectId,
        result: { status: 'admitted' },
      },
    });
    await expect(establishingCompletionTurn).resolves.toMatchObject({
      status: 'admitted',
    });
    const completionCallbackResponse = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'acp.callback.extension.notification',
        requestId: 'submit-rejected-completion',
        reverseSessionId: openEffect.reverseSessionId,
        callbackId: extension.callbackId,
        params: {},
        context: {
          method: extension.method,
          providerSessionId: 'provider-session-1',
          currentTurn: {
            turnId: 'turn-1',
            completionEvidenceId: 'completion-evidence-1',
          },
        },
      },
    });
    expect(completionAdmissions).toEqual([true]);
    expect(completionCallbackResponse).toMatchObject({
      ok: true,
      result: {
        completionEvidence: {
          providerSessionId: 'provider-session-1',
          promptId: 'turn-1',
          outcome: { kind: 'completed' },
        },
      },
    });
    const successor = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.send',
        requestId: 'successor-after-completion',
        request: {
          inputIds: ['successor-input'],
          input: { text: 'successor' },
          delivery: { kind: 'newTurn', turnId: 'successor-turn' },
        },
      },
    });
    expect(successor).toMatchObject({
      ok: true,
      result: { status: 'admitted' },
    });
    expect(release).not.toHaveBeenCalled();
    } finally {
      await routes.dispose();
    }
  });

  it('retires a daemon-native runtime without waiting for another child callback', async () => {
    const retirement = new AbortController();
    const firstRuntimeDispose = vi.fn(async () => undefined);
    const firstRelease = vi.fn(async () => undefined);
    const successorRelease = vi.fn(async () => undefined);
    let firstRuntimeSignal: AbortSignal | undefined;
    let firstRuntimeContext: AgentSessionRuntimeContext | undefined;
    let successorRuntimeContext: AgentSessionRuntimeContext | undefined;
    const firstOpen = vi.fn<AgentSessionRuntimeFactory['open']>(
      async (_request, context) => {
        firstRuntimeContext = context;
        return Object.freeze({
          send: async () => ({ status: 'admitted' as const }),
          watch: () => ({ dispose() {} }),
          dispose: firstRuntimeDispose,
        });
      },
    );
    const firstRegistration = {
      hasPrimaryRuntime: true,
      pluginId: 'happier.agent.grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      generation: 'generation-7',
      immutableGenerationId: 'sha256:first',
      isCurrent: () => !retirement.signal.aborted,
      retirementSignal: retirement.signal,
      createRuntime: vi.fn(async ({ signal }: Readonly<{ signal: AbortSignal }>) => {
        firstRuntimeSignal = signal;
        return Object.freeze({
          sessions: Object.freeze({ open: firstOpen }),
        });
      }),
    };
    const successorRegistration = {
      ...firstRegistration,
      generation: 'generation-8',
      immutableGenerationId: 'sha256:successor',
      isCurrent: () => true,
      retirementSignal: new AbortController().signal,
      createRuntime: vi.fn(async () => Object.freeze({
        sessions: Object.freeze({
          open: async (_request: unknown, runtimeContext: AgentSessionRuntimeContext) => {
            successorRuntimeContext = runtimeContext;
            return Object.freeze({
              send: async () => ({ status: 'admitted' as const }),
              watch: () => ({ dispose() {} }),
              async dispose() {},
            });
          },
        }),
      })),
    };
    runtimeLeaseMock.acquire
      .mockResolvedValueOnce({
        registry: {
          ...createEmptyRuntimeAuthorityProjection('happier.agent.grok'),
          agentRuntimesByAgentId: new Map([['grok', firstRegistration]]),
          createAgentInvocationServices: () => Object.freeze({}),
        },
        release: firstRelease,
      })
      .mockResolvedValueOnce({
        registry: {
          ...createEmptyRuntimeAuthorityProjection('happier.agent.grok'),
          agentRuntimesByAgentId: new Map([['grok', successorRegistration]]),
          createAgentInvocationServices: () => Object.freeze({}),
        },
        release: successorRelease,
      });
    const routes = createAgentRuntimeSessionBridgeRoutes();
    const firstDescriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'generation-7',
      immutableGenerationId: 'sha256:first',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const firstContext = {
      token: 'bridge-token',
      sessionId: 'session-retirement',
      pluginId: firstDescriptor.pluginId,
      agentId: firstDescriptor.agentId,
      generation: firstDescriptor.generation,
    };
    const request = {
      kind: 'create' as const,
      sessionId: firstContext.sessionId,
      cwd: '/workspace',
    };

    try {
      await expect(routes.dispatch({
        v: 1,
        context: firstContext,
        operation: {
          kind: 'factory.prepare',
          requestId: 'prepare-first',
          descriptor: firstDescriptor,
          request,
        },
      })).resolves.toMatchObject({ ok: true });
      await expect(routes.dispatch({
        v: 1,
        context: firstContext,
        operation: {
          kind: 'session.open',
          requestId: 'open-first',
          descriptor: firstDescriptor,
          request,
          featureDecisions: {},
        },
      })).resolves.toMatchObject({ ok: true });
      if (!firstRuntimeContext) throw new Error('Expected the first runtime context');
      const pendingApproval = firstRuntimeContext.ui.requestApproval({
        title: 'Run a tool?',
        subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
      });
      const pendingQuestions = firstRuntimeContext.ui.askQuestions([{
        id: 'reason',
        prompt: 'Why?',
        type: 'text',
      }]);

      retirement.abort(new Error('generation retired'));

      await vi.waitFor(() => {
        expect(firstRuntimeSignal?.aborted).toBe(true);
        expect(firstRuntimeDispose).toHaveBeenCalledOnce();
        expect(firstRelease).toHaveBeenCalledOnce();
      });
      await expect(pendingApproval).resolves.toMatchObject({ status: 'unavailable' });
      await expect(pendingQuestions).resolves.toMatchObject({
        status: 'unavailable',
        diagnostic: { code: 'plugin_generation_stale' },
      });
      await expect(firstRuntimeContext.ui.requestApproval({
        title: 'Run another tool?',
        subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
      })).resolves.toMatchObject({ status: 'unavailable' });
      await expect(firstRuntimeContext.ui.askQuestions([{
        id: 'reason',
        prompt: 'Why?',
        type: 'text',
      }])).resolves.toMatchObject({
        status: 'unavailable',
        diagnostic: { code: 'plugin_generation_stale' },
      });

      const successorDescriptor = {
        ...firstDescriptor,
        generation: 'generation-8',
        immutableGenerationId: 'sha256:successor',
      };
      await expect(routes.dispatch({
        v: 1,
        context: {
          ...firstContext,
          generation: successorDescriptor.generation,
        },
        operation: {
          kind: 'factory.prepare',
          requestId: 'prepare-successor',
          descriptor: successorDescriptor,
          request,
        },
      })).resolves.toMatchObject({ ok: true });
      expect(successorRegistration.createRuntime).toHaveBeenCalledOnce();
      await expect(routes.dispatch({
        v: 1,
        context: {
          ...firstContext,
          generation: successorDescriptor.generation,
        },
        operation: {
          kind: 'session.open',
          requestId: 'open-successor',
          descriptor: successorDescriptor,
          request,
          featureDecisions: {},
        },
      })).resolves.toMatchObject({ ok: true });
      if (!successorRuntimeContext) throw new Error('Expected the successor runtime context');
      const abortedQuestions = successorRuntimeContext.ui.askQuestions([{
        id: 'reason',
        prompt: 'Why?',
        type: 'text',
      }]);
      await routes.dispose();
      await expect(abortedQuestions).resolves.toEqual({ status: 'cancelled' });
    } finally {
      await routes.dispose();
    }
    expect(successorRelease).toHaveBeenCalledOnce();
  });

  it('rejects session open after its prepared plugin generation begins retirement', async () => {
    const retirement = new AbortController();
    const release = vi.fn(async () => undefined);
    const runtimeOpen = vi.fn<AgentSessionRuntimeFactory['open']>(async () => ({
      send: async () => ({ status: 'admitted' as const }),
      watch: () => ({ dispose() {} }),
      async dispose() {},
    }));
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        ...createEmptyRuntimeAuthorityProjection('happier.agent.grok'),
        agentRuntimesByAgentId: new Map([['grok', {
          hasPrimaryRuntime: true,
          pluginId: 'happier.agent.grok',
          pluginVersion: '1.2.3',
          agentId: 'grok',
          generation: 'generation-prepared',
          isCurrent: () => !retirement.signal.aborted,
          retirementSignal: retirement.signal,
          createRuntime: async () => ({
            sessions: { open: runtimeOpen },
          }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
      },
      release,
    });
    const routes = createAgentRuntimeSessionBridgeRoutes();
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'generation-prepared',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: 'session-prepared-retirement',
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };
    const request = {
      kind: 'create' as const,
      sessionId: context.sessionId,
      cwd: '/workspace',
    };

    try {
      await expect(routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'factory.prepare',
          requestId: 'prepare-before-retirement',
          descriptor,
          request,
        },
      })).resolves.toMatchObject({ ok: true });

      retirement.abort(new Error('generation retired'));

      await expect(routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'session.open',
          requestId: 'open-after-retirement',
          descriptor,
          request,
          featureDecisions: {},
        },
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'plugin_generation_stale' },
      });
      expect(runtimeOpen).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(release).toHaveBeenCalledOnce();
      });
    } finally {
      await routes.dispose();
    }
  });

  it('binds External Session host operations only after session open and acknowledges follow effects', async () => {
    const retirement = new AbortController();
    const release = vi.fn(async () => undefined);
    const runtimeDispose = vi.fn(async () => undefined);
    const followDispose = vi.fn();
    const executeTakeover = vi.fn(async () => ({
      sessionId: 'linked-session-1',
      status: 'takenOver' as const,
    }));
    let emitFollowEvent!: (
      event: HostExternalTranscriptFollowEvent,
    ) => Promise<void>;
    const executeFollow = vi.fn(async (request: Parameters<
      ReturnType<ExternalSessionHostOperationOwner['bind']>['executeFollow']
    >[0]) => {
      emitFollowEvent = async (event) => await request.listener(event);
      return {
        status: 'following' as const,
        startingCursor: 'cursor-1',
        subscription: Object.freeze({ dispose: followDispose }),
      };
    });
    const executeProviderSessionFollow = vi.fn(async (request: Parameters<
      ReturnType<
        ExternalSessionHostOperationOwner['bind']
      >['executeProviderSessionFollow']
    >[0]) => {
      emitFollowEvent = async (event) => await request.listener(event);
      return {
        status: 'following' as const,
        startingCursor: 'cursor-provider',
        subscription: Object.freeze({ dispose: followDispose }),
      };
    });
    const retireBinding = vi.fn(async () => undefined);
    const bind = vi.fn<ExternalSessionHostOperationOwner['bind']>(() =>
      Object.freeze({
        executeTakeover,
        executeFollow,
        executeProviderSessionFollow,
        retire: retireBinding,
      }),
    );
    const owner: ExternalSessionHostOperationOwner = Object.freeze({
      bind,
      async install() {
        throw new Error('not used');
      },
      async retire() {},
    });
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        ...createEmptyRuntimeAuthorityProjection('happier.agent.codex'),
        agentRuntimesByAgentId: new Map([['codex', {
          hasPrimaryRuntime: true,
          pluginId: 'happier.agent.codex',
          pluginVersion: '1.0.0',
          agentId: 'codex',
          generation: 'generation-external',
          isCurrent: () => !retirement.signal.aborted,
          retirementSignal: retirement.signal,
          createRuntime: async () => ({
            sessions: {
              open: async () => ({
                send: async () => ({ status: 'admitted' as const }),
                watch: () => ({ dispose() {} }),
                dispose: runtimeDispose,
              }),
            },
          }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
        hookHandlersByHookId: new Map(),
        readHookEventEnvelopeV1,
      },
      release,
    });
    const routes = createAgentRuntimeSessionBridgeRoutes({
      externalSessionHostOperationOwner: owner,
      externalSessionHostBindingContext: {
        machineId: 'machine-1',
        readAccountRevision: () => 'account-revision-1',
      },
    });
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.codex',
      pluginVersion: '1.0.0',
      agentId: 'codex',
      backendId: 'codex',
      generation: 'generation-external',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: 'session-external',
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };
    const request = {
      kind: 'create' as const,
      sessionId: context.sessionId,
      cwd: '/workspace',
    };

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-external',
        descriptor,
        request,
      },
    })).resolves.toMatchObject({ ok: true });
    expect(bind).not.toHaveBeenCalled();
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.open',
        requestId: 'open-external',
        descriptor,
        request,
        featureDecisions: {},
      },
    })).resolves.toMatchObject({ ok: true });
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generationId: descriptor.generation,
      sessionId: context.sessionId,
      machineId: 'machine-1',
    }));

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.takeover',
        requestId: 'takeover-external',
        ref: {
          agentId: 'codex',
          sourceId: 'default',
          remoteSessionId: 'remote-1',
        },
        source: { kind: 'codexHome', home: 'user' },
      },
    })).resolves.toMatchObject({
      ok: true,
      result: { sessionId: 'linked-session-1', status: 'takenOver' },
    });
    expect(executeTakeover).toHaveBeenCalledWith(expect.not.objectContaining({
      machineId: expect.anything(),
      accountRevision: expect.anything(),
    }));

    const followOpen = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.open',
        requestId: 'follow-open-external',
        followId: 'follow-1',
        ref: {
          agentId: 'codex',
          sourceId: 'default',
          remoteSessionId: 'remote-1',
        },
        source: { kind: 'codexHome', home: 'user' },
      },
    });
    await expect(followOpen).resolves.toMatchObject({
      ok: true,
      result: { status: 'following', startingCursor: 'cursor-1' },
    });
    if (!emitFollowEvent) {
      throw new Error('Expected External Session follow listener');
    }
    const followDelivery = emitFollowEvent({
      kind: 'data',
      items: [{
        id: 'item-1',
        kind: 'agent',
        data: { text: 'hello' },
      }],
      fromCursor: null,
      nextCursor: 'cursor-1',
    });
    let effectId: string | null = null;
    await vi.waitFor(async () => {
      const polled = await routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'channel.poll',
          requestId: 'poll-follow-effect',
          afterSequence: -1,
        },
      });
      const effects = polled.ok
        ? (
            polled.result as Readonly<{
              effects: readonly Readonly<{
                effectId: string;
                kind: string;
              }>[];
            }>
          ).effects
        : [];
      const effect = effects.find(
        (candidate) =>
          candidate.kind === 'session.externalSession.follow.event',
      );
      effectId = effect?.effectId ?? null;
      expect(effectId).not.toBeNull();
    });
    if (!effectId) throw new Error('Expected External Session follow effect');
    let closeSettled = false;
    const followClose = routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.close',
        requestId: 'follow-close-external',
        followId: 'follow-1',
      },
    }).then((result) => {
      closeSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-follow-effect',
        effectId,
        result: null,
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(followDelivery).resolves.toBeUndefined();
    await expect(followClose).resolves.toMatchObject({ ok: true });
    expect(followDispose).toHaveBeenCalledOnce();

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind:
          'session.externalSession.follow.openProviderSession',
        requestId: 'provider-follow-open-external',
        followId: 'provider-follow-1',
        agentId: 'codex',
        providerSessionId: 'remote-provider-1',
      },
    })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'following',
        startingCursor: 'cursor-provider',
      },
    });
    expect(executeProviderSessionFollow).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'codex',
        providerSessionId: 'remote-provider-1',
        options: { signal: expect.any(AbortSignal) },
        listener: expect.any(Function),
      }),
    );
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.close',
        requestId: 'provider-follow-close-external',
        followId: 'provider-follow-1',
      },
    })).resolves.toMatchObject({ ok: true });

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.externalSession.follow.open',
        requestId: 'follow-open-before-retirement',
        followId: 'follow-before-retirement',
        ref: {
          agentId: 'codex',
          sourceId: 'default',
          remoteSessionId: 'remote-1',
        },
        source: { kind: 'codexHome', home: 'user' },
      },
    })).resolves.toMatchObject({
      ok: true,
      result: { status: 'following', startingCursor: 'cursor-1' },
    });
    if (!emitFollowEvent) {
      throw new Error('Expected External Session follow listener before retirement');
    }
    let retirementDeliveryState: 'pending' | 'resolved' | 'rejected' = 'pending';
    const retirementDelivery = emitFollowEvent({
      kind: 'data',
      items: [{
        id: 'item-before-retirement',
        kind: 'agent',
        data: { text: 'terminal tail' },
      }],
      fromCursor: 'cursor-1',
      nextCursor: 'cursor-2',
    }).then(
      () => {
        retirementDeliveryState = 'resolved';
      },
      () => {
        retirementDeliveryState = 'rejected';
      },
    );
    let retirementEffectId: string | null = null;
    await vi.waitFor(async () => {
      const polled = await routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'channel.poll',
          requestId: 'poll-follow-effect-before-retirement',
          afterSequence: -1,
        },
      });
      const effects = polled.ok
        ? (
            polled.result as Readonly<{
              effects: readonly Readonly<{
                effectId: string;
                kind: string;
              }>[];
            }>
          ).effects
        : [];
      const effect = effects.find(
        (candidate) =>
          candidate.kind === 'session.externalSession.follow.event',
      );
      retirementEffectId = effect?.effectId ?? null;
      expect(retirementEffectId).not.toBeNull();
    });
    if (!retirementEffectId) {
      throw new Error('Expected External Session follow effect before retirement');
    }
    retirement.abort();
    await Promise.resolve();
    expect(retirementDeliveryState).toBe('pending');
    expect(retireBinding).not.toHaveBeenCalled();
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-follow-effect-after-retirement',
        effectId: retirementEffectId,
        result: null,
      },
    })).resolves.toMatchObject({ ok: true });
    await retirementDelivery;
    expect(retirementDeliveryState).toBe('resolved');
    await vi.waitFor(() => {
      expect(retireBinding).toHaveBeenCalledOnce();
      expect(runtimeDispose).toHaveBeenCalledOnce();
    });
    expect(followDispose).toHaveBeenCalledTimes(3);

    await routes.dispose();
    expect(retireBinding).toHaveBeenCalledOnce();
    expect(runtimeDispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('bounds generation retirement when an External Session follow disposer never settles', async () => {
    vi.useFakeTimers();
    try {
      const retirement = new AbortController();
      const release = vi.fn(async () => undefined);
      const runtimeDispose = vi.fn(async () => undefined);
      const followDispose = vi.fn(
        async () => await new Promise<void>(() => undefined),
      );
      const retireBinding = vi.fn(async () => undefined);
      const owner: ExternalSessionHostOperationOwner = Object.freeze({
        bind: () => Object.freeze({
          executeTakeover: async () => ({
            sessionId: 'linked-session-1',
            status: 'takenOver' as const,
          }),
          executeFollow: async () => ({
            status: 'following' as const,
            startingCursor: 'cursor-1',
            subscription: Object.freeze({ dispose: followDispose }),
          }),
          executeProviderSessionFollow: async () => ({
            status: 'following' as const,
            startingCursor: 'cursor-1',
            subscription: Object.freeze({ dispose: followDispose }),
          }),
          retire: retireBinding,
        }),
        async install() {
          throw new Error('not used');
        },
        async retire() {},
      });
      runtimeLeaseMock.acquire.mockResolvedValue({
        registry: {
          ...createEmptyRuntimeAuthorityProjection('happier.agent.codex'),
          agentRuntimesByAgentId: new Map([['codex', {
            hasPrimaryRuntime: true,
            pluginId: 'happier.agent.codex',
            pluginVersion: '1.0.0',
            agentId: 'codex',
            generation: 'generation-hanging-follow',
            isCurrent: () => !retirement.signal.aborted,
            retirementSignal: retirement.signal,
            createRuntime: async () => ({
              sessions: {
                open: async () => ({
                  send: async () => ({ status: 'admitted' as const }),
                  watch: () => ({ dispose() {} }),
                  dispose: runtimeDispose,
                }),
              },
            }),
          }]]),
          createAgentInvocationServices: () => Object.freeze({}),
          hookHandlersByHookId: new Map(),
          readHookEventEnvelopeV1,
        },
        release,
      });
      const routes = createAgentRuntimeSessionBridgeRoutes({
        externalSessionHostOperationOwner: owner,
        externalSessionHostBindingContext: {
          machineId: 'machine-1',
          readAccountRevision: () => 'account-revision-1',
        },
      });
      const descriptor = {
        v: 1 as const,
        pluginId: 'happier.agent.codex',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        backendId: 'codex',
        generation: 'generation-hanging-follow',
        runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
        factoryControls: {
          continuation: false,
          goals: false,
          catalog: false,
          usageLimitRecovery: false,
        },
      };
      const context = {
        token: 'bridge-token',
        sessionId: 'session-hanging-follow',
        pluginId: descriptor.pluginId,
        agentId: descriptor.agentId,
        generation: descriptor.generation,
      };
      const request = {
        kind: 'create' as const,
        sessionId: context.sessionId,
        cwd: '/workspace',
      };

      await expect(routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'factory.prepare',
          requestId: 'prepare-hanging-follow',
          descriptor,
          request,
        },
      })).resolves.toMatchObject({ ok: true });
      await expect(routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'session.open',
          requestId: 'open-hanging-follow',
          descriptor,
          request,
          featureDecisions: {},
        },
      })).resolves.toMatchObject({ ok: true });
      await expect(routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'session.externalSession.follow.open',
          requestId: 'follow-open-hanging',
          followId: 'follow-hanging',
          ref: {
            agentId: 'codex',
            sourceId: 'default',
            remoteSessionId: 'remote-1',
          },
          source: { kind: 'codexHome', home: 'user' },
        },
      })).resolves.toMatchObject({ ok: true });

      let explicitCloseSettled = false;
      const explicitClose = routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'session.externalSession.follow.close',
          requestId: 'follow-close-hanging',
          followId: 'follow-hanging',
        },
      }).then((result) => {
        explicitCloseSettled = true;
        return result;
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
      expect(explicitCloseSettled).toBe(true);
      await expect(explicitClose).resolves.toMatchObject({ ok: true });
      expect(followDispose).toHaveBeenCalledOnce();

      let repeatedCloseSettled = false;
      const repeatedClose = routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'session.externalSession.follow.close',
          requestId: 'follow-close-hanging-repeated',
          followId: 'follow-hanging',
        },
      }).then((result) => {
        repeatedCloseSettled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(repeatedCloseSettled).toBe(true);
      await expect(repeatedClose).resolves.toMatchObject({ ok: true });
      expect(followDispose).toHaveBeenCalledOnce();

      await expect(routes.dispatch({
        v: 1,
        context,
        operation: {
          kind: 'session.externalSession.follow.open',
          requestId: 'follow-open-hanging-retirement',
          followId: 'follow-hanging-retirement',
          ref: {
            agentId: 'codex',
            sourceId: 'default',
            remoteSessionId: 'remote-1',
          },
          source: { kind: 'codexHome', home: 'user' },
        },
      })).resolves.toMatchObject({ ok: true });

      retirement.abort(new Error('generation retired'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();

      expect(followDispose).toHaveBeenCalledTimes(2);
      expect(retireBinding).toHaveBeenCalledOnce();
      expect(runtimeDispose).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      await routes.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the runtime handle current after publishing a complete Agent model descriptor', async () => {
    const release = vi.fn(async () => undefined);
    const runtimeDispose = vi.fn(async () => undefined);
    const resolvePromptAssetBlocks = vi.fn(async () => []);
    const open = vi.fn<AgentSessionRuntimeFactory['open']>(
      async (_request, runtimeContext) => {
        runtimeContext.session.services.models.bind({
          read: () => ({
            currentModelId: 'claude-sonnet-4-6',
            models: [{
              id: 'claude-sonnet-4-6',
              name: 'Claude Sonnet 4.6',
              contextWindowTokens: 200_000,
              extendedContextModelId: 'claude-sonnet-4-6[1m]',
              modelOptions: [{
                id: 'reasoning_effort',
                name: 'Thinking',
                type: 'select',
                currentValue: 'high',
              }],
              capabilities: {
                toolRoundTrips: 'supported',
                reasoningControls: 'supported',
              },
            }],
          }),
          subscribe: () => ({ dispose() {} }),
        });
        return {
          send: async () => ({ status: 'admitted' as const }),
          watch: () => ({ dispose() {} }),
          dispose: runtimeDispose,
        };
      },
    );
    runtimeLeaseMock.acquire.mockResolvedValue({
      registry: {
        ...createEmptyRuntimeAuthorityProjection('happier.agent.claude'),
        agentRuntimesByAgentId: new Map([['claude', {
          hasPrimaryRuntime: true,
          pluginId: 'happier.agent.claude',
          pluginVersion: '1.2.3',
          agentId: 'claude',
          generation: 'generation-models',
          isCurrent: () => true,
          retirementSignal: new AbortController().signal,
          createRuntime: async () => ({ sessions: { open } }),
        }]]),
        createAgentInvocationServices: () => Object.freeze({}),
        resolvePromptAssetBlocks,
        contributes: { tools: [] },
      },
      release,
    });
    const routes = createAgentRuntimeSessionBridgeRoutes();
    const descriptor = {
      v: 1 as const,
      pluginId: 'happier.agent.claude',
      pluginVersion: '1.2.3',
      agentId: 'claude',
      backendId: 'claude',
      generation: 'generation-models',
      runtimeAuthority: createEmptyRuntimeAuthorityDescriptor(),
      factoryControls: {
        continuation: false,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    };
    const context = {
      token: 'bridge-token',
      sessionId: 'session-complete-model-descriptor',
      pluginId: descriptor.pluginId,
      agentId: descriptor.agentId,
      generation: descriptor.generation,
    };
    const request = {
      kind: 'create' as const,
      sessionId: context.sessionId,
      cwd: '/workspace',
    };

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-complete-model-descriptor',
        descriptor,
        request,
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.open',
        requestId: 'open-complete-model-descriptor',
        descriptor,
        request,
        featureDecisions: {},
      },
    })).resolves.toMatchObject({ ok: true });

    const poll = await routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'channel.poll',
        requestId: 'poll-complete-model-descriptor',
        afterSequence: -1,
      },
    });
    if (!poll.ok) throw new Error('Expected a model publication effect');
    const effect = (
      poll.result as Readonly<{
        effects: readonly Readonly<{
          effectId: string;
          kind: string;
          snapshot?: unknown;
        }>[];
      }>
    ).effects.find((candidate) => candidate.kind === 'session.models.publish');
    expect(effect?.snapshot).toMatchObject({
      currentModelId: 'claude-sonnet-4-6',
      models: [{
        id: 'claude-sonnet-4-6',
        extendedContextModelId: 'claude-sonnet-4-6[1m]',
        capabilities: {
          toolRoundTrips: 'supported',
          reasoningControls: 'supported',
        },
      }],
    });
    if (!effect) throw new Error('Expected a model publication effect');
    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'effect.complete',
        requestId: 'complete-model-publication',
        effectId: effect.effectId,
        result: null,
      },
    })).resolves.toMatchObject({ ok: true });

    await expect(routes.dispatch({
      v: 1,
      context,
      operation: {
        kind: 'session.turnContributions.resolve',
        requestId: 'resolve-after-model-publication',
        request: { kind: 'prompt' },
      },
    })).resolves.toMatchObject({
      ok: true,
      result: { promptAssetBlocks: [] },
    });
    expect(resolvePromptAssetBlocks).toHaveBeenCalledOnce();

    await routes.dispose();
    expect(runtimeDispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
