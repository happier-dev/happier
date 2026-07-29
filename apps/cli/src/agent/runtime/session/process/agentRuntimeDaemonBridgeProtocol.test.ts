import { describe, expect, it } from 'vitest';
import { AGENT_SESSION_REALTIME_SDP_MAX_BYTES } from '@happier-dev/protocol';

import {
  AgentRuntimeDaemonBridgeEffectV1Schema,
  AgentRuntimeDaemonBridgeRequestV1Schema,
  AgentRuntimeDaemonBridgeResponseV1Schema,
  AgentRuntimeDaemonSessionDescriptorV1Schema,
  AgentRuntimeDaemonSessionModelsSnapshotV1Schema,
  AgentRuntimeDaemonUiApprovalResultV1Schema,
} from './agentRuntimeDaemonBridgeProtocol';

describe('AgentRuntimeDaemonSessionDescriptorV1Schema', () => {
  const descriptor = {
    v: 1,
    pluginId: 'grok',
    pluginVersion: '1.2.3',
    agentId: 'grok',
    backendId: 'grok',
    generation: 'generation-7',
    immutableGenerationId: 'sha256:abc',
    runtimeAuthority: {
      permissions: ['session.hooks.control'],
      runtimeCapabilities: ['sessionHooks'],
    },
    runtimeSurfaces: {
      terminal: true,
    },
    factoryControls: {
      continuation: true,
      goals: true,
      catalog: true,
      usageLimitRecovery: true,
    },
  } as const;

  it('accepts only immutable identity and bounded authority for a daemon-owned Agent session', () => {
    expect(AgentRuntimeDaemonSessionDescriptorV1Schema.parse(descriptor)).toEqual(descriptor);
    expect(AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
      ...descriptor,
      runtime: {},
    }).success).toBe(false);
    expect(AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
      ...descriptor,
      factoryContext: {},
    }).success).toBe(false);
  });

  it('fails closed on incomplete or unbounded identity', () => {
    expect(AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
      ...descriptor,
      generation: '',
    }).success).toBe(false);
    expect(AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
      ...descriptor,
      pluginId: 'x'.repeat(257),
    }).success).toBe(false);
    expect(AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
      ...descriptor,
      factoryControls: { ...descriptor.factoryControls, invoke: true },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
      ...descriptor,
      runtimeSurfaces: { terminal: true, invoke: true },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
      ...descriptor,
      runtimeAuthority: {
        ...descriptor.runtimeAuthority,
        permissions: ['session.hooks.control', 'session.hooks.control'],
      },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonSessionDescriptorV1Schema.safeParse({
      ...descriptor,
      runtimeAuthority: {
        ...descriptor.runtimeAuthority,
        runtimeCapabilities: ['unbounded-runtime-authority'],
      },
    }).success).toBe(false);
  });
});

