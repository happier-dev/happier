import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountSettingsParse,
  AgentSessionProviderBindingV1Schema,
  ProviderBoundModelRefSchema,
  sealSavedSecretResourceStoredContentV1,
  type SecretReferenceOverlayV1,
} from '@happier-dev/protocol';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type {
  ExecutionRunHostRuntime,
  ExecutionRunHostRuntimeMessageHandler,
  ExecutionRunPermissionCapability,
  RuntimePermissionResponseOutcome,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { SavedSecretOperationAdmissionError } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createEnvKeyScope } from '@/testkit/env/envScope';

// One runtime, one lifetime: the signal must stay stable across calls so
// subscribers do not accumulate against a fresh controller each read.
const TEST_RUNTIME_LIFETIME_SIGNAL = new AbortController().signal;

const resolveBackendEngineAdapterResolutionMock = vi.fn();
const requestExecutionRunConnectedServicesMaterializationMock = vi.fn();
const releaseExecutionRunConnectedServicesMock = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, released: true }));
const requestExecutionRunConnectedServiceRuntimeAuthRefreshMock = vi.fn(async (..._args: unknown[]) => ({
  status: 'unavailable' as const, reason: 'fixture_refresh_unavailable',
}));
const prepareExecutionRunProviderLaunchMock = vi.fn();
const OPENAI_CODEX_ACCOUNT_SERVICE_ID = 'happier.agent.codex/openai-codex';

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
}));

// The daemon control HTTP bridge is the runner's process boundary for connected-services
// materialization; tests exercise the real helper + create.ts merge on top of it.
vi.mock('@/daemon/controlClient', () => ({
  requestExecutionRunConnectedServicesMaterialization: (...args: unknown[]) =>
    requestExecutionRunConnectedServicesMaterializationMock(...args),
  releaseExecutionRunConnectedServices: (...args: unknown[]) =>
    releaseExecutionRunConnectedServicesMock(...args),
  requestExecutionRunConnectedServiceRuntimeAuthRefresh: (...args: unknown[]) =>
    requestExecutionRunConnectedServiceRuntimeAuthRefreshMock(...args),
}));

vi.mock('./providerLaunch', () => ({
  prepareExecutionRunProviderLaunch: (...args: unknown[]) =>
    prepareExecutionRunProviderLaunchMock(...args),
}));

// Keep the large CLI graph in the collection phase. Per-test isolation is owned by
// the boundary fixtures below rather than repeatedly evicting and rebuilding modules.
import { createExecutionRunRuntime } from './create';

