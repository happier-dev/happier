import type {
  BrowserCommandV1,
  BrowserContextSnapshotV1,
  RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserDaemonControlRoutes } from '../control/routes';
import type { BrowserDaemonControlAdapter } from '../control/types';
import type { BrowserContextRoutes } from '../context/routes';
import type { BrowserAutomationRoutes } from '../automation/routes';
import type { BrowserDaemonFeatureGate, BrowserDaemonFeatureGateId } from '../featureGate';
import { createBrowserAutomationRoutes } from '../automation/routes';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createBrowserDiagnosticsDaemonStore, type BrowserDiagnosticsDaemonStore } from '../diagnostics/store';

type BrowserDaemonRuntimeActionExecutorModule = Readonly<{
  createBrowserDaemonRuntimeActionExecutor?: (input: Readonly<{
    control?: Readonly<{
      dispatchCommand?: (command: BrowserCommandV1) => Promise<unknown> | unknown;
    }>;
    context?: Readonly<{
      dispatch?: (actionId: string, commandInput: unknown) => Promise<unknown> | unknown;
    }>;
    automation?: Readonly<{
      dispatch?: (actionId: string, commandInput: unknown) => Promise<unknown> | unknown;
    }>;
    diagnostics?: Readonly<{
      dispatch?: (actionId: string, commandInput: unknown) => Promise<unknown> | unknown;
    }>;
    recording?: Readonly<{
      dispatch?: (actionId: string, commandInput: unknown) => Promise<unknown> | unknown;
    }>;
    recordingAttach?: (input: Readonly<{ recordingId: string; sessionId?: string }>) => Promise<unknown> | unknown;
    featureGate: BrowserDaemonFeatureGate;
  }>) => (args: RuntimeActionExecuteArgs) => Promise<unknown>;
}>;

function runtimeArgs(
  args: Omit<RuntimeActionExecuteArgs, 'context'> & Partial<Pick<RuntimeActionExecuteArgs, 'context'>>,
): RuntimeActionExecuteArgs {
  return {
    context: {},
    ...args,
  };
}

async function loadRuntimeActionExecutor(): Promise<BrowserDaemonRuntimeActionExecutorModule | null> {
  const path = './runtimeActionExecutor';
  return import(path) as Promise<BrowserDaemonRuntimeActionExecutorModule | null>;
}

const recordingStartInput = {
  browserSessionId: 'browser_session_1',
  viewId: 'view_1',
  profileId: 'profile_1',
  targetKind: 'simulatorPreview',
  adapterKind: 'simulatorPreview',
  renderEngineKind: 'streamedSurface',
  captureKind: 'streamFrameCapture',
  fidelity: 'streamFrame',
  navigationGeneration: 1,
  mimeType: 'video/webm',
  retentionClass: 'preSend',
  captureSource: {
    kind: 'machineLiveStream',
    streamFamily: 'simulator.preview',
    sourceId: 'source_1',
  },
} as const;

const browserAutomationView = {
  browserSessionId: 'browser_session_1',
  viewId: 'view_1',
} as const;

const browserAutomationAgentRef = { kind: 'agent', id: 'agent_1' } as const;

const allBrowserGateIds: readonly BrowserDaemonFeatureGateId[] = [
  'browser.sidecar',
  'browser.context',
  'browser.diagnostics',
  'browser.recording',
  'browser.recording.attachments',
  'attachments.uploads',
  'browser.automation',
];
const allBrowserGateIdSet: ReadonlySet<BrowserDaemonFeatureGateId> = new Set(allBrowserGateIds);

function allowAllBrowserGate(): BrowserDaemonFeatureGate {
  return {
    isEnabled: (id) => allBrowserGateIdSet.has(id),
    refresh: async () => {},
  };
}

function gateWith(enabled: Partial<Record<BrowserDaemonFeatureGateId, boolean>>): BrowserDaemonFeatureGate {
  return {
    isEnabled: (id) => enabled[id] === true,
    refresh: async () => {},
  };
}

function emptyDiagnosticsSnapshot() {
  return { v: 1 as const, machineId: 'm', generatedAt: 0, refreshState: 'idle' as const, events: [], diagnostics: [] };
}