describe('AgentRuntimeDaemonSessionModelsSnapshotV1Schema', () => {
  const snapshot = {
    currentModelId: 'claude-sonnet-4-6',
    models: [{
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      contextWindowTokens: 200_000,
      extendedContextModelId: 'claude-sonnet-4-6[1m]',
      modelOptions: [{
        id: 'boolean_option',
        name: 'Boolean option',
        type: 'boolean',
        currentValue: false,
      }, {
        id: 'number_option',
        name: 'Number option',
        type: 'number',
        currentValue: 2,
      }, {
        id: 'nullable_option',
        name: 'Nullable option',
        type: 'select',
        currentValue: null,
      }],
      capabilities: {
        toolRoundTrips: 'supported',
        reasoningControls: 'supported',
      },
    }],
  } as const;

  it('preserves canonical Provider facts and the wider session option scalars', () => {
    expect(AgentRuntimeDaemonSessionModelsSnapshotV1Schema.parse(snapshot))
      .toEqual(snapshot);
    expect(AgentRuntimeDaemonSessionModelsSnapshotV1Schema.parse({
      models: null,
    })).toEqual({ models: null });
  });

  it('rejects unknown snapshot fields', () => {
    expect(AgentRuntimeDaemonSessionModelsSnapshotV1Schema.safeParse({
      ...snapshot,
      unknownAuthority: true,
    }).success).toBe(false);
  });

  it('widens only option scalar kinds while preserving canonical Provider bounds', () => {
    const model = snapshot.models[0];
    const baseOption = {
      id: 'bounded_option',
      name: 'Bounded option',
      type: 'select',
      currentValue: 'enabled',
      options: [{
        value: 'enabled',
        name: 'Enabled',
      }],
    } as const;
    const withOption = (option: object) => ({
      ...snapshot,
      models: [{
        ...model,
        modelOptions: [option],
      }],
    });

    for (const option of [
      { ...baseOption, id: 'x'.repeat(129) },
      { ...baseOption, type: 'x'.repeat(129) },
      { ...baseOption, currentValue: '' },
      { ...baseOption, currentValue: 'x'.repeat(257) },
      { ...baseOption, currentValue: Number.POSITIVE_INFINITY },
      {
        ...baseOption,
        options: [{ ...baseOption.options[0], value: '' }],
      },
      {
        ...baseOption,
        options: [{
          ...baseOption.options[0],
          value: 'x'.repeat(257),
        }],
      },
      {
        ...baseOption,
        options: [{
          ...baseOption.options[0],
          value: Number.NEGATIVE_INFINITY,
        }],
      },
    ]) {
      expect(
        AgentRuntimeDaemonSessionModelsSnapshotV1Schema.safeParse(
          withOption(option),
        ).success,
      ).toBe(false);
    }
  });
});

