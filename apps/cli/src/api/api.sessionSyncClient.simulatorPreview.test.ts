import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserAutomationActionResultV1Schema,
  FeaturesResponseSchema,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { createDaemonPeerMediationObservabilityStore } from '../daemon/peer/mediation/observability/store';
import { createPluginInvocationActionsService } from '../plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '../plugins/runtime/invocation/services/actionCaller.testkit';
import { createCliActionExecutor } from '../session/actions/createCliActionExecutor';

const apiSessionClientConstructorMock = vi.hoisted(() => vi.fn());

vi.mock('./session/sessionClient', () => ({
  ApiSessionClient: class {
    constructor(...args: unknown[]) {
      apiSessionClientConstructorMock(...args);
    }
  },
}));

vi.mock('./pushNotifications', () => ({
  PushNotificationClient: class {},
}));

vi.mock('./client/connectedServiceCredentialApi', () => ({
  createConnectedServiceCredentialApi: () => ({}),
  ConnectedServiceCredentialUnsupportedFormatError: class extends Error {},
}));

describe('ApiClient sessionSyncClient runtime-action routes', () => {
  beforeEach(() => {
    apiSessionClientConstructorMock.mockClear();
  });

  it('passes configured runtime-action route providers to session clients', async () => {
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({
      token: 'token_1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32),
      },
    } satisfies Credentials);
    const simulatorPreview = {
      getSnapshot: vi.fn(),
      dispatchAction: vi.fn(),
    };
    const localServices = {
      inventoryRoutes: {
        getSnapshot: vi.fn(),
        refreshSnapshot: vi.fn(),
      },
      launcherRoutes: {
        getSnapshot: vi.fn(),
      },
      previewRoutes: {
        getSnapshot: vi.fn(),
      },
      actionRoutes: {
        execute: vi.fn(),
      },
    };

    api.setLocalServicesRuntimeActionRoutesProvider(() => localServices);
    api.setSimulatorPreviewRoutesProvider(() => simulatorPreview);
    api.sessionSyncClient({ id: 'session_1' } as never);

    const options = apiSessionClientConstructorMock.mock.calls[0]?.[2] as Readonly<{
      getLocalServicesRuntimeActionRoutes?: () => unknown;
      getSimulatorPreviewRoutes?: () => unknown;
    }> | undefined;
    expect(options?.getLocalServicesRuntimeActionRoutes?.()).toBe(localServices);
    expect(options?.getSimulatorPreviewRoutes?.()).toBe(simulatorPreview);
  }, 60_000);

  it('passes the local runtime machine id to session clients', async () => {
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({
      token: 'token_1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32),
      },
    } satisfies Credentials);

    api.setLocalMachineId(' machine-local ');
    api.sessionSyncClient({ id: 'session_1' } as never);

    const options = apiSessionClientConstructorMock.mock.calls[0]?.[2] as Readonly<{
      localMachineId?: string;
    }> | undefined;
    expect(options?.localMachineId).toBe('machine-local');
  }, 60_000);

  it('dispatches plugin browser actions through the current daemon route owner', async () => {
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({
      token: 'token_1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32),
      },
    } satisfies Credentials);
    api.setServerFeaturesSnapshotProvider(() => ({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          browser: {
            enabled: true,
            viewTargets: { enabled: true },
            internal: { enabled: true },
            sidecar: { enabled: true },
          },
        },
      }),
    }));
    const firstDispatch = vi.fn(async (command: Readonly<{ commandId: string }>) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    }));
    const secondDispatch = vi.fn(async (command: Readonly<{ commandId: string }>) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    }));
    let currentRoutes = { dispatchCommand: firstDispatch };
    api.setBrowserDaemonControlRoutesProvider(() => currentRoutes);
    const execute = api.createBrowserRuntimeActionExecutor();
    const input = {
      kind: 'navigate',
      commandId: 'command-1',
      browserSessionId: 'browser-session-1',
      viewId: 'view-1',
      url: 'https://example.com',
    } as const;

    await expect(execute({
      actionId: 'browser.navigate',
      input,
      context: {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'acme.browser' },
      },
    })).resolves.toMatchObject({ status: 'dispatched' });

    currentRoutes = { dispatchCommand: secondDispatch };
    await expect(execute({
      actionId: 'browser.navigate',
      input: { ...input, commandId: 'command-2' },
      context: {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'acme.browser' },
      },
    })).resolves.toMatchObject({ commandId: 'command-2', status: 'dispatched' });
    expect(firstDispatch).toHaveBeenCalledOnce();
    expect(secondDispatch).toHaveBeenCalledOnce();

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(execute({
      actionId: 'browser.navigate',
      input: { ...input, commandId: 'command-cancelled' },
      context: {
        surface: 'plugin',
        actionCaller: { kind: 'plugin', pluginId: 'acme.browser' },
        signal: cancelled.signal,
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(secondDispatch).toHaveBeenCalledOnce();
  }, 60_000);

  it('gives a trusted plugin every backed daemon runtime-action family while retaining unbacked actions', async () => {
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({
      token: 'token_1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32),
      },
    } satisfies Credentials);
    api.setServerFeaturesSnapshotProvider(() => ({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          browser: {
            enabled: true,
            viewTargets: { enabled: true },
            internal: { enabled: true },
            sidecar: { enabled: true },
            diagnostics: { enabled: true },
            context: { enabled: true },
            automation: { enabled: true },
            recording: { enabled: true, attachments: { enabled: true } },
          },
          localServices: {
            enabled: true,
            inventory: { enabled: true },
          },
          devices: {
            enabled: true,
            simulatorPreview: { enabled: true },
          },
          machines: {
            enabled: true,
            liveStream: { enabled: true },
            peerMediation: {
              enabled: true,
              observability: { enabled: true },
            },
          },
        },
      }),
    }));

    const diagnosticsSnapshot = {
      v: 1 as const,
      machineId: 'machine_1',
      generatedAt: 2_000,
      refreshState: 'idle' as const,
      events: [],
      diagnostics: [],
    };
    const diagnosticsDispatch = vi.fn(async () => diagnosticsSnapshot);
    const contextDispatch = vi.fn(async () => ({
      v: 1 as const,
      kind: 'browserPageReference' as const,
      contextId: 'context_1',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'chromiumSidecar' as const,
      fidelity: 'cdp' as const,
      capturedAtMs: 2_000,
      navigationGeneration: 1,
      lifecycleState: 'available' as const,
      redactionLevel: 'metadataOnly' as const,
    }));
    const automationResult = BrowserAutomationActionResultV1Schema.parse({
      v: 1,
      automationRequestId: 'automation_1',
      status: 'succeeded',
      durationMs: 0,
      adapterKind: 'chromiumSidecar',
      fidelity: 'cdp',
      trustedInput: true,
      navigationGenerationBefore: 1,
      navigationGenerationAfter: 1,
      controlEpochBefore: 0,
      controlEpochAfter: 0,
    });
    const automationDispatch = vi.fn(async () => automationResult);
    const recordingStatus = vi.fn(async () => null);
    const inventorySnapshot = {
      v: 1 as const,
      machineId: 'machine_1',
      generatedAt: 2_000,
      refreshState: 'idle' as const,
      entries: [],
      diagnostics: [],
    };
    const inventoryGetSnapshot = vi.fn(async () => inventorySnapshot);
    const simulatorSnapshot = {
      v: 1 as const,
      machineId: 'machine_1',
      generatedAt: 2_000,
      refreshState: 'idle' as const,
      resources: [],
      diagnostics: [],
    };
    const simulatorGetSnapshot = vi.fn(async () => simulatorSnapshot);
    const simulatorDispatchAction = vi.fn();
    const peerMediationStore = createDaemonPeerMediationObservabilityStore({ nowMs: () => 2_000 });

    api.setBrowserDiagnosticsActionRoutesProvider(() => ({ dispatch: diagnosticsDispatch }));
    api.setBrowserDaemonContextRoutesProvider(() => ({ dispatch: contextDispatch }));
    api.setBrowserDaemonAutomationRoutesProvider(() => ({ dispatch: automationDispatch }));
    api.setBrowserRecordingRoutesProvider(() => ({
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      cancelRecording: vi.fn(),
      getRecordingStatus: recordingStatus,
      listRecordingsForView: vi.fn(),
      cleanupExpiredRecordings: vi.fn(),
    }) as never);
    api.setLocalServicesRuntimeActionRoutesProvider(() => ({
      inventoryRoutes: {
        getSnapshot: inventoryGetSnapshot,
        refreshSnapshot: vi.fn(),
      },
    }));
    api.setSimulatorPreviewRoutesProvider(() => ({
      getSnapshot: simulatorGetSnapshot,
      dispatchAction: simulatorDispatchAction,
    }) as never);
    api.setPeerMediationObservabilityRuntimeActionContextProvider(() => ({
      store: peerMediationStore,
      accountId: 'account_1',
      machineId: 'machine_1',
    }));

    const actionExecutor = createCliActionExecutor({
      token: 'token_1',
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      runtimeActionExecute: api.createBrowserRuntimeActionExecutor(),
    });
    const pluginId = 'com.example.runtime-actions';
    const callerMaterialization = createPluginActionCallerMaterializationFixture(pluginId);
    const service = createPluginInvocationActionsService({
      seed: {
        plugin: { id: pluginId, version: '1.0.0' },
        resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
        generation: 'generation_1',
        surface: 'cli',
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
      },
      actionExecutor,
      invokeContributedAction: vi.fn(),
    });

    await expect(service.execute('browser.diagnostics.snapshot', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
    })).resolves.toEqual(diagnosticsSnapshot);
    await expect(service.execute('browser.context.capturePage', {
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 1,
    })).resolves.toMatchObject({ contextId: 'context_1' });
    await expect(service.execute('browser.automation.snapshot', {
      v: 1,
      automationRequestId: 'automation_1',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      actionKind: 'snapshot',
      requestedBy: 'agent',
      requesterRef: { kind: 'agent', id: 'agent_1' },
      payload: {},
      timeoutMs: 5_000,
    })).resolves.toEqual(automationResult);
    await expect(service.execute('browser.recording.status', {
      recordingId: 'recording_1',
    })).resolves.toBeNull();
    await expect(service.execute('localServices.inventory.list', {
      machineId: 'machine_1',
    })).resolves.toEqual(inventorySnapshot);
    await expect(service.execute('peerMediation.observability.snapshot', {})).resolves.toMatchObject({
      ok: true,
      snapshot: { v: 1, scope: { kind: 'machine', accountId: 'account_1', machineId: 'machine_1' } },
    });
    await expect(service.execute('devices.simulator.list', {
      type: 'simulator.devices.list',
    })).resolves.toEqual(simulatorSnapshot);

    expect(diagnosticsDispatch).toHaveBeenCalledOnce();
    expect(contextDispatch).toHaveBeenCalledOnce();
    expect(automationDispatch).toHaveBeenCalledOnce();
    expect(recordingStatus).toHaveBeenCalledOnce();
    expect(inventoryGetSnapshot).toHaveBeenCalledOnce();
    expect(simulatorGetSnapshot).toHaveBeenCalledOnce();

    const runtimeActionExecute = api.createBrowserRuntimeActionExecutor();
    await expect(runtimeActionExecute({
      actionId: 'devices.simulator.input.orientation',
      input: {
        type: 'simulator.control.send',
        control: {
          v: 1,
          kind: 'orientation',
          streamId: 'stream_1',
          sourceId: 'source_1',
          eventId: 'orientation_1',
          leaseId: 'lease_1',
          orientation: 'landscapeLeft',
        },
      },
      context: {},
    })).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:devices.simulator:simulator_runtime_action_unbacked',
    });
    expect(simulatorDispatchAction).not.toHaveBeenCalled();
  }, 60_000);

  it('passes the scoped session-input transformer and post-admission attachment notifier to the session owner', async () => {
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create({
      token: 'token_1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32),
      },
    } satisfies Credentials);
    const transformSessionInputBeforeCommit = vi.fn(async (
      payload: Record<string, unknown>,
    ) => payload);
    const afterComposerAttachmentMessageAccepted = vi.fn(async () => undefined);

    api.sessionSyncClient(
      { id: 'session_1' } as never,
      {
        transformSessionInputBeforeCommit,
        afterComposerAttachmentMessageAccepted,
      },
    );

    const options = apiSessionClientConstructorMock.mock.calls[0]?.[2] as Readonly<{
      transformSessionInputBeforeCommit?: unknown;
      afterComposerAttachmentMessageAccepted?: unknown;
    }> | undefined;
    expect(options?.transformSessionInputBeforeCommit).toBe(
      transformSessionInputBeforeCommit,
    );
    expect(options?.afterComposerAttachmentMessageAccepted).toBe(
      afterComposerAttachmentMessageAccepted,
    );
  }, 60_000);
});