function createDiagnosticsStoreStub(
  overrides: Partial<Pick<BrowserDiagnosticsDaemonStore, 'getSnapshot' | 'getViewSnapshot' | 'clearView' | 'clearSession'>> = {},
) {
  const getSnapshot = () => emptyDiagnosticsSnapshot();
  return {
    getSnapshot,
    getViewSnapshot: getSnapshot,
    clearView: vi.fn(),
    clearSession: vi.fn(),
    ...overrides,
  } satisfies Pick<BrowserDiagnosticsDaemonStore, 'getSnapshot' | 'getViewSnapshot' | 'clearView' | 'clearSession'>;
}

function controlAdapter(): BrowserDaemonControlAdapter {
  return {
    adapterKind: 'chromiumSidecar',
    ownsView: ({ browserSessionId, viewId }) =>
      browserSessionId === browserAutomationView.browserSessionId && viewId === browserAutomationView.viewId,
    supportsOpenView: () => false,
    dispatchCommand: vi.fn(async (command: BrowserCommandV1) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    })),
  };
}

function automationRequest(actionKind: string, payload: Record<string, unknown> = {}) {
  return {
    v: 1,
    automationRequestId: `req_${actionKind}`,
    ...browserAutomationView,
    navigationGeneration: 3,
    requestedBy: 'agent',
    requesterRef: browserAutomationAgentRef,
    actionKind,
    payload,
    timeoutMs: 5_000,
  };
}