function createStubRuntimeCoreBackend(opts?: Readonly<{
  permissionCapability?: ExecutionRunPermissionCapability;
  dynamicPermissionCapability?: ExecutionRunPermissionCapability;
  runtimeDescriptor?: unknown;
  runtimeCapabilities?: unknown;
  runtimeFacets?: unknown;
}>): ExecutionRunHostRuntime & {
  readonly calls: Readonly<{
    provisionRuntime: ReturnType<typeof vi.fn>;
    deliverInput: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    subscribeMessages: ReturnType<typeof vi.fn>;
    respondToPermission: ReturnType<typeof vi.fn>;
    waitForTurnCompletion: ReturnType<typeof vi.fn>;
    readResumeSupport: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>;
} {
  let messageHandler: ExecutionRunHostRuntimeMessageHandler | null = null;
  let emittedRuntimeEvents = false;
  let provisioned = false;
  const calls = {
    readResumeSupport: vi.fn(async () => false),
    provisionRuntime: vi.fn(async () => {
      provisioned = true;
      if (!emittedRuntimeEvents) {
        if (opts?.runtimeDescriptor !== undefined) {
          messageHandler?.({ type: 'event', name: 'runtime.descriptor', payload: opts.runtimeDescriptor });
        }
        if (opts?.runtimeCapabilities !== undefined) {
          messageHandler?.({ type: 'event', name: 'runtime.capabilities', payload: opts.runtimeCapabilities });
        }
        if (opts?.runtimeFacets !== undefined) {
          messageHandler?.({ type: 'event', name: 'runtime.facets', payload: opts.runtimeFacets });
        }
        emittedRuntimeEvents = true;
      }
      return { runtimeId: 'plugin-runtime-1' };
    }),
    deliverInput: vi.fn(async (
      _runtimeId: string,
      input: Parameters<ExecutionRunHostRuntime['deliverInput']>[1],
    ) => {
      messageHandler?.({ type: 'model-output', fullText: `plugin:${input.text}` });
      return { status: 'admitted' as const };
    }),
    cancel: vi.fn(async () => undefined),
    subscribeMessages: vi.fn((handler: ExecutionRunHostRuntimeMessageHandler) => {
      messageHandler = handler;
      return () => {
        if (messageHandler === handler) {
          messageHandler = null;
        }
      };
    }),
    respondToPermission: vi.fn(async () => ({ delivered: true as const })),
    waitForTurnCompletion: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };

  return {
    readResumeSupport: calls.readResumeSupport,
    provisionRuntime: calls.provisionRuntime,
    deliverInput: calls.deliverInput,
    getRuntimeLifetimeSignal: () => TEST_RUNTIME_LIFETIME_SIGNAL,
    cancel: calls.cancel,
    subscribeMessages: calls.subscribeMessages,
    waitForTurnCompletion: calls.waitForTurnCompletion,
    dispose: calls.dispose,
    get permissionCapability() {
      return opts?.dynamicPermissionCapability
        ? provisioned ? opts.dynamicPermissionCapability : undefined
        : opts?.permissionCapability;
    },
    get respondToPermission() {
      if (opts?.dynamicPermissionCapability) {
        return provisioned && opts.dynamicPermissionCapability === 'responds'
          ? calls.respondToPermission
          : undefined;
      }
      return opts?.permissionCapability === 'responds'
        ? calls.respondToPermission
        : undefined;
    },
    calls,
  };
}

describe('createExecutionRunBackend (plugin runtimeCore adapter)', () => {
  beforeEach(() => {
    resolveBackendEngineAdapterResolutionMock.mockReset();
    requestExecutionRunConnectedServicesMaterializationMock.mockReset();
    requestExecutionRunConnectedServiceRuntimeAuthRefreshMock.mockClear();
    releaseExecutionRunConnectedServicesMock
      .mockReset()
      .mockResolvedValue({ ok: true as const, released: true });
    prepareExecutionRunProviderLaunchMock.mockReset();
  });

  it('materializes a one-launch Saved Secret reference into runtime env without persisting its value', async () => {
    const createExecutionRunBackendMock = vi.fn((options) => {
      expect(options.isolation.env).toMatchObject({ API_KEY: 'run-secret-value' });
      return createStubRuntimeCoreBackend();
    });
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'codex',
      agentId: 'codex',
      provenance: 'first_party',
      // The overlay merge belongs to the shared execution-run shell and must
      // not depend on bundled-plugin isolation/catalog projection.
      runtimeOwner: { selected: { kind: 'plugin_engine' } },
      backend: { id: 'codex', agentId: 'codex', provenance: 'first_party' },
      agent: { id: 'codex', provenance: 'first_party' },
      engineAdapter: { runtimeCore: { createExecutionRunBackend: createExecutionRunBackendMock } },
      executionSurfaces: {},
      diagnostics: [],
    });
    const runtime = createExecutionRunRuntime({
      cwd: '/repo',
      scope: 'detached',
      runId: 'run-secret-overlay',
      backendId: 'codex',
      permissionMode: 'default',
      secretReferenceOverlay: {
        v: 1,
        bindings: {
          API_KEY: { ref: 'happier:shared-secret:v1:run-secret', revision: 4 },
        },
      },
      resolveAccountSettingsSnapshot: async () => ({
        source: 'cache',
        settings: accountSettingsParse({}),
        settingsVersion: 1,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
        scopeKey: 'account:owner',
        savedSecretResources: [{
          resourceId: 'run-secret',
          ownerAccountId: 'owner-account',
          displayName: 'Run secret',
          kind: 'apiKey',
          encryptionMode: 'plain',
          revision: 4,
          materialStatus: 'ready',
          storedContent: sealSavedSecretResourceStoredContentV1({
            resourceId: 'run-secret',
            mode: 'plain',
            content: { v: 1, name: 'Run secret', kind: 'apiKey', value: 'run-secret-value' },
          }),
        }],
      }),
      start: { intent: 'delegate', retentionPolicy: 'resumable' },
    });

    await runtime.provisionRuntime({ initialPrompt: 'delegate' });
    await runtime.dispose();
    expect(createExecutionRunBackendMock).toHaveBeenCalledTimes(1);
  });

  it('revalidates the admitted Saved Secret overlay on resume recreation before creating a backend', async () => {
    const overlay = {
      v: 1 as const,
      bindings: {
        API_KEY: { ref: 'happier:shared-secret:v1:run-secret', revision: 4 },
      },
    };
    const createExecutionRunBackendMock = vi.fn(() => createStubRuntimeCoreBackend());
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'codex',
      agentId: 'codex',
      provenance: 'first_party',
      runtimeOwner: { selected: { kind: 'plugin_engine' } },
      backend: { id: 'codex', agentId: 'codex', provenance: 'first_party' },
      agent: { id: 'codex', provenance: 'first_party' },
      engineAdapter: { runtimeCore: { createExecutionRunBackend: createExecutionRunBackendMock } },
      executionSurfaces: {},
      diagnostics: [],
    });
    const resolveAccountSettingsSnapshot = vi.fn(async (input?: Readonly<{
      secretReferenceOverlay?: SecretReferenceOverlayV1;
    }>) => {
      throw new SavedSecretOperationAdmissionError({
        reason: 'reference_stale',
        reference: input?.secretReferenceOverlay?.bindings.API_KEY?.ref ?? 'missing',
      });
    });

    const initiallyAdmittedRuntime = createExecutionRunRuntime({
      cwd: '/repo',
      scope: 'detached',
      runId: 'run-secret-overlay-resume',
      backendId: 'codex',
      permissionMode: 'default',
      secretReferenceOverlay: overlay,
      secretReferenceEnvironment: { API_KEY: 'initially-admitted-value' },
      resolveAccountSettingsSnapshot,
      start: { intent: 'delegate', retentionPolicy: 'resumable' },
    });
    await initiallyAdmittedRuntime.provisionRuntime({ initialPrompt: 'delegate' });
    await initiallyAdmittedRuntime.dispose();
    expect(resolveAccountSettingsSnapshot).not.toHaveBeenCalled();
    expect(createExecutionRunBackendMock).toHaveBeenCalledTimes(1);

    const resumedRuntime = createExecutionRunRuntime({
      cwd: '/repo',
      scope: 'detached',
      runId: 'run-secret-overlay-resume',
      backendId: 'codex',
      permissionMode: 'default',
      secretReferenceOverlay: overlay,
      resolveAccountSettingsSnapshot,
      start: { intent: 'delegate', retentionPolicy: 'resumable' },
    });

    await expect(resumedRuntime.provisionRuntime({
      initialPrompt: 'delegate again',
      resumeRuntimeId: 'provider-session-1',
    })).rejects.toMatchObject({ code: 'provider_binding_changed' });
    expect(resolveAccountSettingsSnapshot).toHaveBeenCalledExactlyOnceWith({
      secretReferenceOverlay: overlay,
    });
    expect(createExecutionRunBackendMock).toHaveBeenCalledTimes(1);
  });

  it('revalidates and carries exact Provider-bound open inputs before runtime creation, then cleans up', async () => {
    const events: string[] = [];
    const cleanupOnExit = vi.fn(async () => { events.push('cleanup'); });
    // `upstream` is a required part of the canonical Agent-facing binding: it
    // is what an Agent runtime reads to decide whether its inherited on-disk
    // identity would answer for the selected route. The values mirror what
    // `projectAgentSessionProviderBindingV1` emits for this external
    // connection — the endpoint protocol/URL it authorized, and `apiKey`
    // because the binding carries its own runtime credential transport.
    const providerBinding = AgentSessionProviderBindingV1Schema.parse({
      connectionId: 'pc_openai',
      model: { id: 'provider-model', name: 'Provider Model' },
      upstream: {
        protocol: 'openai-responses',
        normalizedUrl: 'https://api.openai.example/v1',
        credential: 'apiKey',
      },
      materialization: { v: 1, kind: 'engineConfig', engineConfig: { provider: 'openai' } },
    });
    prepareExecutionRunProviderLaunchMock.mockImplementation(async () => ({
      environment: { PROVIDER_TOKEN: 'bounded-secret' },
      unsetEnvKeys: ['AMBIENT_PROVIDER_TOKEN'],
      providerBinding,
      sanitizeDiagnosticText: (value: string) => value.replaceAll('bounded-secret', '[REDACTED]'),
      revalidateBeforeCommit: async () => {
        events.push('revalidate');
        return { ok: true as const };
      },
      cleanupOnExit,
    }));
    const runtimeCoreBackend = createStubRuntimeCoreBackend();
    const createExecutionRunBackendMock = vi.fn((options) => {
      events.push('create');
      expect(options).toMatchObject({
        modelSelection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: 'pc_openai',
          modelId: 'provider-model',
        },
        configuration: {
          model: { value: 'provider-model' },
          permissionIntent: { value: 'default' },
          options: { reasoning_effort: { value: 'high', updatedAtMs: 7 } },
        },
        providerBinding,
        isolation: {
          env: { PROVIDER_TOKEN: 'bounded-secret' },
          unsetEnvKeys: ['AMBIENT_PROVIDER_TOKEN'],
        },
      });
      return runtimeCoreBackend;
    });
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'codex',
      agentId: 'codex',
      provenance: 'first_party',
      runtimeOwner: { selected: { kind: 'plugin_engine' } },
      backend: { id: 'codex', agentId: 'codex', provenance: 'first_party' },
      agent: { id: 'codex', provenance: 'first_party' },
      engineAdapter: { runtimeCore: { createExecutionRunBackend: createExecutionRunBackendMock } },
      executionSurfaces: {},
      diagnostics: [],
    });

    const ownerAccountSettingsSnapshot = {
      source: 'cache' as const,
      settings: accountSettingsParse({}),
      settingsVersion: 7,
      loadedAtMs: 10,
      settingsSecretsReadKeys: [],
      scopeKey: 'account:owner',
    };
    const runtime = createExecutionRunRuntime({
      cwd: '/repo',
      scope: 'detached',
      runId: 'run-provider',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      modelId: 'provider-model',
      modelSelection: ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: 'pc_openai',
        modelId: 'provider-model',
      }),
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 7,
        overrides: { reasoning_effort: { value: 'high', updatedAt: 7 } },
      },
      permissionMode: 'default',
      connectedServices: null,
      machineId: 'machine-1',
      resolveAccountSettingsSnapshot: async () => ownerAccountSettingsSnapshot,
      resolveProvidersFeatureEnabled: () => true,
      start: { intent: 'delegate', retentionPolicy: 'resumable' },
    });

    await runtime.provisionRuntime({ initialPrompt: 'delegate' });
    expect(events).toEqual(['revalidate', 'create']);
    expect(prepareExecutionRunProviderLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: 'machine-1',
        agentId: 'codex',
        runId: 'run-provider',
        accountSettingsSnapshot: ownerAccountSettingsSnapshot,
      }),
    );
    await runtime.dispose();
    expect(events).toEqual(['revalidate', 'create', 'cleanup']);
  });

  it('exposes a host-owned execution-run runtime surface without interpreting a malformed Agent descriptor', async () => {
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
      permissionCapability: 'static',
      runtimeDescriptor: {
        backendId: 'acme.sample.backend',
        runtimeKind: 'native',
      },
      runtimeCapabilities: {
        executionRun: { supported: true },
      },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    });
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      agentId: 'acme.sample.provider',
      provenance: 'external',
      backend: {
        id: 'acme.sample.backend',
        agentId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      agent: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const runtimeFactory = createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }) as Readonly<{
      provisionRuntime: (opts?: { initialPrompt?: string; resumeRuntimeId?: string; captureReplay?: boolean }) => Promise<{ runtimeId: string }>;
      deliverInput: ExecutionRunHostRuntime['deliverInput'];
      getRuntimeLifetimeSignal: ExecutionRunHostRuntime['getRuntimeLifetimeSignal'];
      cancel: (runtimeId: string) => Promise<void>;
      subscribeMessages: (handler: (message: AgentMessage) => void) => () => void;
      permissionCapability?: ExecutionRunPermissionCapability;
      respondToPermission?: (requestId: string, approved: boolean) => Promise<RuntimePermissionResponseOutcome>;
      waitForTurnCompletion: (timeoutMs?: number | null) => Promise<void>;
      dispose: () => Promise<void>;
    }>;

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionRuntime({ initialPrompt: 'boot' })).resolves.toEqual({ runtimeId: 'plugin-runtime-1' });
    await expect(runtime.deliverInput('plugin-runtime-1', { text: 'hello' })).resolves.toEqual({ status: 'admitted' });
    await expect(runtime.cancel('plugin-runtime-1')).resolves.toBeUndefined();
    expect(runtime.permissionCapability).toBe('static');
    expect(runtime.respondToPermission).toBeUndefined();
    await expect(runtime.waitForTurnCompletion(500)).resolves.toBeUndefined();
    unsubscribe();
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend', expect.any(Object));
    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: {
        kind: 'backend',
        backendId: 'acme.sample.backend',
        sourceKind: 'built_in',
      },
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.facets',
      }),
      expect.objectContaining({
        type: 'model-output',
        fullText: 'plugin:hello',
      }),
    ]));
    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(0);
  });

  it('creates an execution-run backend from plugin terminal-runtime launch when no built-in descriptor exists', async () => {
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
      runtimeDescriptor: {
        backendId: 'acme.sample.backend',
        runtimeKind: 'native',
      },
      runtimeCapabilities: {
        executionRun: { supported: true },
      },
      runtimeFacets: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    });
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      agentId: 'acme.sample.provider',
      provenance: 'external',
      backend: {
        id: 'acme.sample.backend',
        agentId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      agent: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionRuntime({ initialPrompt: 'boot' })).resolves.toEqual({ runtimeId: 'plugin-runtime-1' });
    await expect(runtime.deliverInput('plugin-runtime-1', { text: 'hello' })).resolves.toEqual({ status: 'admitted' });
    await expect(runtime.cancel('plugin-runtime-1')).resolves.toBeUndefined();
    expect(runtime.respondToPermission).toBeUndefined();
    await expect(runtime.waitForTurnCompletion?.(500)).resolves.toBeUndefined();
    unsubscribe();
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(resolveBackendEngineAdapterResolutionMock).toHaveBeenCalledWith('acme.sample.backend', expect.any(Object));
    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      backendTarget: {
        kind: 'backend',
        backendId: 'acme.sample.backend',
        sourceKind: 'built_in',
      },
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(runtimeCoreBackend.calls.provisionRuntime).toHaveBeenCalledWith({ initialPrompt: 'boot' });
    expect(runtimeCoreBackend.calls.deliverInput).toHaveBeenCalledWith('plugin-runtime-1', { text: 'hello' }, undefined);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
        },
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      }),
      expect.objectContaining({
        type: 'model-output',
        fullText: 'plugin:hello',
      }),
    ]));
    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(0);
  });

  it('passes generic isolation env to plugin runtimeCore-backed execution runs', async () => {
    const runtimeCoreBackend = createStubRuntimeCoreBackend();
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      agentId: 'acme.sample.provider',
      provenance: 'external',
      runtimeOwner: {
        backendId: 'acme.sample.backend',
        selected: {
          kind: 'plugin_engine',
          ownerId: 'acme.sample.plugin',
          provenance: 'external',
          pluginId: 'acme.sample.plugin',
        },
        candidates: [{
          kind: 'plugin_engine',
          ownerId: 'acme.sample.plugin',
          provenance: 'external',
          pluginId: 'acme.sample.plugin',
        }],
      },
      backend: {
        id: 'acme.sample.backend',
        agentId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      agent: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      runId: 'run_isolated',
    });

    await expect(runtime.provisionRuntime()).resolves.toEqual({ runtimeId: 'plugin-runtime-1' });
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      isolation: {
        env: expect.objectContaining({
          XDG_STATE_HOME: expect.stringContaining('/isolation/acme.sample.backend/execution_run/run_isolated/xdg/state'),
          XDG_CACHE_HOME: expect.stringContaining('/isolation/acme.sample.backend/execution_run/run_isolated/xdg/cache'),
          XDG_DATA_HOME: expect.stringContaining('/isolation/acme.sample.backend/execution_run/run_isolated/xdg/data'),
        }),
      },
    }));
  });

  it('preserves dynamic permission capability through plugin runtime wrappers', async () => {
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
      dynamicPermissionCapability: 'responds',
    });
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'acme.sample.backend',
      agentId: 'acme.sample.provider',
      provenance: 'external',
      runtimeOwner: {
        backendId: 'acme.sample.backend',
        selected: {
          kind: 'plugin_engine',
          ownerId: 'acme.sample.plugin',
          provenance: 'external',
          pluginId: 'acme.sample.plugin',
        },
        candidates: [{
          kind: 'plugin_engine',
          ownerId: 'acme.sample.plugin',
          provenance: 'external',
          pluginId: 'acme.sample.plugin',
        }],
      },
      backend: {
        id: 'acme.sample.backend',
        agentId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        runtimeKind: 'native',
        capabilities: { executionRun: true },
      },
      agent: {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      runId: 'run_dynamic_permission',
    });

    expect(runtime.respondToPermission).toBeUndefined();
    await expect(runtime.provisionRuntime()).resolves.toEqual({ runtimeId: 'plugin-runtime-1' });
    expect(runtime.respondToPermission).toBeTypeOf('function');
    await expect(runtime.respondToPermission?.('permission-1', true)).resolves.toEqual({ delivered: true });

    expect(runtimeCoreBackend.calls.respondToPermission).toHaveBeenCalledWith('permission-1', true);
  });

  it('preserves emitted runtime descriptors and fills missing runtime capabilities centrally', async () => {
    const agentRuntimeDescriptor = {
      v: 1,
      agentId: 'acme.sample.provider',
      agent: {
        backendMode: 'native',
        providerSessionId: 'acme-session-1',
        agentExtra: {
          owner: 'acme.sample.plugin',
          schemaId: 'acme.sample.runtimeDescriptor',
          v: 1,
          opaqueResumeFact: 'agent-owned',
        },
      },
    } as const;
    const runtimeCoreBackend = createStubRuntimeCoreBackend({
      runtimeDescriptor: agentRuntimeDescriptor,
    });
	    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      agentId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        agentId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      agent: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionRuntime({ initialPrompt: 'boot' })).resolves.toEqual({ runtimeId: 'plugin-runtime-1' });
    await expect(runtime.deliverInput('plugin-runtime-1', { text: 'hello' })).resolves.toEqual({ status: 'admitted' });
    unsubscribe();
    await expect(runtime.dispose()).resolves.toBeUndefined();

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.descriptor',
        payload: agentRuntimeDescriptor,
      }),
    ]));
    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(1);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
          backend: { executionRun: true },
        },
      }),
    ]));
  });

  it('drops a malformed plugin execution-run descriptor without synthesizing a host replacement', async () => {
	    const runtimeCoreBackend = createStubRuntimeCoreBackend({
	      runtimeDescriptor: {
	        backendId: 'acme.sample.backend',
	        runtimeKind: 'native',
	      },
	    });
	    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      agentId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        agentId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      agent: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionRuntime({ initialPrompt: 'boot' })).resolves.toEqual({ runtimeId: 'plugin-runtime-1' });
    unsubscribe();

    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(0);
  });

  it('publishes capabilities and facets but no Agent descriptor when a runtimeCore-backed backend is silent', async () => {
	    const runtimeCoreBackend = createStubRuntimeCoreBackend();
	    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      agentId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        agentId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      agent: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
        facets: {
          transcriptSource: {
            supported: true,
          },
        },
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
      modelId: 'sample-model',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    });

    const messages: AgentMessage[] = [];
    const unsubscribe = runtime.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(runtime.provisionRuntime({ initialPrompt: 'boot' })).resolves.toEqual({ runtimeId: 'plugin-runtime-1' });
    await expect(runtime.deliverInput('plugin-runtime-1', { text: 'hello' })).resolves.toEqual({ status: 'admitted' });
    unsubscribe();

    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      modelId: 'sample-model',
      permissionMode: 'read_only',
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    }));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        name: 'runtime.capabilities',
        payload: {
          executionRun: { supported: true },
          backend: { executionRun: true },
        },
      }),
      expect.objectContaining({
        type: 'event',
        name: 'runtime.facets',
        payload: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      }),
    ]));
    expect(messages.filter((message) => message.type === 'event' && message.name === 'runtime.descriptor')).toHaveLength(0);
  });

  it('fails closed when plugin execution surfaces do not provide terminal-runtime launch', async () => {
	    const createExecutionRunBackendMock = vi.fn(() => {
	      throw new Error("Execution-run backend 'acme.sample.backend' is missing terminal runtime launch support");
	    });
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      agentId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        agentId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      agent: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    });

    await expect(runtime.provisionRuntime()).rejects.toThrow(/terminal runtime launch/i);
  });

  it('fails with unsupported backend when descriptor fallback resolves a non-plugin engine source', async () => {
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue(null);

    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/non-plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      permissionMode: 'read_only',
    });

    await expect(runtime.provisionRuntime()).rejects.toThrow('Unsupported execution-run backend: acme.sample.backend');
  });

  it('does not subscribe late when the caller unsubscribes before runtimeCore resolution finishes', async () => {

    let resolveEngineResolution!: (value: unknown) => void;
    const engineResolutionPromise = new Promise((resolve: (value: unknown) => void) => {
      resolveEngineResolution = resolve;
    });
    resolveBackendEngineAdapterResolutionMock.mockReturnValue(engineResolutionPromise);

    const runtimeCoreBackend = createStubRuntimeCoreBackend();
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);

    const runtimeFactory = createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    }) as Readonly<{
      provisionRuntime: () => Promise<{ runtimeId: string }>;
      subscribeMessages: (handler: (message: AgentMessage) => void) => () => void;
    }>;

    const unsubscribe = runtime.subscribeMessages(() => {});
    unsubscribe();

	    resolveEngineResolution({
	      backendId: 'acme.sample.backend',
	      agentId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        agentId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      agent: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
	      executionSurfaces: {},
	      diagnostics: [],
	    });

    await expect(runtime.provisionRuntime()).resolves.toEqual({ runtimeId: 'plugin-runtime-1' });

    expect(createExecutionRunBackendMock).toHaveBeenCalled();
    expect(runtimeCoreBackend.calls.subscribeMessages).toHaveBeenCalledTimes(1);
  });

  it('fails execution-run startup when plugin trust approval is still required', async () => {
	    const createExecutionRunBackendMock = vi.fn(() => createStubRuntimeCoreBackend());
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      agentId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        agentId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      agent: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
	      },
      diagnostics: [{
        code: 'engine_plugin_daemon_module_load_failed',
        detailCode: 'plugin_trust_approval_required',
	        message: 'Plugin trust approval is required before this backend can run.',
	      }],
	    });

    const runtimeFactory = createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    }) as Readonly<{
      provisionRuntime: () => Promise<{ runtimeId: string }>;
    }>;

    await expect(runtime.provisionRuntime()).rejects.toThrow(
      'Plugin trust approval is required before this backend can run.',
    );
    expect(createExecutionRunBackendMock).not.toHaveBeenCalled();
  });

  it('fails execution-run startup when the plugin runtime source is untrusted', async () => {
	    const createExecutionRunBackendMock = vi.fn(() => createStubRuntimeCoreBackend());
	    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
	      backendId: 'acme.sample.backend',
	      agentId: 'acme.sample.provider',
	      provenance: 'external',
	      backend: {
	        id: 'acme.sample.backend',
	        agentId: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	        runtimeKind: 'native',
	        capabilities: { executionRun: true },
	      },
	      agent: {
	        id: 'acme.sample.provider',
	        provenance: 'external',
	        source: { kind: 'path' },
	      },
	      engineAdapter: {
	        runtimeCore: {
	          createExecutionRunBackend: createExecutionRunBackendMock,
	        },
      },
      diagnostics: [{
        code: 'engine_plugin_daemon_module_load_failed',
        detailCode: 'plugin_untrusted',
        message: 'Refusing to load executable plugin daemon entry from an untrusted source.',
      }],
    });

    const runtimeFactory = createExecutionRunRuntime;
    expect(typeof runtimeFactory).toBe('function');
    if (typeof runtimeFactory !== 'function') return;

    const runtime = runtimeFactory({
      cwd: '/tmp/plugin-backend',
      scope: 'detached',
      backendId: 'acme.sample.backend',
      backendTarget: { kind: 'builtInAgent', agentId: 'acme.sample.backend' as never },
      permissionMode: 'read_only',
    }) as Readonly<{
      provisionRuntime: () => Promise<{ runtimeId: string }>;
    }>;

    await expect(runtime.provisionRuntime()).rejects.toThrow(
      'Refusing to load executable plugin daemon entry from an untrusted source.',
    );
    expect(createExecutionRunBackendMock).not.toHaveBeenCalled();
  });

  it('merges daemon-materialized connected-services env into the backend isolation env', async () => {
    const connectedServiceSelectionsEnvJson = JSON.stringify([{
      kind: 'profile',
      serviceId: OPENAI_CODEX_ACCOUNT_SERVICE_ID,
      profileId: 'profile_1',
    }]);
    const registration = {
      v: 1 as const,
      activationId: '11111111-1111-4111-8111-111111111111',
      runKey: 'run_cs_1',
      agentId: 'codex',
      materializationKey: 'run_cs_1',
      connectedServicesBindings: {
        v: 1 as const,
        bindingsByServiceId: {
          [OPENAI_CODEX_ACCOUNT_SERVICE_ID]: {
            source: 'connected' as const,
            selection: 'profile' as const,
            profileId: 'profile_1',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: connectedServiceSelectionsEnvJson,
      },
      sessionDirectory: '/tmp/project',
      materializedRoot: '/materialized/run_cs_1',
    };
    requestExecutionRunConnectedServicesMaterializationMock.mockResolvedValue({
      ok: true,
      result: {
        activationId: registration.activationId,
        env: {
          CODEX_HOME: '/materialized/run_cs_1/codex-home',
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: connectedServiceSelectionsEnvJson,
          HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify(['CODEX_HOME']),
        },
        connectedServicesBindings: {
          v: 1,
          bindingsByServiceId: {
            [OPENAI_CODEX_ACCOUNT_SERVICE_ID]: {
              source: 'connected',
              selection: 'profile',
              profileId: 'profile_1',
            },
          },
        },
        registration,
      },
    });
    const runtimeCoreBackend = createStubRuntimeCoreBackend();
    const createExecutionRunBackendMock = vi.fn(() => runtimeCoreBackend);
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'codex',
      agentId: 'codex',
      provenance: 'built_in',
      backend: {
        id: 'codex',
        agentId: 'codex',
        provenance: 'built_in',
        source: { kind: 'built_in' },
        runtimeKind: 'acp',
        capabilities: { executionRun: true },
      },
      agent: {
        id: 'codex',
        provenance: 'built_in',
        source: { kind: 'built_in' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const onConnectedServicesRegistration = vi.fn(async () => undefined);
    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/project',
      scope: 'detached',
      runId: 'run_cs_1',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      onConnectedServicesRegistration,
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          [OPENAI_CODEX_ACCOUNT_SERVICE_ID]: {
            source: 'connected',
            selection: 'profile',
            profileId: 'profile_1',
          },
        },
      },
    });

    await runtime.provisionRuntime();

    expect(onConnectedServicesRegistration).toHaveBeenCalledWith(registration);

    expect(requestExecutionRunConnectedServicesMaterializationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run_cs_1',
        agentId: 'codex',
        cwd: '/tmp/project',
      }),
    );
    expect(createExecutionRunBackendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: expect.objectContaining({
          env: expect.objectContaining({
            CODEX_HOME: '/materialized/run_cs_1/codex-home',
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: connectedServiceSelectionsEnvJson,
            HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify(['CODEX_HOME']),
          }),
        }),
      }),
    );

    // Run end releases the materialization (unregister + daemon-side cleanup).
    await runtime.dispose();
    expect(releaseExecutionRunConnectedServicesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run_cs_1',
        activationId: registration.activationId,
      }),
    );
  });

  it('starts an explicitly native plugin run without inheriting its parent connected-service identity', async () => {
    const envScope = createEnvKeyScope([
      'OPENAI_API_KEY',
      'CODEX_HOME',
      'NATIVE_AGENT_HOME',
      'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
      'HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON',
      'HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT',
    ]);
    envScope.patch({
      OPENAI_API_KEY: 'parent-connected-secret',
      CODEX_HOME: '/materialized/parent/codex-home',
      NATIVE_AGENT_HOME: '/native/agent/home',
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'parent',
      }]),
      HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify([
        'OPENAI_API_KEY',
        'CODEX_HOME',
      ]),
      HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: '/materialized/parent',
    });
    try {
      const runtimeCoreBackend = createStubRuntimeCoreBackend();
      const createExecutionRunBackendMock = vi.fn((_options: unknown) => runtimeCoreBackend);
      resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
        backendId: 'pi',
        agentId: 'pi',
        provenance: 'built_in',
        runtimeOwner: {
          backendId: 'pi',
          selected: {
            kind: 'plugin_engine',
            ownerId: 'happier.agent.pi',
            provenance: 'built_in',
            pluginId: 'happier.agent.pi',
          },
          candidates: [],
        },
        backend: {
          id: 'pi',
          agentId: 'pi',
          provenance: 'built_in',
          source: { kind: 'built_in' },
          runtimeKind: 'native',
          capabilities: { executionRun: true },
        },
        agent: {
          id: 'pi',
          provenance: 'built_in',
          source: { kind: 'built_in' },
        },
        engineAdapter: {
          runtimeCore: {
            createExecutionRunBackend: createExecutionRunBackendMock,
          },
        },
        executionSurfaces: {},
        diagnostics: [],
      });

      const runtime = createExecutionRunRuntime({
        cwd: '/tmp/project',
        scope: 'detached',
        runId: 'run_native_pi',
        backendId: 'pi',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        permissionMode: 'safe-yolo',
        connectedServices: {
          v: 2,
          bindingsByServiceId: {},
        },
      });

      await runtime.provisionRuntime();

      expect(requestExecutionRunConnectedServicesMaterializationMock).not.toHaveBeenCalled();
      expect(createExecutionRunBackendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          isolation: expect.objectContaining({
            env: expect.objectContaining({
              NATIVE_AGENT_HOME: '/native/agent/home',
            }),
          }),
        }),
      );
      const launch = createExecutionRunBackendMock.mock.calls[0]?.[0] as {
        isolation?: { env?: Record<string, string> };
      };
      expect(launch.isolation?.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(launch.isolation?.env).not.toHaveProperty('CODEX_HOME');
      expect(launch.isolation?.env).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON');
      expect(launch.isolation?.env).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON');
      expect(launch.isolation?.env).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT');
    } finally {
      envScope.restore();
    }
  });

  it('fails closed at backend resolution when the connected-services bridge is unreachable', async () => {
    requestExecutionRunConnectedServicesMaterializationMock.mockResolvedValue({
      error: 'No daemon running, no state file found',
    });
    const createExecutionRunBackendMock = vi.fn(() => createStubRuntimeCoreBackend());
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'codex',
      agentId: 'codex',
      provenance: 'built_in',
      backend: {
        id: 'codex',
        agentId: 'codex',
        provenance: 'built_in',
        source: { kind: 'built_in' },
        runtimeKind: 'acp',
        capabilities: { executionRun: true },
      },
      agent: {
        id: 'codex',
        provenance: 'built_in',
        source: { kind: 'built_in' },
      },
      engineAdapter: {
        runtimeCore: {
          createExecutionRunBackend: createExecutionRunBackendMock,
        },
      },
      executionSurfaces: {},
      diagnostics: [],
    });

    const runtime = createExecutionRunRuntime({
      cwd: '/tmp/project',
      scope: 'detached',
      runId: 'run_cs_2',
      backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'default',
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          [OPENAI_CODEX_ACCOUNT_SERVICE_ID]: {
            source: 'connected',
            selection: 'profile',
            profileId: 'profile_1',
          },
        },
      },
    });

    await expect(runtime.provisionRuntime()).rejects.toThrow('No daemon running');
    expect(createExecutionRunBackendMock).not.toHaveBeenCalled();
  });
});
