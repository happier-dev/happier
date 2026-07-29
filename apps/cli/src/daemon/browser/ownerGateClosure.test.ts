import type { RuntimeActionExecuteArgs } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserDaemonFeatureGate, BrowserDaemonFeatureGateId } from './featureGate';
import {
  createBrowserDaemonRuntimeActionExecutor,
  type CreateBrowserDaemonRuntimeActionExecutorInput,
} from './actions/runtimeActionExecutor';

type BrowserRouteCalls = Readonly<{
  control: ReturnType<typeof vi.fn>;
  context: ReturnType<typeof vi.fn>;
  automation: ReturnType<typeof vi.fn>;
  diagnostics: ReturnType<typeof vi.fn>;
  recording: ReturnType<typeof vi.fn>;
  recordingAttach: ReturnType<typeof vi.fn>;
}>;

type BrowserGateCase = Readonly<{
  name: string;
  actionId: RuntimeActionExecuteArgs['actionId'];
  input: unknown;
  disabledReason: string;
  routeCall: keyof BrowserRouteCalls;
}>;

const browserViewInput = {
  browserSessionId: 'browser_session_1',
  viewId: 'view_1',
  navigationGeneration: 1,
} as const;

const browserGateCases: readonly BrowserGateCase[] = [
  {
    name: 'control',
    actionId: 'browser.navigate',
    input: {
      kind: 'navigate',
      commandId: 'command_1',
      browserSessionId: browserViewInput.browserSessionId,
      viewId: browserViewInput.viewId,
      url: 'https://browser.example.test',
    },
    disabledReason: 'browser_control_route_unavailable',
    routeCall: 'control',
  },
  {
    name: 'automation',
    actionId: 'browser.automation.snapshot',
    input: {
      v: 1,
      automationRequestId: 'automation_request_1',
      ...browserViewInput,
      requestedBy: 'agent',
      requesterRef: { kind: 'agent', id: 'agent_1' },
      actionKind: 'snapshot',
      payload: {},
      timeoutMs: 5_000,
    },
    disabledReason: 'browser_automation_route_unavailable',
    routeCall: 'automation',
  },
  {
    name: 'diagnostics',
    actionId: 'browser.diagnostics.snapshot',
    input: browserViewInput,
    disabledReason: 'browser_diagnostics_route_unavailable',
    routeCall: 'diagnostics',
  },
  {
    name: 'context',
    actionId: 'browser.context.capturePage',
    input: browserViewInput,
    disabledReason: 'browser_context_route_unavailable',
    routeCall: 'context',
  },
  {
    name: 'recording',
    actionId: 'browser.recording.status',
    input: { recordingId: 'recording_1' },
    disabledReason: 'browser_recording_route_unavailable',
    routeCall: 'recording',
  },
  {
    name: 'recording attachments',
    actionId: 'browser.recording.attachToComposer',
    input: { recordingId: 'recording_1', sessionId: 'session_1' },
    disabledReason: 'browser_recording_route_unavailable',
    routeCall: 'recordingAttach',
  },
];

function disabledResult(reason: string) {
  return {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: `runtime_action_disabled:browser:${reason}`,
  };
}

function runtimeArgs(
  actionId: RuntimeActionExecuteArgs['actionId'],
  input: unknown,
): RuntimeActionExecuteArgs {
  return {
    actionId,
    input,
    context: { surface: 'agent' },
  };
}

function createRouteCalls(): BrowserRouteCalls {
  return {
    control: vi.fn(async () => ({ ok: true, route: 'control' })),
    context: vi.fn(async () => ({ ok: true, route: 'context' })),
    automation: vi.fn(async () => ({ ok: true, route: 'automation' })),
    diagnostics: vi.fn(async () => ({ ok: true, route: 'diagnostics' })),
    recording: vi.fn(async () => ({ ok: true, route: 'recording' })),
    recordingAttach: vi.fn(async () => ({ ok: true, route: 'recordingAttach' })),
  };
}

function createExecutorInput(calls: BrowserRouteCalls): Omit<CreateBrowserDaemonRuntimeActionExecutorInput, 'featureGate'> {
  return {
    control: { dispatchCommand: calls.control },
    context: { dispatch: calls.context },
    automation: { dispatch: calls.automation },
    diagnostics: { dispatch: calls.diagnostics },
    recording: { dispatch: calls.recording },
    recordingAttach: calls.recordingAttach,
  };
}

function featureGate(isEnabled: (featureId: BrowserDaemonFeatureGateId) => boolean): BrowserDaemonFeatureGate {
  return {
    isEnabled,
    refresh: vi.fn(async () => {}),
  };
}

describe('OWNER-GATE daemon-boundary closure', () => {
  it.each(browserGateCases)(
    'fails closed for $name actions when the browser feature gate is omitted by an untyped caller',
    async ({ actionId, input, disabledReason, routeCall }) => {
      const calls = createRouteCalls();
      const unsafeInput = createExecutorInput(calls);
      // Runtime compatibility guard: JavaScript or stale compiled callers can omit the now-required
      // gate. The executor must still fail closed before any privileged browser route dispatches.
      const execute = createBrowserDaemonRuntimeActionExecutor(
        unsafeInput as CreateBrowserDaemonRuntimeActionExecutorInput,
      );

      await expect(execute(runtimeArgs(actionId, input))).resolves.toEqual(disabledResult(disabledReason));
      expect(calls[routeCall]).not.toHaveBeenCalled();
    },
  );

  it.each(browserGateCases)(
    'fails closed for $name actions when the browser feature gate returns false',
    async ({ actionId, input, disabledReason, routeCall }) => {
      const calls = createRouteCalls();
      const execute = createBrowserDaemonRuntimeActionExecutor({
        ...createExecutorInput(calls),
        featureGate: featureGate(() => false),
      });

      await expect(execute(runtimeArgs(actionId, input))).resolves.toEqual(disabledResult(disabledReason));
      expect(calls[routeCall]).not.toHaveBeenCalled();
    },
  );

  it('checks the narrower browser.recording.attachments gate after browser.recording is enabled', async () => {
    const calls = createRouteCalls();
    const execute = createBrowserDaemonRuntimeActionExecutor({
      ...createExecutorInput(calls),
      featureGate: featureGate((featureId) => featureId === 'browser.recording'),
    });

    await expect(execute(runtimeArgs(
      'browser.recording.attachToComposer',
      { recordingId: 'recording_1', sessionId: 'session_1' },
    ))).resolves.toEqual(disabledResult('browser_recording_attachments_unavailable'));
    expect(calls.recordingAttach).not.toHaveBeenCalled();
  });
});
