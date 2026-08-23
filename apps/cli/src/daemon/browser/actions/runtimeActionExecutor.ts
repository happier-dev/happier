import {
  ACTION_ID_FAMILIES_V1,
  BrowserCommandV1Schema,
  createUnavailableRuntimeActionExecutor,
  getActionSpec,
  resolveRuntimeActionExecutionFamily,
  type ActionExecuteResult,
  type RuntimeActionExecute,
  type RuntimeActionExecuteArgs,
  type RuntimeActionIdV1,
} from '@happier-dev/protocol';

import type { BrowserDaemonControlRoutes } from '../control/routes';
import type { BrowserContextRoutes } from '../context/routes';
import type { BrowserAutomationRoutes } from '../automation/routes';
import type { BrowserDiagnosticsActionRoutes } from '../diagnostics/actionRoutes';
import type { BrowserRecordingActionRoutes } from '../recording/actionRoutes';
import type { BrowserDaemonFeatureGate } from '../featureGate';
import type {
  BrowserRecordingAttachToComposerInput,
  BrowserRecordingAttachToComposerResult,
} from '../recording/attachToComposer';

export type BrowserDaemonRuntimeActionDisabledReason =
  | 'browser_action_unbacked'
  | 'browser_automation_route_unavailable'
  | 'browser_context_route_unavailable'
  | 'browser_control_route_unavailable'
  | 'browser_diagnostics_route_unavailable'
  | 'browser_recording_attachments_unavailable'
  | 'browser_recording_route_unavailable';

type BrowserDaemonRuntimeActionFailure = Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

export type BrowserRecordingAttachToComposerExecutor = (
  input: BrowserRecordingAttachToComposerInput,
) => Promise<BrowserRecordingAttachToComposerResult>;

export type CreateBrowserDaemonRuntimeActionExecutorInput = Readonly<{
  control?: BrowserDaemonControlRoutes;
  context?: BrowserContextRoutes;
  automation?: BrowserAutomationRoutes;
  diagnostics?: BrowserDiagnosticsActionRoutes;
  // Non-attach `browser.recording.*` lifecycle (start/stop/cancel/status/listForView/discard/
  // cleanupExpired). `attachToComposer` keeps its dedicated `recordingAttach` executor below.
  recording?: BrowserRecordingActionRoutes;
  recordingAttach?: BrowserRecordingAttachToComposerExecutor;
  // OWNER-GATE: defense-in-depth at the action chokepoint. Each dispatchable browser family is
  // refused on server-disable even if a route owner was registered.
  featureGate: BrowserDaemonFeatureGate;
  fallback?: RuntimeActionExecute;
}>;

const BROWSER_CONTROL_ACTION_IDS = new Set<string>(ACTION_ID_FAMILIES_V1.browser_control);
const BROWSER_AUTOMATION_ACTION_IDS = new Set<string>(ACTION_ID_FAMILIES_V1.browser_automation);
const BROWSER_DIAGNOSTICS_ACTION_IDS = new Set<string>(ACTION_ID_FAMILIES_V1.browser_diagnostics);
const BROWSER_CONTEXT_ACTION_IDS = new Set<string>(ACTION_ID_FAMILIES_V1.browser_context);
const BROWSER_RECORDING_ACTION_IDS = new Set<string>(ACTION_ID_FAMILIES_V1.browser_recording);

const failClosedBrowserDaemonFeatureGate = {
  isEnabled: () => false,
  refresh: async () => {},
} satisfies BrowserDaemonFeatureGate;

const invalidParametersResult = {
  ok: false,
  errorCode: 'invalid_parameters',
  error: 'invalid_parameters',
} as const satisfies BrowserDaemonRuntimeActionFailure;

function browserRuntimeActionDisabledResult(
  reason: BrowserDaemonRuntimeActionDisabledReason,
): BrowserDaemonRuntimeActionFailure {
  return {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: `runtime_action_disabled:browser:${reason}`,
  };
}

function isBrowserRuntimeAction(actionId: RuntimeActionIdV1): boolean {
  return resolveRuntimeActionExecutionFamily(actionId) === 'browser';
}

function parseRuntimeActionInput(args: RuntimeActionExecuteArgs): Readonly<
  | { ok: true; input: unknown }
  | { ok: false; result: typeof invalidParametersResult }
> {
  const spec = getActionSpec(args.actionId);
  const parsed = spec.inputSchema.safeParse(args.input ?? {});
  return parsed.success
    ? { ok: true, input: parsed.data }
    : { ok: false, result: invalidParametersResult };
}