describe('AgentRuntimeDaemonBridgeRequestV1Schema', () => {
  const context = {
    token: 'bridge-token',
    sessionId: 'session-1',
    pluginId: 'grok',
    agentId: 'grok',
    generation: 'generation-7',
  } as const;

  it('uses an explicit bounded operation union rather than a generic invoke path', () => {
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.parse({
      v: 1,
      context,
      operation: {
        kind: 'session.cancel',
        requestId: 'request-1',
        turnId: 'turn-1',
        reason: 'user',
      },
    })).toMatchObject({
      operation: { kind: 'session.cancel', turnId: 'turn-1' },
    });
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      v: 1,
      context,
      operation: {
        kind: 'invoke',
        path: ['session', 'cancel'],
        args: [],
      },
    }).success).toBe(false);
  });

  it('uses the canonical UTF-8 SDP byte limit for daemon realtime starts', () => {
    const exactSdp = 'é'.repeat(AGENT_SESSION_REALTIME_SDP_MAX_BYTES / 2);
    const request = {
      v: 1,
      context,
      operation: {
        kind: 'runtime.realtimeConversation.start',
        requestId: 'request-realtime-start',
        provider: {
          identity: {
            pluginId: 'happier.agent.codex',
            localId: 'realtime-codex',
          },
          generation: 'provider-generation-1',
        },
        transport: {
          kind: 'webrtc',
          offerSdp: exactSdp,
        },
      },
    } as const;

    expect(
      AgentRuntimeDaemonBridgeRequestV1Schema.safeParse(request).success,
    ).toBe(true);
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      ...request,
      operation: {
        ...request.operation,
        transport: {
          ...request.operation.transport,
          offerSdp: `${exactSdp}x`,
        },
      },
    }).success).toBe(false);
  });

  it('admits only bounded turn-time contribution requests on the authorized session bridge', () => {
    const promptRequest = {
      v: 1,
      context,
      operation: {
        kind: 'session.turnContributions.resolve',
        requestId: 'request-turn-prompt',
        request: {
          kind: 'prompt',
          machineId: 'machine-1',
          featureIds: ['execution.runs'],
          selectedAsset: {
            pluginId: 'happier.review.deepsec',
            localId: 'review-prompt',
          },
        },
      },
    } as const;
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse(promptRequest).success)
      .toBe(true);
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      ...promptRequest,
      operation: {
        ...promptRequest.operation,
        request: {
          ...promptRequest.operation.request,
          featureIds: Array.from({ length: 257 }, (_, index) => `feature-${index}`),
        },
      },
    }).success).toBe(false);

    const transformRequest = {
      v: 1,
      context,
      operation: {
        kind: 'session.turnContributions.resolve',
        requestId: 'request-turn-transform',
        request: {
          kind: 'transformAgentContext',
          payload: {
            sessionId: 'session-1',
            agentId: 'grok',
            prompt: 'hello',
            messages: [{ role: 'user', content: 'hello' }],
            timestampMs: 1,
          },
        },
      },
    } as const;
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse(transformRequest).success)
      .toBe(true);
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      ...transformRequest,
      operation: {
        ...transformRequest.operation,
        request: {
          ...transformRequest.operation.request,
          unexpectedAuthority: true,
        },
      },
    }).success).toBe(false);
  });

  it('carries the exact authorized Provider binding on a configuration update', () => {
    const providerBinding = {
      connectionId: 'pc_gateway',
      model: {
        id: 'gpt-5',
        name: 'GPT-5',
        capabilities: { reasoningControls: 'supported' },
      },
      materialization: { v: 1, kind: 'spawnEnv' },
    } as const;
    const request = {
      v: 1,
      context,
      operation: {
        kind: 'session.updateConfiguration',
        requestId: 'request-model-transition',
        request: {
          mode: { value: null, updatedAtMs: 1 },
          model: { value: 'gpt-5', updatedAtMs: 2 },
          permissionIntent: { value: null, updatedAtMs: 1 },
          options: {},
          providerBinding,
        },
      },
    } as const;

    expect(AgentRuntimeDaemonBridgeRequestV1Schema.parse(request))
      .toMatchObject({ operation: { request: { providerBinding } } });
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      ...request,
      operation: {
        ...request.operation,
        request: {
          ...request.operation.request,
          providerBinding: { ...providerBinding, model: { id: 'gpt-5', name: '' } },
        },
      },
    }).success).toBe(false);
  });

  it('admits only the explicit two-phase factory and control operations', () => {
    const descriptor = AgentRuntimeDaemonSessionDescriptorV1Schema.parse({
      v: 1,
      pluginId: 'grok',
      pluginVersion: '1.2.3',
      agentId: 'grok',
      backendId: 'grok',
      generation: 'generation-7',
      factoryControls: {
        continuation: true,
        goals: false,
        catalog: false,
        usageLimitRecovery: false,
      },
    });
    const request = {
      kind: 'resume',
      sessionId: 'session-1',
      cwd: '/workspace',
      providerSessionId: 'provider-1',
    } as const;
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      v: 1,
      context,
      operation: {
        kind: 'factory.prepare',
        requestId: 'prepare-1',
        descriptor,
        request,
      },
    }).success).toBe(true);
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      v: 1,
      context,
      operation: {
        kind: 'factory.continuation.verify',
        requestId: 'verify-1',
        request,
        context: {
          cwd: '/workspace',
          activity: 'inactive',
          providerSessionId: 'provider-1',
          connectedAccounts: [],
        },
      },
    }).success).toBe(true);
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      v: 1,
      context,
      operation: {
        kind: 'factory.abandon',
        requestId: 'abandon-1',
        reason: 'keep-lease',
      },
    }).success).toBe(false);
  });

  it('rejects cross-session context ambiguity and unknown operation fields', () => {
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      v: 1,
      context: { ...context, sessionId: '' },
      operation: {
        kind: 'session.dispose',
        requestId: 'request-1',
        reason: 'session_closed',
      },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      v: 1,
      context,
      operation: {
        kind: 'session.dispose',
        requestId: 'request-1',
        reason: 'session_closed',
        replay: true,
      },
    }).success).toBe(false);
  });

  it('admits only bounded External Session takeover and follow child operations without daemon authority fields', () => {
    const ref = {
      agentId: 'codex',
      sourceId: 'default',
      remoteSessionId: 'remote-session-1',
    } as const;
    const source = { kind: 'codexHome', home: 'user' } as const;
    const operations = [
      {
        kind: 'session.externalSession.takeover',
        requestId: 'takeover-1',
        ref,
        source,
      },
      {
        kind: 'session.externalSession.follow.open',
        requestId: 'follow-open-1',
        followId: 'follow-1',
        ref,
        source,
        cursor: 'cursor-1',
      },
      {
        kind:
          'session.externalSession.follow.openProviderSession',
        requestId: 'provider-follow-open-1',
        followId: 'provider-follow-1',
        agentId: 'codex',
        providerSessionId: 'remote-session-1',
        cursor: 'cursor-1',
      },
      {
        kind: 'session.externalSession.follow.close',
        requestId: 'follow-close-1',
        followId: 'follow-1',
      },
    ] as const;

    for (const operation of operations) {
      expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
        v: 1,
        context,
        operation,
      }).success).toBe(true);
    }

    for (const forbiddenAuthority of [
      { machineId: 'machine-1' },
      { accountRevision: 'account-revision-1' },
      { pluginId: 'other-plugin' },
      { generation: 'other-generation' },
      { sessionId: 'other-session' },
    ]) {
      expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
        v: 1,
        context,
        operation: {
          ...operations[0],
          ...forbiddenAuthority,
        },
      }).success).toBe(false);
    }
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      v: 1,
      context,
      operation: {
        ...operations[2],
        source,
      },
    }).success).toBe(false);
  });

  it('admits schema-bounded event batches larger than one generic JSON value', () => {
    const text = 'x'.repeat(64 * 1_024);
    const events = Array.from({ length: 20 }, (_, index) => ({
      sequence: index,
      sessionId: 'session-1',
      emittedAtMs: index,
      kind: 'message-delta' as const,
      turnId: 'turn-1',
      channel: 'assistant' as const,
      text,
    }));
    expect(AgentRuntimeDaemonBridgeResponseV1Schema.safeParse({
      ok: true,
      result: { events, effects: [] },
    }).success).toBe(true);
  });

  it('rejects the dormant session-watch callback variant', () => {
    expect(AgentRuntimeDaemonBridgeRequestV1Schema.safeParse({
      v: 1,
      context,
      operation: {
        kind: 'session.watch.event',
        requestId: 'callback-1',
        callbackId: 'watch-1',
        event: {
          sequence: 1,
          kind: 'activity',
          activity: { state: 'active', observedAtMs: 1 },
        },
      },
    }).success).toBe(false);
  });
});

