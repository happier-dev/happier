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
  // The managed browser runtime is being fetched right now because this dispatch asked for it.
  // A ~150MB download behind an action that looks like it did nothing is the silent-stall class
  // this program is closing, so it gets its own typed outcome the UI can render.
  | 'browser_automation_runtime_provisioning'
  | 'browser_automation_runtime_provisioning_failed'
  | 'browser_context_route_unavailable'
  | 'browser_control_route_unavailable'
  | 'browser_diagnostics_route_unavailable'
  | 'browser_recording_attachments_unavailable'
  | 'browser_recording_route_unavailable';

type BrowserDaemonRuntimeActionFailure = Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

export type BrowserRecordingAttachToComposerExecutor = (
  input: BrowserRecordingAttachToComposerInput,
) => Promise<BrowserRecordingAttachToComposerResult>;

/**
 * What a provisioning attempt says about the managed browser runtime.
 *
 * - `provisioning` — an install is now in flight (single-flighted by the provisioning owner, so
 *   concurrent dispatches join the same one rather than starting a second download).
 * - `failed` — an install was attempted and did not succeed.
 * - `unavailable` — nothing can be provisioned on this host at all (unsupported platform, or a
 *   pinned asset with no verifiable digest). This is the pre-existing honest answer and keeps the
 *   pre-existing reason code.
 */
export type BrowserAutomationRuntimeProvisionOutcome =
  | 'provisioning'
  | 'failed'
  | 'unavailable';

export type ProvisionBrowserAutomationRuntime =
  () => Promise<BrowserAutomationRuntimeProvisionOutcome>;

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
  /**
   * Dispatch-time provisioning for the managed browser runtime (user ruling, 2026-08-23). The
   * ~150MB Chrome-for-Testing fetch is acceptable as a consequence of an agent asking for
   * automation, and unacceptable as a silent cost on every daemon start — including machines that
   * never touch the browser. So the daemon startup gate passes `autoInstallWhenMissing: false` and
   * the install is triggered from HERE, the one seam every `browser.automation.*` dispatch reaches
   * when no route exists. Absent ⇒ the family stays fail-closed exactly as before.
   */
  provisionAutomationRuntime?: ProvisionBrowserAutomationRuntime;
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

const PROVISION_OUTCOME_REASONS = {
  provisioning: 'browser_automation_runtime_provisioning',
  failed: 'browser_automation_runtime_provisioning_failed',
  unavailable: 'browser_automation_route_unavailable',
} as const satisfies Record<
  BrowserAutomationRuntimeProvisionOutcome,
  BrowserDaemonRuntimeActionDisabledReason
>;

async function executeBrowserAutomationAction(
  args: RuntimeActionExecuteArgs,
  automation: BrowserAutomationRoutes | undefined,
  provisionAutomationRuntime: ProvisionBrowserAutomationRuntime | undefined,
): Promise<unknown> {
  if (!automation) {
    // No route means the sidecar adapter failed closed at startup, and on an unprovisioned host
    // that is `managed_package_missing`. Asking for automation is what authorizes the fetch, so
    // this is where it starts. The dispatch does not wait for a 150MB download: it returns a typed
    // in-flight outcome, and the next dispatch finds the route (route owners are re-resolved per
    // dispatch, so no restart is needed).
    if (!provisionAutomationRuntime) {
      return browserRuntimeActionDisabledResult('browser_automation_route_unavailable');
    }
    return browserRuntimeActionDisabledResult(
      PROVISION_OUTCOME_REASONS[await provisionAutomationRuntime()],
    );
  }
  return await automation.dispatch(args.actionId, args.input, args.context);
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

    // The ActionSpec's canonical agent surface is the single authority on which browser Actions a
    // caller may reach; a family member excluded from `RUNTIME_ACTION_REAL_EXECUTOR_*` is refused
    // here rather than routed on family membership alone. Every browser Action currently carries
    // `surfaces.agent`, so this chokepoint is fail-closed headroom for the next unbacked id, not a
    // live rejection path.
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
      return await executeBrowserAutomationAction(args, input.automation, input.provisionAutomationRuntime);
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
