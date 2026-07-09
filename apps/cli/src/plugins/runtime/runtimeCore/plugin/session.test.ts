import { describe, expect, it, vi } from 'vitest';

import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { Credentials } from '@/persistence';
import type { RuntimeEventV1, RuntimeSendResultV1, SessionRuntimeV1 } from '@happier-dev/plugin-sdk';

import { createPluginSessionRuntimePlan, createPublicPluginSessionRuntimePlan } from './session';
import { buildPluginSessionBindingInput } from './sessionLaunch';
import { decorateRuntimeTurnOperationsWithMetadata } from './sessionMetadata';

const credentials: Credentials = {
  token: 'test-token',
  encryption: {
    type: 'legacy',
    secret: new Uint8Array([1, 2, 3]),
  },
};

function createBackendFixture() {
  return {
    id: 'acme.sample.backend',
    providerId: 'acme.sample.provider',
    provenance: 'external',
    source: { kind: 'path' },
    runtimeKind: 'native',
    richDefinition: {
      provenance: 'external',
      definition: {
        providerAgentId: 'claude',
      },
    },
    definition: {
      id: 'acme.sample.backend',
      providerId: 'acme.sample.provider',
      providerAgentId: 'claude',
    },
  } as never;
}

function createProviderFixture() {
  return {
    id: 'acme.sample.provider',
    provenance: 'external',
    source: { kind: 'path' },
    runtimeSpec: {
      title: 'Acme Sample Provider',
    },
    richDefinition: {
      provenance: 'external',
      definition: {
        providerAgentId: 'claude',
      },
    },
    definition: {
      id: 'acme.sample.provider',
      ownedBackendIds: ['acme.sample.backend'],
      providerAgentId: 'claude',
    },
  } as never;
}

function createRuntimeTurnOperations(): RuntimeTurnOperations & Readonly<{
  sendTurnPrompt: ReturnType<typeof vi.fn>;
}> {
  return {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => undefined),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'plugin-session-1' })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
  };
}

function accepted(): RuntimeSendResultV1 {
  return { status: 'accepted' };
}