describe('daemon browser runtime action executor', () => {
  it('returns the typed broker route result for browser control commands', async () => {
    const mod = await loadRuntimeActionExecutor();
    const routesMod = await import('../control/routes');
    const brokerMod = await import('../control/broker');

    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    expect(routesMod?.createBrowserDaemonControlRoutes).toBeTypeOf('function');
    expect(brokerMod?.createBrowserDaemonControlBroker).toBeTypeOf('function');
    if (
      !mod?.createBrowserDaemonRuntimeActionExecutor ||
      !routesMod?.createBrowserDaemonControlRoutes ||
      !brokerMod?.createBrowserDaemonControlBroker
    ) {
      return;
    }

    const broker = brokerMod.createBrowserDaemonControlBroker();
    const command = {
      kind: 'navigate',
      commandId: 'command_navigate',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://browser.example.test/next',
    } satisfies BrowserCommandV1;
    const dispatchCommand = vi.fn(async () => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    }));

    broker.registerAdapter({
      adapterKind: 'chromiumSidecar',
      ownsView: ({ browserSessionId, viewId }) => browserSessionId === 'browser_session_1' && viewId === 'view_1',
      supportsOpenView: () => false,
      dispatchCommand,
    });
    const execute = mod.createBrowserDaemonRuntimeActionExecutor({
      control: routesMod.createBrowserDaemonControlRoutes({ broker }),
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.navigate',
      input: command,
    }))).resolves.toEqual({
      v: 1,
      commandId: 'command_navigate',
      status: 'dispatched',
      adapterKind: 'chromiumSidecar',
      events: [],
    });
    expect(dispatchCommand).toHaveBeenCalledWith(command);
  });

  it('routes browser.navigate to the browser control command route when available', async () => {
    const mod = await loadRuntimeActionExecutor();

    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const command = {
      kind: 'navigate',
      commandId: 'command_navigate',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://browser.example.test/next',
    } satisfies BrowserCommandV1;
    const dispatchCommand = vi.fn(async () => ({
      v: 1,
      accepted: true,
      commandId: command.commandId,
    }));
    const execute = mod.createBrowserDaemonRuntimeActionExecutor({
      control: { dispatchCommand },
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.navigate',
      input: command,
    }))).resolves.toEqual({
      v: 1,
      accepted: true,
      commandId: 'command_navigate',
    });
    expect(dispatchCommand).toHaveBeenCalledWith(command);
  });

  it('fails closed before daemon dispatch when a browser Action id carries another command kind', async () => {
    const mod = await loadRuntimeActionExecutor();

    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const dispatchCommand = vi.fn(async () => ({
      v: 1,
      accepted: true,
      commandId: 'command_mismatched',
    }));
    const execute = mod.createBrowserDaemonRuntimeActionExecutor({
      control: { dispatchCommand },
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.view.focus',
      input: {
        kind: 'navigate',
        commandId: 'command_mismatched',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://browser.example.test/escaped-navigation',
      } satisfies BrowserCommandV1,
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it('fails closed instead of no-oping browser control when no command route is available', async () => {
    const mod = await loadRuntimeActionExecutor();

    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const execute = mod.createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });

    await expect(execute(runtimeArgs({
      actionId: 'browser.navigate',
      input: {
        kind: 'navigate',
        commandId: 'command_missing_route',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://browser.example.test/next',
      } satisfies BrowserCommandV1,
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_control_route_unavailable',
    });
  });

  it('routes browser.context.capturePage to the context route when available', async () => {
    const mod = await loadRuntimeActionExecutor();
    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const dispatch = vi.fn(async () => ({ v: 1, kind: 'browserPageReference', contextId: 'context_1' }));
    const execute = mod.createBrowserDaemonRuntimeActionExecutor({
      context: { dispatch },
      featureGate: allowAllBrowserGate(),
    });

    const input = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 2 };
    await expect(execute(runtimeArgs({
      actionId: 'browser.context.capturePage',
      input,
    }))).resolves.toEqual({ v: 1, kind: 'browserPageReference', contextId: 'context_1' });
    expect(dispatch).toHaveBeenCalledWith('browser.context.capturePage', input);
  });

  it('routes browser.automation.snapshot to the automation route when available', async () => {
    const mod = await loadRuntimeActionExecutor();
    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const dispatch = vi.fn(async () => ({ v: 1, status: 'succeeded' }));
    const execute = mod.createBrowserDaemonRuntimeActionExecutor({
      automation: { dispatch },
      featureGate: allowAllBrowserGate(),
    });

    const input = {
      v: 1,
      automationRequestId: 'req_1',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 1,
      requestedBy: 'agent',
      requesterRef: { kind: 'agent', id: 'agent_1' },
      actionKind: 'snapshot',
      payload: {},
      timeoutMs: 5000,
    };
    await expect(execute(runtimeArgs({
      actionId: 'browser.automation.snapshot',
      input,
    }))).resolves.toEqual({ v: 1, status: 'succeeded' });
    expect(dispatch).toHaveBeenCalledWith('browser.automation.snapshot', input);
  });

  it('returns rich snapshot selectors through the real browser automation action path', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const captureSnapshot = vi.fn(async (): Promise<BrowserContextSnapshotV1> => ({
      v: 1,
      contextId: 'browser_session_1 view_1 3',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'chromiumSidecar',
      fidelity: 'cdp',
      capturedAtMs: 123,
      navigationGeneration: 3,
      redactionLevel: 'none',
      visibleText: 'Welcome back',
      visibleTextTruncated: false,
      axNodes: [{ role: 'button', name: 'Submit' }],
      axNodesTruncated: false,
      interactiveElements: [
        { role: 'button', name: 'Submit', selector: '#submit', rect: { x: 10, y: 20, width: 80, height: 32 } },
      ],
      interactiveElementsTruncated: false,
      consoleSummary: '[log] ready',
      consoleTruncated: false,
      media: { mediaId: 'media_snapshot', mediaKind: 'image', width: 800, height: 600, sizeBytes: 4096 },
    }));
    const service = createBrowserAutomationDaemonService({
      adapter: createBrowserAutomationCdpAdapter({
        transport: createControlAdapterAutomationTransport({
          adapter: controlAdapter(),
          browserContext: { captureSnapshot },
        }),
      }),
    });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      automation: createBrowserAutomationRoutes({ service }),
      featureGate: allowAllBrowserGate(),
    });

    const result = await execute(runtimeArgs({
      actionId: 'browser.automation.snapshot',
      input: automationRequest('snapshot'),
    }));

    expect(captureSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 3,
    }));
    expect(result).toMatchObject({
      status: 'succeeded',
      resultSummary: {
        visibleText: 'Welcome back',
        axNodes: [{ role: 'button', name: 'Submit' }],
        interactiveElements: [
          { role: 'button', name: 'Submit', selector: '#submit' },
        ],
        consoleSummary: '[log] ready',
      },
    });
  });

  it('resolves semantic locators through the real automation input action path', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const contextCapture = {
      transport: {
        dispatchPageCommand: vi.fn(async (input: { method: string; params?: Record<string, unknown> }) => {
          cdpCalls.push({ method: input.method, ...(input.params ? { params: input.params } : {}) });
          if (input.method !== 'Runtime.evaluate') return {};
          const expression = typeof input.params?.expression === 'string' ? input.params.expression : '';
          if (expression.includes('querySelector("role=')) {
            return { result: { type: 'object', value: null } };
          }
          if (expression.includes('getAttribute') && expression.includes('button') && expression.includes('Save')) {
            return { result: { type: 'object', value: { x: 40, y: 24 } } };
          }
          return { result: { type: 'object', value: null } };
        }),
      },
      resolvePageHandle: () => ({ targetId: 'target_1', sessionId: 'session_1' }),
    };
    const service = createBrowserAutomationDaemonService({
      adapter: createBrowserAutomationCdpAdapter({
        transport: createControlAdapterAutomationTransport({
          adapter: controlAdapter(),
          contextCapture,
        }),
      }),
    });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      automation: createBrowserAutomationRoutes({ service }),
      featureGate: allowAllBrowserGate(),
    });

    const result = await execute(runtimeArgs({
      actionId: 'browser.automation.click',
      input: automationRequest('click', { selector: 'role=button[name="Save"]' }),
    }));

    expect(result).toMatchObject({ status: 'succeeded' });
    const expressions = cdpCalls
      .filter((call) => call.method === 'Runtime.evaluate')
      .map((call) => String(call.params?.expression ?? ''));
    expect(expressions.some((expression) => expression.includes('querySelector("role='))).toBe(false);
    expect(expressions.some((expression) => expression.includes('getAttribute') && expression.includes('Save'))).toBe(true);
    const pressed = cdpCalls.find((call) => (
      call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed'
    ));
    expect(pressed?.params).toMatchObject({ x: 40, y: 24, button: 'left' });
  });

  it('fails closed for browser.context actions when no context route is available', async () => {
    const mod = await loadRuntimeActionExecutor();
    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const execute = mod.createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });

    await expect(execute(runtimeArgs({
      actionId: 'browser.context.capturePage',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_context_route_unavailable',
    });
  });

  it('fails closed for browser.automation actions when no automation route is available', async () => {
    const mod = await loadRuntimeActionExecutor();
    expect(mod?.createBrowserDaemonRuntimeActionExecutor).toBeTypeOf('function');
    if (!mod?.createBrowserDaemonRuntimeActionExecutor) return;

    const execute = mod.createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });

    await expect(execute(runtimeArgs({
      actionId: 'browser.automation.snapshot',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_automation_route_unavailable',
    });
  });

  it('dispatches browser.recording.attachToComposer to the recording-attach executor', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const recordingAttach = vi.fn(async (input: Readonly<{ recordingId: string; sessionId?: string }>) => ({
      ok: true as const,
      attachmentId: `attachment_${input.recordingId}`,
    }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recordingAttach,
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.attachToComposer',
      input: { recordingId: 'browser_recording_1', sessionId: 'session_1' },
    }))).resolves.toEqual({ ok: true, attachmentId: 'attachment_browser_recording_1' });
    expect(recordingAttach).toHaveBeenCalledWith({ recordingId: 'browser_recording_1', sessionId: 'session_1' });
  });

  it('fails closed for browser.recording.attachToComposer when no attach executor is available', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.attachToComposer',
      input: { recordingId: 'browser_recording_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_recording_route_unavailable',
    });
  });

  it('keeps other browser.recording actions fail-closed (no producer route)', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recordingAttach: vi.fn(async () => ({ ok: true as const, attachmentId: 'x' })),
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.start',
      input: recordingStartInput,
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_recording_route_unavailable',
    });
  });

  // OWNER-GATE action-execution chokepoint. The gate refuses each dispatchable family on
  // server-disable even when the route owner is present.
  it('refuses browser automation actions when browser.automation is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatch = vi.fn<BrowserAutomationRoutes['dispatch']>();
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      automation: { dispatch },
      featureGate: gateWith({ 'browser.automation': false }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.automation.snapshot',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_automation_route_unavailable',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses browser context actions when browser.context is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatch = vi.fn<BrowserContextRoutes['dispatch']>();
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      context: { dispatch },
      featureGate: gateWith({ 'browser.context': false }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.context.capturePage',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_context_route_unavailable',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses browser control actions when browser.sidecar is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatchCommand = vi.fn<BrowserDaemonControlRoutes['dispatchCommand']>();
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      control: { dispatchCommand },
      featureGate: gateWith({ 'browser.sidecar': false }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.navigate',
      input: {
        kind: 'navigate',
        commandId: 'command_navigate',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://browser.example.test/next',
      } satisfies BrowserCommandV1,
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_control_route_unavailable',
    });
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it('refuses browser.recording.attachToComposer when browser.recording is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const recordingAttach = vi.fn(async () => ({ ok: true as const, attachmentId: 'x' }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recordingAttach,
      featureGate: gateWith({ 'browser.recording': false }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.attachToComposer',
      input: { recordingId: 'browser_recording_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_recording_route_unavailable',
    });
    expect(recordingAttach).not.toHaveBeenCalled();
  });

  it('refuses browser.recording.attachToComposer when browser.recording.attachments is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const recordingAttach = vi.fn(async () => ({ ok: true as const, attachmentId: 'x' }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recordingAttach,
      featureGate: gateWith({
        'browser.recording': true,
        'browser.context': true,
        'attachments.uploads': true,
        'browser.recording.attachments': false,
      }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.attachToComposer',
      input: { recordingId: 'browser_recording_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_recording_attachments_unavailable',
    });
    expect(recordingAttach).not.toHaveBeenCalled();
  });

  it('still dispatches each family when the gate is enabled and a route owner is present', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatchCommand = vi.fn<BrowserDaemonControlRoutes['dispatchCommand']>();
    const contextDispatch = vi.fn<BrowserContextRoutes['dispatch']>();
    const automationDispatch = vi.fn<BrowserAutomationRoutes['dispatch']>();
    const recordingAttach = vi.fn(async () => ({ ok: true as const, attachmentId: 'attachment_x' }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      control: { dispatchCommand },
      context: { dispatch: contextDispatch },
      automation: { dispatch: automationDispatch },
      recordingAttach,
      featureGate: gateWith({
        'browser.sidecar': true,
        'browser.context': true,
        'browser.automation': true,
        'browser.recording': true,
        'browser.recording.attachments': true,
      }),
    });

    await execute(runtimeArgs({
      actionId: 'browser.navigate',
      input: {
        kind: 'navigate',
        commandId: 'command_navigate',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://browser.example.test/next',
      } satisfies BrowserCommandV1,
    }));
    await execute(runtimeArgs({ actionId: 'browser.context.capturePage', input: { browserSessionId: 'browser_session_1', viewId: 'view_1' } }));
    await execute(runtimeArgs({ actionId: 'browser.automation.snapshot', input: { browserSessionId: 'browser_session_1', viewId: 'view_1' } }));
    await execute(runtimeArgs({ actionId: 'browser.recording.attachToComposer', input: { recordingId: 'browser_recording_1' } }));

    expect(dispatchCommand).toHaveBeenCalledOnce();
    expect(contextDispatch).toHaveBeenCalledOnce();
    expect(automationDispatch).toHaveBeenCalledOnce();
    expect(recordingAttach).toHaveBeenCalledOnce();
  });

  // DEV-5: the diagnostics family executor. The route-contract gate is that a dispatched
  // `browser.diagnostics.snapshot` REACHES the route end-to-end (not `*_route_unavailable`).
  it('DEV-5 route contract: browser.diagnostics.snapshot reaches the diagnostics route, not *_route_unavailable', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const storeMod = await import('../diagnostics/store');

    const store = storeMod.createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 1000 });
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({ store });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    const result = await execute(runtimeArgs({
      actionId: 'browser.diagnostics.snapshot',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }));

    // The contract: the snapshot reaches the store-backed route and returns a real snapshot
    // envelope — NOT the `browser_diagnostics_route_unavailable` hard failure.
    expect(result).not.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
    expect(result).toMatchObject({ v: 1, machineId: 'machine_1', events: [] });
  });

  it('DEV-5: browser.diagnostics.clear routes to the store clearView', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const clearView = vi.fn();
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStoreStub({ clearView }),
    });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.clear',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({ ok: true });
    expect(clearView).toHaveBeenCalledWith({ browserSessionId: 'browser_session_1', viewId: 'view_1' });
  });

  it('DEV-5: interaction verbs reach the live interaction transport when present', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const interactionDispatch = vi.fn(async () => ({ ok: true as const, kind: 'paused' }));
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStoreStub(),
      interaction: { dispatch: interactionDispatch, dispose: vi.fn() },
    });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    await execute(runtimeArgs({
      actionId: 'browser.diagnostics.pause',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }));
    expect(interactionDispatch).toHaveBeenCalledOnce();
  });

  it('DEV-5: interaction verbs fail closed when no live transport is wired', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStoreStub(),
    });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.eval',
      input: {
        v: 1,
        evalRequestId: 'eval_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        tier: 'injectedPage',
        expression: 'document.title',
        objectGroupId: 'group_1',
        diagnosticsInteractionEnabled: true,
      },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
  });

  // DIAG-INTERACTION (H1 execution-crossing DONE gate): the interaction verbs reach a LIVE CDP result
  // through the production-assembled route owner — the REAL interaction transport bound to a
  // TEST-DOUBLE sidecar CDP transport — not a fake interaction dispatch. Without the transport the
  // same assembled owner fails closed honestly.
  const PICKER_HANDLE = { targetId: 'target_1', sessionId: 'cdp_session_1' } as const;

  const buildLiveInteraction = async () => {
    const interactionMod = await import('../diagnostics/interactionTransport');
    const lifecycle = {
      current: null as ((event: { type: 'bound' | 'unbound'; browserSessionId: string; viewId: string }) => void) | null,
    };
    let cdpListener: ((notification: { method: string; params?: Record<string, unknown>; sessionId?: string }) => void) | null = null;
    const dispatchPageCommand = vi.fn(async ({ method, params }: { method: string; params?: Record<string, unknown> }) => {
      if (method === 'Overlay.setInspectMode' && params?.mode === 'searchForNode') {
        cdpListener?.({ method: 'Overlay.inspectNodeRequested', params: { backendNodeId: 7 }, sessionId: 'cdp_session_1' });
      }
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'live', description: 'live' } };
      if (method === 'Runtime.getProperties') {
        return { result: [{ name: 'len', value: { type: 'number', value: 3 }, enumerable: true }] };
      }
      return {};
    });
    const interaction = interactionMod.createBrowserDiagnosticsInteractionTransport({
      contextCapture: {
        transport: { dispatchPageCommand },
        resolvePageHandle: (view) =>
          view.viewId === 'view_1' && view.browserSessionId === 'browser_session_1' ? PICKER_HANDLE : null,
        subscribeViewLifecycle: (listener) => {
          lifecycle.current = listener;
          return () => undefined;
        },
        subscribeCdpEvents: (listener) => {
          cdpListener = listener;
          return () => undefined;
        },
      },
    });
    // The control adapter emits this binding when the sidecar opens the page.
    lifecycle.current?.({ type: 'bound', browserSessionId: 'browser_session_1', viewId: 'view_1' });
    return interaction;
  };

  const createDiagnosticsStore = () => createBrowserDiagnosticsDaemonStore({ machineId: 'm', now: () => 0 });

  it('DIAG-INTERACTION (H1): eval/getProperties/elementPicker reach a LIVE CDP result through the assembled route owner', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const interaction = await buildLiveInteraction();
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({ store: createDiagnosticsStore(), interaction });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    const evalResult = await execute(runtimeArgs({
      actionId: 'browser.diagnostics.eval',
      input: {
        v: 1,
        evalRequestId: 'eval_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        tier: 'cdp',
        expression: 'location.href',
        objectGroupId: 'group_1',
        diagnosticsInteractionEnabled: true,
      },
    }));
    expect(evalResult).toMatchObject({ status: 'completed', result: { type: 'string', value: 'live' } });

    const propertiesResult = await execute(runtimeArgs({
      actionId: 'browser.diagnostics.getProperties',
      input: {
        v: 1,
        propertyRequestId: 'prop_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        tier: 'cdp',
        objectId: 'object_1',
        objectGroupId: 'group_1',
        diagnosticsInteractionEnabled: true,
      },
    }));
    expect(propertiesResult).toMatchObject({ status: 'completed', objectId: 'object_1', properties: [{ name: 'len' }] });

    const pickerResult = await execute(runtimeArgs({
      actionId: 'browser.diagnostics.elementPicker.start',
      input: {
        v: 1,
        pickerRequestId: 'picker_1',
        viewId: 'view_1',
        navigationGeneration: 0,
        tier: 'cdp',
        action: 'start',
        diagnosticsInteractionEnabled: true,
      },
    }));
    expect(pickerResult).toMatchObject({ status: 'selected', backendNodeRef: '7' });
  });

  it('DIAG-INTERACTION (H1): eval/getProperties/elementPicker fail closed when no interaction transport is bound', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({ store: createDiagnosticsStore() });
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics,
      featureGate: allowAllBrowserGate(),
    });

    const unavailable = {
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    };
    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.eval',
      input: {
        v: 1, evalRequestId: 'eval_1', viewId: 'view_1', navigationGeneration: 0, tier: 'cdp',
        expression: 'location.href', objectGroupId: 'group_1', diagnosticsInteractionEnabled: true,
      },
    }))).resolves.toEqual(unavailable);
    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.getProperties',
      input: {
        v: 1, propertyRequestId: 'prop_1', viewId: 'view_1', navigationGeneration: 0, tier: 'cdp',
        objectId: 'object_1', objectGroupId: 'group_1', diagnosticsInteractionEnabled: true,
      },
    }))).resolves.toEqual(unavailable);
    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.elementPicker.start',
      input: {
        v: 1, pickerRequestId: 'picker_1', viewId: 'view_1', navigationGeneration: 0, tier: 'cdp',
        action: 'start', diagnosticsInteractionEnabled: true,
      },
    }))).resolves.toEqual(unavailable);
  });

  it('DEV-5: fails closed for browser.diagnostics when no diagnostics route owner is present', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({ featureGate: allowAllBrowserGate() });

    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.snapshot',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
  });

  it('DEV-5: refuses browser.diagnostics when browser.diagnostics is server-disabled', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const actionRoutesMod = await import('../diagnostics/actionRoutes');
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    const diagnostics = actionRoutesMod.createBrowserDiagnosticsActionRoutes({
      store: createDiagnosticsStoreStub(),
    });
    // Wrap dispatch so we can assert it is never reached when gated off.
    const gatedDiagnostics = { dispatch };
    void diagnostics;
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      diagnostics: gatedDiagnostics,
      featureGate: gateWith({ 'browser.diagnostics': false }),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.diagnostics.snapshot',
      input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_diagnostics_route_unavailable',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  // BA-5: the non-attach recording lifecycle reaches the service-backed recording route owner.
  it('BA-5: browser.recording.start routes to the recording action route owner', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatch = vi.fn(async () => ({ status: 'started' as const, recording: { recordingId: 'browser_recording_1' } }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recording: { dispatch },
      featureGate: allowAllBrowserGate(),
    });

    const input = recordingStartInput;
    await expect(execute(runtimeArgs({ actionId: 'browser.recording.start', input })))
      .resolves.toEqual({ status: 'started', recording: { recordingId: 'browser_recording_1' } });
    expect(dispatch).toHaveBeenCalledWith('browser.recording.start', input);
  });

  it('BA-5: browser.recording.stop/cancel/status/listForView/discard/cleanupExpired all route to the owner', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recording: { dispatch },
      featureGate: allowAllBrowserGate(),
    });

    for (const actionId of [
      'browser.recording.stop',
      'browser.recording.cancel',
      'browser.recording.status',
      'browser.recording.listForView',
      'browser.recording.discard',
      'browser.recording.cleanupExpired',
    ] as const) {
      await execute(runtimeArgs({ actionId, input: { browserSessionId: 'browser_session_1', viewId: 'view_1', recordingId: 'browser_recording_1' } }));
    }
    expect(dispatch).toHaveBeenCalledTimes(6);
  });

  it('BA-5: browser.recording.start fails closed when no recording route owner is present', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recordingAttach: vi.fn(async () => ({ ok: true as const, attachmentId: 'x' })),
      featureGate: allowAllBrowserGate(),
    });

    await expect(execute(runtimeArgs({
      actionId: 'browser.recording.start',
      input: recordingStartInput,
    }))).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:browser:browser_recording_route_unavailable',
    });
  });

  it('BA-5: attachToComposer still routes to the dedicated attach executor (not the lifecycle owner)', async () => {
    const realMod = await import('./runtimeActionExecutor');
    const recordingDispatch = vi.fn(async () => ({ ok: true as const }));
    const recordingAttach = vi.fn(async () => ({ ok: true as const, attachmentId: 'attachment_1' }));
    const execute = realMod.createBrowserDaemonRuntimeActionExecutor({
      recording: { dispatch: recordingDispatch },
      recordingAttach,
      featureGate: allowAllBrowserGate(),
    });

    await execute(runtimeArgs({
      actionId: 'browser.recording.attachToComposer',
      input: { recordingId: 'browser_recording_1' },
    }));
    expect(recordingAttach).toHaveBeenCalledOnce();
    expect(recordingDispatch).not.toHaveBeenCalled();
  });
});