async function executeBrowserControlAction(
  args: RuntimeActionExecuteArgs,
  control: BrowserDaemonControlRoutes | undefined,
): Promise<unknown> {
  if (!control) {
    return browserRuntimeActionDisabledResult('browser_control_route_unavailable');
  }

  const parsed = parseRuntimeActionInput(args);
  if (!parsed.ok) return parsed.result;

  const command = BrowserCommandV1Schema.safeParse(parsed.input);
  if (!command.success) {
    return invalidParametersResult;
  }

  return await control.dispatchCommand(command.data);
}

async function executeBrowserContextAction(
  args: RuntimeActionExecuteArgs,
  context: BrowserContextRoutes | undefined,
): Promise<unknown> {
  if (!context) {
    return browserRuntimeActionDisabledResult('browser_context_route_unavailable');
  }
  return await context.dispatch(args.actionId, args.input);
}

async function executeBrowserAutomationAction(
  args: RuntimeActionExecuteArgs,
  automation: BrowserAutomationRoutes | undefined,
): Promise<unknown> {
  if (!automation) {
    return browserRuntimeActionDisabledResult('browser_automation_route_unavailable');
  }
  return await automation.dispatch(args.actionId, args.input);
}

async function executeBrowserRecordingAttachAction(
  args: RuntimeActionExecuteArgs,
  recordingAttach: BrowserRecordingAttachToComposerExecutor | undefined,
): Promise<unknown> {
  if (!recordingAttach) {
    return browserRuntimeActionDisabledResult('browser_recording_route_unavailable');
  }
  const parsed = parseRuntimeActionInput(args);
  if (!parsed.ok) return parsed.result;
  const record = parsed.input as Readonly<{ recordingId?: unknown; sessionId?: unknown }>;
  const recordingId = typeof record.recordingId === 'string' ? record.recordingId.trim() : '';
  if (!recordingId) {
    return invalidParametersResult;
  }
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  return await recordingAttach({
    recordingId,
    ...(sessionId ? { sessionId } : {}),
  });
}

export function createBrowserDaemonRuntimeActionExecutor(
  input: CreateBrowserDaemonRuntimeActionExecutorInput,
): RuntimeActionExecute {
  const fallback = input.fallback ?? createUnavailableRuntimeActionExecutor();
  const featureGate = input.featureGate ?? failClosedBrowserDaemonFeatureGate;

  return async (args) => {
    if (!isBrowserRuntimeAction(args.actionId)) {
      return await fallback(args);
    }

    // The ActionSpec's canonical agent surface keeps browser session lifecycle Actions private
    // until a daemon owner exists. Do not route them merely because they share the browser control
    // family with backed view commands.
    if (!getActionSpec(args.actionId).surfaces.agent) {
      return browserRuntimeActionDisabledResult('browser_action_unbacked');
    }

    if (BROWSER_CONTROL_ACTION_IDS.has(args.actionId)) {
      if (!featureGate.isEnabled('browser.sidecar')) {
        return browserRuntimeActionDisabledResult('browser_control_route_unavailable');
      }
      return await executeBrowserControlAction(args, input.control);
    }
    if (BROWSER_AUTOMATION_ACTION_IDS.has(args.actionId)) {
      if (!featureGate.isEnabled('browser.automation')) {
        return browserRuntimeActionDisabledResult('browser_automation_route_unavailable');
      }
      return await executeBrowserAutomationAction(args, input.automation);
    }
    if (BROWSER_DIAGNOSTICS_ACTION_IDS.has(args.actionId)) {
      if (!featureGate.isEnabled('browser.diagnostics')) {
        return browserRuntimeActionDisabledResult('browser_diagnostics_route_unavailable');
      }
      if (!input.diagnostics) {
        return browserRuntimeActionDisabledResult('browser_diagnostics_route_unavailable');
      }
      return await input.diagnostics.dispatch(args.actionId, args.input);
    }
    if (BROWSER_CONTEXT_ACTION_IDS.has(args.actionId)) {
      if (!featureGate.isEnabled('browser.context')) {
        return browserRuntimeActionDisabledResult('browser_context_route_unavailable');
      }
      return await executeBrowserContextAction(args, input.context);
    }
    if (BROWSER_RECORDING_ACTION_IDS.has(args.actionId)) {
      if (!featureGate.isEnabled('browser.recording')) {
        return browserRuntimeActionDisabledResult('browser_recording_route_unavailable');
      }
      if (args.actionId === 'browser.recording.attachToComposer') {
        if (!featureGate.isEnabled('browser.recording.attachments')) {
          return browserRuntimeActionDisabledResult('browser_recording_attachments_unavailable');
        }
        return await executeBrowserRecordingAttachAction(args, input.recordingAttach);
      }
      if (!input.recording) {
        return browserRuntimeActionDisabledResult('browser_recording_route_unavailable');
      }
      return await input.recording.dispatch(args.actionId, args.input);
    }
    return browserRuntimeActionDisabledResult('browser_action_unbacked');
  };
}