describe('plugin session runtime adapters', () => {
  it('uses provider-acceptance watermarking for internal plugin session plans', async () => {
    const plan = await createPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      provider: createProviderFixture(),
      launch: async () => ({
        runtime: createRuntimeTurnOperations(),
      }),
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
      }),
    });

    expect(plan.config.userMessageDeliveryWatermarkMode).toBe('providerAcceptance');
  });

  it('projects provider-acceptance pending materialization preferences into internal plugin session plans', async () => {
    const plan = await createPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      provider: createProviderFixture(),
      launch: async () => ({
        runtime: createRuntimeTurnOperations(),
      }),
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
        providerAcceptancePendingMaterialization: 'commitAtMaterialize',
      }),
    });

    expect(plan.config.userMessageDeliveryWatermarkMode).toBe('providerAcceptance');
    expect(plan.config.providerAcceptancePendingMaterialization).toBe('commitAtMaterialize');
  });

  it('passes provider-acceptance user message seqs to public session runtimes', async () => {
    const send = vi.fn(async () => accepted());
    const runtime: SessionRuntimeV1 = {
      identity: { read: () => ({ providerSessionId: 'plugin-session-1' }) },
      events: { subscribe: (_handler: (event: RuntimeEventV1) => void) => () => undefined },
      send,
      dispose: vi.fn(async () => undefined),
    };
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      provider: createProviderFixture(),
      createSessionRuntime: async () => runtime,
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
      }),
    });

    const created = await plan.config.createSessionRuntime?.({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    const operations = (created as Readonly<{ operations: RuntimeTurnOperations }>).operations;
    await operations.sendTurnPrompt('hello', { userMessageSeq: 42, modelId: 'opencode/big-pickle' });

    expect(send).toHaveBeenCalledWith(
      { v: 1, text: 'hello' },
      { modelId: 'opencode/big-pickle', userMessageSeq: 42, userMessageSeqs: [42] },
    );
  });

  it('passes provider-acceptance user message seqs to public session steer runtimes', async () => {
    const send = vi.fn(async () => accepted());
    const runtime: SessionRuntimeV1 = {
      identity: { read: () => ({ providerSessionId: 'plugin-session-1' }) },
      events: { subscribe: (_handler: (event: RuntimeEventV1) => void) => () => undefined },
      send,
      dispose: vi.fn(async () => undefined),
    };
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      provider: createProviderFixture(),
      createSessionRuntime: async () => runtime,
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
      }),
    });

    const created = await plan.config.createSessionRuntime?.({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    const operations = (created as Readonly<{ operations: RuntimeTurnOperations }>).operations;
    await operations.steerInFlightTurn('hello steer', { userMessageSeq: 43 });

    expect(send).toHaveBeenCalledWith(
      { v: 1, text: 'hello steer' },
      { deliverAs: 'steer', userMessageSeq: 43, userMessageSeqs: [43] },
    );
  });

  it('forwards permission-mode runtime config updates to public session runtimes', async () => {
    const updateConfig = vi.fn(async () => undefined);
    const runtime: SessionRuntimeV1 = {
      identity: { read: () => ({ providerSessionId: 'plugin-session-1' }) },
      events: { subscribe: (_handler: (event: RuntimeEventV1) => void) => () => undefined },
      send: vi.fn(async () => accepted()),
      updateConfig,
      dispose: vi.fn(async () => undefined),
    };
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      provider: createProviderFixture(),
      createSessionRuntime: async () => runtime,
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
      }),
    });

    const created = await plan.config.createSessionRuntime?.({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    const operations = (created as Readonly<{ operations: RuntimeTurnOperations }>).operations;
    await operations.updateSessionRuntimeConfig({ permissionMode: 'read-only' });

    expect(updateConfig).toHaveBeenCalledWith({ permissionMode: 'read-only' });
  });

  it('passes explicit provider resume ids to public session runtimes', async () => {
    let capturedResume: unknown = null;
    const runtime: SessionRuntimeV1 = {
      identity: { read: () => ({ providerSessionId: 'plugin-session-1' }) },
      events: { subscribe: (_handler: (event: RuntimeEventV1) => void) => () => undefined },
      send: vi.fn(async () => accepted()),
      dispose: vi.fn(async () => undefined),
    };
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      provider: createProviderFixture(),
      createSessionRuntime: async (params) => {
        capturedResume = params.resume;
        return runtime;
      },
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
        resume: 'vendor-session-1',
      }),
    });

    await plan.config.createSessionRuntime?.({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    expect(capturedResume).toBe('vendor-session-1');
  });

  it('does not advertise unsupported public provider-acceptance hook setters', async () => {
    const runtime: SessionRuntimeV1 = {
      identity: { read: () => ({ providerSessionId: 'plugin-session-1' }) },
      events: { subscribe: (_handler: (event: RuntimeEventV1) => void) => () => undefined },
      send: vi.fn(async () => accepted()),
      dispose: vi.fn(async () => undefined),
    };
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      provider: createProviderFixture(),
      createSessionRuntime: async () => runtime,
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
      }),
    });

    const created = await plan.config.createSessionRuntime?.({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    const operations = (created as Readonly<{
      operations: RuntimeTurnOperations & Record<string, unknown>;
    }>).operations;

    expect(operations.setOnPromptAcceptedByProvider).toBeUndefined();
    expect(typeof operations.setOnPromptTerminallyRejectedBeforeProvider).toBe('function');
    expect(typeof operations.setOnUndeliverablePrompts).toBe('function');
  });

  it('preserves provider-acceptance user message seqs through runtime metadata decoration', async () => {
    const runtime = createRuntimeTurnOperations();
    const decorated = decorateRuntimeTurnOperationsWithMetadata({
      runtime,
      runtimeDescriptor: null,
      runtimeCapabilities: null,
      runtimeFacets: null,
    });

    await decorated.sendTurnPrompt('hello', { userMessageSeq: 77 });

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', { userMessageSeq: 77 });
  });

  it('preserves provider-acceptance steer user message seqs through runtime metadata decoration', async () => {
    const runtime = createRuntimeTurnOperations();
    const decorated = decorateRuntimeTurnOperationsWithMetadata({
      runtime,
      runtimeDescriptor: null,
      runtimeCapabilities: null,
      runtimeFacets: null,
    });

    await decorated.steerInFlightTurn('hello steer', { userMessageSeq: 78 });

    expect(runtime.steerInFlightTurn).toHaveBeenCalledWith('hello steer', { userMessageSeq: 78 });
  });

  it('preserves provider-acceptance hooks through runtime metadata decoration', () => {
    const setOnPromptAcceptedByProvider = vi.fn();
    const setOnPromptTerminallyRejectedBeforeProvider = vi.fn();
    const setOnUndeliverablePrompts = vi.fn();
    const runtime = {
      ...createRuntimeTurnOperations(),
      setOnPromptAcceptedByProvider,
      setOnPromptTerminallyRejectedBeforeProvider,
      setOnUndeliverablePrompts,
    };
    const decorated = decorateRuntimeTurnOperationsWithMetadata({
      runtime,
      runtimeDescriptor: null,
      runtimeCapabilities: null,
      runtimeFacets: null,
    }) as typeof runtime;
    const acceptedHandler = vi.fn();
    const rejectedHandler = vi.fn();
    const undeliverableHandler = vi.fn();

    expect(typeof decorated.setOnPromptAcceptedByProvider).toBe('function');
    expect(typeof decorated.setOnPromptTerminallyRejectedBeforeProvider).toBe('function');
    expect(typeof decorated.setOnUndeliverablePrompts).toBe('function');

    decorated.setOnPromptAcceptedByProvider(acceptedHandler);
    decorated.setOnPromptTerminallyRejectedBeforeProvider(rejectedHandler);
    decorated.setOnUndeliverablePrompts(undeliverableHandler);

    expect(setOnPromptAcceptedByProvider).toHaveBeenCalledWith(acceptedHandler);
    expect(setOnPromptTerminallyRejectedBeforeProvider).toHaveBeenCalledWith(rejectedHandler);
    expect(setOnUndeliverablePrompts).toHaveBeenCalledWith(undeliverableHandler);
  });
});