describe('AgentRuntimeDaemonBridgeEffectV1Schema reverse services', () => {
  it.each([
    {
      kind: 'ui.requestApproval',
      effectId: 'effect-approval',
      request: {
        title: 'Run Bash?',
        subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
        allowSessionPersistence: true,
      },
    },
    {
      kind: 'session.terminal.resolve',
      effectId: 'effect-1',
      request: { preference: 'auto' },
    },
    {
      kind: 'session.hooks.startServer',
      effectId: 'effect-2',
      callbackId: 'hooks-1',
      request: {
        hasSessionHook: true,
        hasPermissionHook: true,
        hasStatuslineUpdate: true,
        hasDefaultPermissionHookResponse: true,
        hasPermissionRequestTimeoutForTool: true,
        sessionHookSecret: 'session-secret',
        permissionHookSecret: 'permission-secret',
        permissionRequestTimeoutMs: 30_000,
      },
    },
    {
      kind: 'session.transcripts.fileFollow.follow',
      effectId: 'effect-3',
      callbackId: 'follow-1',
      input: {
        path: '/tmp/transcript.jsonl',
        startAt: 'end',
        strategy: 'poll',
      },
    },
    {
      kind: 'session.accountUsage.resolveSourceContext',
      effectId: 'effect-4',
      input: { serviceId: 'openai' },
    },
    {
      kind: 'session.auth.refreshRuntimeAuth',
      effectId: 'effect-5',
      request: { serviceId: 'openai' },
    },
    {
      kind: 'session.mcp.resolveServers',
      effectId: 'effect-6',
    },
    {
      kind: 'session.externalSession.follow.event',
      effectId: 'effect-external-follow',
      followId: 'follow-1',
      event: {
        kind: 'data',
        items: [{
          id: 'item-1',
          kind: 'agent',
          data: { text: 'hello' },
        }],
        fromCursor: null,
        nextCursor: 'cursor-1',
      },
    },
  ])('admits the explicit $kind effect and rejects unknown fields', (effect) => {
    expect(AgentRuntimeDaemonBridgeEffectV1Schema.safeParse(effect).success).toBe(true);
    expect(AgentRuntimeDaemonBridgeEffectV1Schema.safeParse({
      ...effect,
      invoke: true,
    }).success).toBe(false);
  });

  it.each([
    {
      title: 'Run operation?',
      subject: { kind: 'operation', label: 'Deploy' },
    },
    {
      title: 'Run Bash?',
      subject: { kind: 'tool', name: 'Bash', input: {} },
      allowWorkspacePersistence: true,
    },
    {
      title: 'Run Bash?',
      subject: { kind: 'tool', name: 'Bash', input: {} },
      requestId: 'plugin-request',
    },
    {
      title: 'Run Bash?',
      subject: { kind: 'tool', name: 'Bash', input: {} },
      providerId: 'opencode',
      sessionId: 'session-1',
      turnId: 'turn-1',
    },
  ])('rejects private or generic approval shape %#', (request) => {
    expect(AgentRuntimeDaemonBridgeEffectV1Schema.safeParse({
      kind: 'ui.requestApproval',
      effectId: 'effect-private-approval',
      request,
    }).success).toBe(false);
  });

  it('admits complete public approval diagnostics and rejects private result fields', () => {
    const resultSchema = AgentRuntimeDaemonUiApprovalResultV1Schema;
    expect(resultSchema.safeParse({
      status: 'unavailable',
      diagnostic: {
        code: 'approval_unavailable',
        severity: 'error',
        message: 'Approval is unavailable',
        details: { source: 'daemon' },
        remediation: { kind: 'openSettings', path: 'agents.approvals' },
      },
    }).success).toBe(true);
    expect(resultSchema.safeParse({
      status: 'approved',
      persistence: 'session',
      requestId: 'private-request',
    }).success).toBe(false);
    expect(resultSchema.safeParse({
      status: 'approved',
      persistence: 'workspace',
    }).success).toBe(false);
  });

  it('carries only the exact host ACP filesystem effect context across the reverse session bridge', () => {
    const effect = {
      kind: 'session.interactions.request',
      effectId: 'effect-host-acp-fs-write',
      request: {
        kind: 'approval',
        requestId: 'turn-1:write-1',
        title: 'Allow writeTextFile?',
        subject: {
          kind: 'tool',
          name: 'writeTextFile',
          input: { path: '/workspace/out.txt', bytes: 1 },
        },
      },
      permissionContext: { origin: 'host_acp_fs_write' },
    } as const;

    expect(AgentRuntimeDaemonBridgeEffectV1Schema.safeParse(effect).success).toBe(true);
    expect(AgentRuntimeDaemonBridgeEffectV1Schema.safeParse({
      ...effect,
      permissionContext: { origin: 'provider_native_write' },
    }).success).toBe(false);
    expect(AgentRuntimeDaemonBridgeEffectV1Schema.safeParse({
      ...effect,
      permissionContext: { ...effect.permissionContext, permissionMode: 'read-only' },
    }).success).toBe(false);
  });

  it.each([
    'sessions.list',
    'sessions.subagents.list',
    'sessions.external.list',
  ])('rejects the dormant %s effect variant', (kind) => {
    expect(AgentRuntimeDaemonBridgeEffectV1Schema.safeParse({
      kind,
      effectId: 'effect-dormant',
      query: {},
    }).success).toBe(false);
  });
});
