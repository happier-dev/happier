import { ACTION_ID_FAMILIES_V1, isBrowserExtensionActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import type { BrowserExtensionActionInputV1 } from '@happier-dev/protocol/actions';
import { createUnavailableRuntimeActionExecutor, resolveRuntimeActionExecutionFamily } from '@happier-dev/protocol/actions/executor/dispatch';
import { BrowserCommandV1Schema, BrowserOpenViewInProgressV1Schema, type DaemonBrowserViewListRequestV1, type DaemonBrowserViewListResponseV1 } from '@happier-dev/protocol/browser/control/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { getActionRequiredServerFeatureId } from '@happier-dev/protocol/actions/actionRequiredServerFeature';
import { MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import type { ActionExecuteResult, RuntimeActionExecute, RuntimeActionExecuteArgs, RuntimeActionIdV1 } from '@happier-dev/protocol';

import type { BrowserDaemonControlRoutes } from '../control/routes';
import type { BrowserContextRoutes } from '../context/routes';
import type { BrowserAutomationRoutes } from '../automation/routes';
import type { BrowserDiagnosticsActionRoutes } from '../diagnostics/actionRoutes';
import type { BrowserRecordingActionRoutes } from '../recording/actionRoutes';
import type { BrowserDaemonFeatureGate } from '../featureGate';
import { executeManagedChromiumSandboxInstall } from '../sidecar/sandbox';
import type {
  BrowserRecordingAttachToComposerInput,
  BrowserRecordingAttachToComposerResult,
} from '../recording/attachToComposer';

export type BrowserDaemonRuntimeActionDisabledReason =
  | 'browser_action_unbacked'
  | 'browser_automation_route_unavailable'
  | 'browser_ui_automation_unavailable'
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
 * - `ready` — installation and the canonical route refresh have completed.
 * - `failed` — an install was attempted and did not succeed.
 * - `unavailable` — nothing can be provisioned on this host at all (unsupported platform, or a
 *   pinned asset with no verifiable digest). This is the pre-existing honest answer and keeps the
 *   pre-existing reason code.
 */
export type BrowserAutomationRuntimeProvisionOutcome =
  | 'ready'
  | 'failed'
  | 'unavailable';

export type ProvisionBrowserAutomationRuntime =
  (options?: Readonly<{ onProvisioning?: () => void }>) => Promise<BrowserAutomationRuntimeProvisionOutcome>;

export type CreateBrowserDaemonRuntimeActionExecutorInput = Readonly<{
  control?: BrowserDaemonControlRoutes;
  /** Re-read the same route owner after provisioning replaces its routes. */
  resolveControl?: () => BrowserDaemonControlRoutes | null | undefined;
  context?: BrowserContextRoutes;
  automation?: BrowserAutomationRoutes;
  resolveAutomation?: () => BrowserAutomationRoutes | null | undefined;
  /** Physical ownership is read from the existing daemon control broker. */
  ownsAutomationView?: (view: Readonly<{ browserSessionId: string; viewId: string }>) => boolean;
  uiAutomation?: RuntimeActionExecute;
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
  input: CreateBrowserDaemonRuntimeActionExecutorInput,
): Promise<unknown> {
  const parsed = parseRuntimeActionInput(args);
  if (!parsed.ok) return parsed.result;

  if (isBrowserExtensionActionIdV1(args.actionId)) {
    const control = input.control ?? input.resolveControl?.();
    if (!control?.extensions) return { status: 'unavailable', code: 'managed_browser_required' };
    return await control.extensions.execute(args.actionId, parsed.input as BrowserExtensionActionInputV1, args.context);
  }

  if (args.actionId === 'browser.view.list') {
    const control = input.control ?? input.resolveControl?.();
    if (!control) return browserRuntimeActionDisabledResult('browser_control_route_unavailable');
    // The Action spec above already parsed the canonical list request.
    const request = parsed.input as DaemonBrowserViewListRequestV1;
    return { protocolVersion: 1, views: [...control.listViews(request.browserSessionId)] } satisfies DaemonBrowserViewListResponseV1;
  }

  const command = BrowserCommandV1Schema.safeParse(parsed.input);
  if (!command.success) {
    return invalidParametersResult;
  }

  let control = input.control ?? input.resolveControl?.();
  if (!control) {
    if (command.data.kind === 'openView' && input.provisionAutomationRuntime) {
      const open = command.data;
      const outcome = await input.provisionAutomationRuntime({ onProvisioning: () => {
        args.context.operationOwnerUpdate?.update({ state: 'running',
          progress: { phase: 'browser_runtime_provisioning' } });
        const acceptance = args.context.operationAcceptance;
        if (acceptance?.actionId === args.actionId) {
          acceptance.accept(BrowserOpenViewInProgressV1Schema.parse({ v: 1, status: 'in_progress',
            phase: 'browser_runtime_provisioning', commandId: open.commandId,
            browserSessionId: open.browserSessionId, viewId: open.viewId, operationId: acceptance.operationId }));
        }
      } });
      if (outcome === 'failed') return provisioningFailure();
      if (outcome === 'ready') {
        await input.featureGate.refresh();
        if (input.featureGate.isEnabled('browser.sidecar')) control = input.resolveControl?.();
      }
    }
    if (!control) return browserRuntimeActionDisabledResult('browser_control_route_unavailable');
  }

  return await control.dispatchCommand(command.data, args.context);
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

function provisioningFailure(): BrowserDaemonRuntimeActionFailure {
  return { ok: false, errorCode: 'browser_runtime_provisioning_failed',
    error: 'Could not prepare the browser. Check the machine’s internet connection and free disk space, then try opening the page again.' };
}

async function executeBrowserAutomationAction(
  args: RuntimeActionExecuteArgs,
  input: CreateBrowserDaemonRuntimeActionExecutorInput,
): Promise<unknown> {
  let automation = input.automation ?? input.resolveAutomation?.();
  if (!automation) {
    // No route means the sidecar adapter failed closed at startup, and on an unprovisioned host
    // that is `managed_package_missing`. Asking for automation is what authorizes the fetch, so
    // this is where it starts. Retain this invocation through installation and route refresh.
    if (!input.provisionAutomationRuntime) {
      return browserRuntimeActionDisabledResult('browser_automation_route_unavailable');
    }
    const outcome = await input.provisionAutomationRuntime();
    if (outcome === 'failed') return provisioningFailure();
    if (outcome === 'ready') {
      await input.featureGate.refresh();
      if (input.featureGate.isEnabled('browser.automation')) automation = input.resolveAutomation?.();
    }
    if (!automation) return browserRuntimeActionDisabledResult('browser_automation_route_unavailable');
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

    // This identity scopes the Session's daemon browser workspace. UI-owned panes have their
    // own Browser identity and authenticated reverse room, not the Happier Session's identity.
    const sessionId = args.context.defaultSessionId;
    const browserSessionId = args.input && typeof args.input === 'object' && !Array.isArray(args.input)
      ? (args.input as Record<string, unknown>).browserSessionId : undefined;
    const sessionBrowserMismatch = Boolean(sessionId && typeof browserSessionId === 'string' && browserSessionId !== sessionId);

    // The ActionSpec's canonical agent surface is the single authority on which browser Actions a
    // caller may reach; a family member excluded from `RUNTIME_ACTION_REAL_EXECUTOR_*` is refused
    // here rather than routed on family membership alone. Every browser Action currently carries
    // `surfaces.agent`, so this chokepoint is fail-closed headroom for the next unbacked id, not a
    // live rejection path.
    if (!getActionSpec(args.actionId).surfaces.agent) {
      return browserRuntimeActionDisabledResult('browser_action_unbacked');
    }

    if (args.actionId === 'browser.sandbox.install') {
      return await executeManagedChromiumSandboxInstall(args);
    }

    const requiredFeatureId = getActionRequiredServerFeatureId(args.actionId);
    if (requiredFeatureId === 'browser.automation' && !featureGate.isEnabled(requiredFeatureId)) {
      return browserRuntimeActionDisabledResult('browser_automation_route_unavailable');
    }

    if (BROWSER_AUTOMATION_ACTION_IDS.has(args.actionId)) {
      const parsed = parseRuntimeActionInput(args);
      if (!parsed.ok) return parsed.result;
      const view = parsed.input as Readonly<{ browserSessionId: string; viewId: string }>;
      if (input.ownsAutomationView && !input.ownsAutomationView(view)) {
        return input.uiAutomation
          ? await input.uiAutomation({ ...args, input: parsed.input })
          : browserRuntimeActionDisabledResult('browser_ui_automation_unavailable');
      }
      if (sessionBrowserMismatch) return invalidParametersResult;
      return await executeBrowserAutomationAction(args, input);
    }
    if (BROWSER_CONTROL_ACTION_IDS.has(args.actionId)) {
      if (!featureGate.isEnabled('browser.sidecar')) {
        return browserRuntimeActionDisabledResult('browser_control_route_unavailable');
      }
      // External opening belongs to the exact answering client's mounted page,
      // not to the Machine's BrowserCommand broker or its system browser.
      if (args.actionId === 'browser.view.openExternal') {
        const parsed = parseRuntimeActionInput(args);
        if (!parsed.ok) return parsed.result;
        return input.uiAutomation
          ? await input.uiAutomation({ ...args, input: parsed.input })
          : browserRuntimeActionDisabledResult('browser_ui_automation_unavailable');
      }
      if (args.actionId === 'browser.control.takeControl' || args.actionId === 'browser.control.handBack') {
        const parsed = parseRuntimeActionInput(args);
        if (!parsed.ok) return parsed.result;
        const view = parsed.input as Readonly<{ browserSessionId: string; viewId: string }>;
        if (input.ownsAutomationView && !input.ownsAutomationView(view)) {
          return input.uiAutomation
            ? await input.uiAutomation({ ...args, input: parsed.input })
            : browserRuntimeActionDisabledResult('browser_ui_automation_unavailable');
        }
      }
      if (sessionBrowserMismatch) return invalidParametersResult;
      return await executeBrowserControlAction(args, input);
    }
    if (BROWSER_DIAGNOSTICS_ACTION_IDS.has(args.actionId)) {
      if (!featureGate.isEnabled('browser.diagnostics')) {
        return browserRuntimeActionDisabledResult('browser_diagnostics_route_unavailable');
      }
      if ((MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS as readonly string[]).includes(args.actionId)) {
        const parsed = parseRuntimeActionInput(args);
        if (!parsed.ok) return parsed.result;
        const view = parsed.input as Readonly<{ browserSessionId: string; viewId: string }>;
        if (input.ownsAutomationView && !input.ownsAutomationView(view)) {
          return input.uiAutomation ? await input.uiAutomation({ ...args, input: parsed.input })
            : browserRuntimeActionDisabledResult('browser_ui_automation_unavailable');
        }
      }
      if (sessionBrowserMismatch) return invalidParametersResult;
      if (!input.diagnostics) {
        return browserRuntimeActionDisabledResult('browser_diagnostics_route_unavailable');
      }
      return await input.diagnostics.dispatch(args.actionId, args.input);
    }
    if (sessionBrowserMismatch) return invalidParametersResult;
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
