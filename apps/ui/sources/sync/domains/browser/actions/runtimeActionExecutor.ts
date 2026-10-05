import {
    ACTION_ID_FAMILIES_V1,
    BrowserAutomationCancelActiveResultV1Schema,
    BrowserAutomationActionRequestV1Schema,
    BrowserCommandDispatchResultV1Schema,
    BrowserCommandV1Schema,
    createUnavailableRuntimeActionExecutor,
    getActionSpec,
    resolveRuntimeActionExecutionFamily,
    resolveBrowserAutomationActionRequester,
    type ActionExecuteResult,
    type BrowserAutomationActionRequestV1,
    type BrowserCommandV1,
    type RuntimeActionExecute,
    type RuntimeActionExecuteArgs,
    type RuntimeActionIdV1,
} from '@happier-dev/protocol';

import {
    dispatchBrowserControlCommand,
    type BrowserControlCommandDispatchResult,
    type BrowserControlCommandEffect,
} from '../control/commands';
import type { BrowserControlState } from '../control/state';
import {
    createBrowserRecordingAttachExecutor,
    type BrowserRecordingAttachAdapter,
    type BrowserRecordingAttachExecutorInput,
} from '../recording/runtimeAttachExecutor';
import {
    createBrowserAnnotationRuntimeExecutor,
    isBrowserAnnotationRuntimeAction,
    type BrowserContextAnnotationAdapter,
} from '../context/runtimeAnnotationExecutor';
import type {
    BrowserAutomationControlService,
    BrowserAutomationResult,
    BrowserAutomationTimelineEntry,
} from '../automation';

export type BrowserRuntimeActionDisabledReason =
    | 'browser_action_unbacked'
    | 'browser_automation_unavailable'
    | 'browser_context_unavailable'
    | 'browser_control_route_unavailable'
    | 'browser_control_unavailable'
    | 'browser_diagnostics_unavailable'
    | 'browser_recording_unavailable'
    | 'browser_view_unavailable'
    | 'browser_adapter_unavailable';

type BrowserRuntimeActionFailure = Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

export type BrowserRuntimeControlAdapter = Readonly<{
    readState: () => BrowserControlState | null | undefined;
    applyDispatchResult: (result: BrowserControlCommandDispatchResult) => void | Promise<void>;
    sendDaemonCommand?: (command: BrowserCommandV1) => void;
}>;

export type BrowserRuntimeAutomationAdapter = Readonly<{
    controlService: BrowserAutomationControlService | null | undefined;
}>;

export type CreateBrowserRuntimeActionExecutorInput = Readonly<{
    control?: BrowserRuntimeControlAdapter;
    resolveControl?: (command: BrowserCommandV1) => BrowserRuntimeControlAdapter | null | undefined;
    automation?: BrowserRuntimeAutomationAdapter;
    resolveAutomation?: (
        input: Readonly<{ browserSessionId: string }>,
    ) => BrowserRuntimeAutomationAdapter | null | undefined;
    recordingAttach?: BrowserRecordingAttachAdapter;
    resolveRecordingAttach?: (
        input: BrowserRecordingAttachExecutorInput,
    ) => BrowserRecordingAttachAdapter | null | undefined;
    annotation?: BrowserContextAnnotationAdapter;
    resolveAnnotation?: (
        input: Readonly<{ browserSessionId: string; viewId: string }>,
    ) => BrowserContextAnnotationAdapter | null | undefined;
    fallback?: RuntimeActionExecute;
}>;

type RuntimeBrowserViewInput = Readonly<{
    browserSessionId: string;
    viewId: string;
}>;

const BROWSER_CONTROL_ACTION_IDS = new Set<string>(ACTION_ID_FAMILIES_V1.browser_control);
const BROWSER_AUTOMATION_ACTION_IDS = new Set<string>(ACTION_ID_FAMILIES_V1.browser_automation);
const BROWSER_DIAGNOSTICS_ACTION_IDS = new Set<string>(ACTION_ID_FAMILIES_V1.browser_diagnostics);
const BROWSER_CONTEXT_ACTION_IDS = new Set<string>(ACTION_ID_FAMILIES_V1.browser_context);
const BROWSER_RECORDING_ACTION_IDS = new Set<string>(ACTION_ID_FAMILIES_V1.browser_recording);

const invalidParametersResult = {
    ok: false,
    errorCode: 'invalid_parameters',
    error: 'invalid_parameters',
} as const satisfies BrowserRuntimeActionFailure;

function browserRuntimeActionDisabledResult(
    reason: BrowserRuntimeActionDisabledReason,
): BrowserRuntimeActionFailure {
    return {
        ok: false,
        errorCode: 'runtime_action_disabled',
        error: `runtime_action_disabled:browser:${reason}`,
    };
}

function isBrowserRuntimeAction(actionId: RuntimeActionIdV1): boolean {
    return resolveRuntimeActionExecutionFamily(actionId) === 'browser';
}

function isBrowserControlAction(actionId: RuntimeActionIdV1): boolean {
    return BROWSER_CONTROL_ACTION_IDS.has(actionId);
}

function isBrowserAutomationAction(actionId: RuntimeActionIdV1): boolean {
    return BROWSER_AUTOMATION_ACTION_IDS.has(actionId);
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

function mapControlRejectedReason(
    reasonCode: Extract<BrowserControlCommandEffect, { kind: 'commandRejected' }>['reasonCode'],
): BrowserRuntimeActionDisabledReason {
    switch (reasonCode) {
        case 'adapter_unavailable':
            return 'browser_adapter_unavailable';
        case 'automation_busy':
            return 'browser_control_unavailable';
        case 'view_not_found':
            return 'browser_view_unavailable';
    }
}

function readBrowserViewInput(input: unknown): RuntimeBrowserViewInput | null {
    if (!input || typeof input !== 'object') {
        return null;
    }
    const record = input as Readonly<Record<string, unknown>>;
    const browserSessionId = typeof record.browserSessionId === 'string'
        ? record.browserSessionId.trim()
        : '';
    const viewId = typeof record.viewId === 'string'
        ? record.viewId.trim()
        : '';
    return browserSessionId && viewId ? { browserSessionId, viewId } : null;
}

function serializeAutomationTimelineEntry(
    entry: BrowserAutomationTimelineEntry,
): Readonly<Record<string, unknown>> {
    return {
        v: 1,
        ...entry,
    };
}

function serializeAutomationActionResult(
    request: BrowserAutomationActionRequestV1,
    result: BrowserAutomationResult,
): unknown {
    if (result.status === 'interrupted' && result.completion === 'unknown') {
        return { v: 1, automationRequestId: request.automationRequestId, status: 'interrupted', completion: 'unknown' };
    }
    return result.actionResult ?? browserRuntimeActionDisabledResult('browser_automation_unavailable');
}

function serializeBrowserControlActionResult(
    command: BrowserCommandV1,
    state: BrowserControlState,
    result: BrowserControlCommandDispatchResult,
): unknown | null {
    const viewId = 'viewId' in command ? command.viewId : null;
    const adapterKind = viewId
        ? result.state.viewsById[viewId]?.adapterKind ?? state.viewsById[viewId]?.adapterKind
        : undefined;
    if (!adapterKind) return null;
    return BrowserCommandDispatchResultV1Schema.parse({
        v: 1,
        commandId: command.commandId,
        status: 'dispatched',
        adapterKind,
        events: [],
    });
}

async function executeBrowserControlAction(
    args: RuntimeActionExecuteArgs,
    input: Pick<CreateBrowserRuntimeActionExecutorInput, 'control' | 'resolveControl' | 'automation' | 'resolveAutomation'>,
): Promise<unknown> {
    const parsed = parseRuntimeActionInput(args);
    if (!parsed.ok) return parsed.result;

    const command = BrowserCommandV1Schema.safeParse(parsed.input);
    if (!command.success) {
        return invalidParametersResult;
    }

    const control = input.control ?? input.resolveControl?.(command.data) ?? undefined;
    if (!control) {
        return browserRuntimeActionDisabledResult('browser_control_unavailable');
    }

    const state = control.readState();
    if (!state) {
        return browserRuntimeActionDisabledResult('browser_control_unavailable');
    }

    const result = dispatchBrowserControlCommand(state, command.data, {
        clientControlService: (input.automation ?? input.resolveAutomation?.(command.data))?.controlService ?? undefined,
        ...(control.sendDaemonCommand ? { sendDaemonCommand: control.sendDaemonCommand } : {}),
    });
    const rejected = result.effects.find((effect): effect is Extract<BrowserControlCommandEffect, { kind: 'commandRejected' }> => (
        effect.kind === 'commandRejected'
    ));
    if (rejected) {
        if (rejected.reasonCode === 'automation_busy') {
            return BrowserCommandDispatchResultV1Schema.parse({ v: 1, commandId: command.data.commandId,
                status: 'failed', error: { code: 'permission_denied', message: 'Browser input is still settling', retryable: true } });
        }
        return browserRuntimeActionDisabledResult(mapControlRejectedReason(rejected.reasonCode));
    }
    if (result.effects.some((effect) => effect.kind === 'daemonCommand') && !control.sendDaemonCommand) {
        return browserRuntimeActionDisabledResult('browser_control_route_unavailable');
    }

    const serializedResult = serializeBrowserControlActionResult(command.data, state, result);
    if (!serializedResult) {
        return browserRuntimeActionDisabledResult('browser_adapter_unavailable');
    }

    await control.applyDispatchResult(result);
    return serializedResult;
}

async function executeBrowserAutomationAction(
    args: RuntimeActionExecuteArgs,
    input: Pick<CreateBrowserRuntimeActionExecutorInput, 'automation' | 'resolveAutomation'>,
): Promise<unknown> {
    const parsed = parseRuntimeActionInput(args);
    if (!parsed.ok) return parsed.result;

    if (args.actionId === 'browser.automation.timeline.get') {
        const viewInput = readBrowserViewInput(parsed.input);
        if (!viewInput) return invalidParametersResult;
        const controlService = (input.automation ?? input.resolveAutomation?.(viewInput))?.controlService;
        if (!controlService) {
            return browserRuntimeActionDisabledResult('browser_automation_unavailable');
        }
        const entries = controlService.getActionTimeline(viewInput).map(serializeAutomationTimelineEntry);
        return {
            v: 1,
            browserSessionId: viewInput.browserSessionId,
            viewId: viewInput.viewId,
            maxEntries: 500,
            entries,
        };
    }

    if (args.actionId === 'browser.automation.cancelActive') {
        const viewInput = readBrowserViewInput(parsed.input);
        if (!viewInput) return invalidParametersResult;
        if (args.context?.authority !== 'present_user') {
            return BrowserAutomationCancelActiveResultV1Schema.parse({ v: 1, outcome: 'owner_mismatch', canceledCount: 0 });
        }
        const controlService = (input.automation ?? input.resolveAutomation?.(viewInput))?.controlService;
        if (!controlService) {
            return browserRuntimeActionDisabledResult('browser_automation_unavailable');
        }
        return BrowserAutomationCancelActiveResultV1Schema.parse(controlService.cancelActiveAction(viewInput));
    }

    const request = BrowserAutomationActionRequestV1Schema.safeParse(parsed.input);
    if (!request.success) {
        return invalidParametersResult;
    }
    const controlService = (input.automation ?? input.resolveAutomation?.(request.data))?.controlService;
    if (!controlService) {
        return browserRuntimeActionDisabledResult('browser_automation_unavailable');
    }
    if (args.actionId === 'browser.automation.status') {
        return controlService.getStatus(request.data) ?? browserRuntimeActionDisabledResult('browser_view_unavailable');
    }
    const requestedBy = resolveBrowserAutomationActionRequester(request.data.requestedBy, args.context?.authority);
    if (!requestedBy) return invalidParametersResult;
    const admitted = { ...request.data, requestedBy };
    const result = await controlService.executeAction(admitted, { signal: args.context?.signal });
    return serializeAutomationActionResult(admitted, result);
}

export function createBrowserRuntimeActionExecutor(
    input: CreateBrowserRuntimeActionExecutorInput = {},
): RuntimeActionExecute {
    const fallback = input.fallback ?? createUnavailableRuntimeActionExecutor();

    return async (args) => {
        if (!isBrowserRuntimeAction(args.actionId)) {
            return await fallback(args);
        }

        if (isBrowserControlAction(args.actionId)) {
            return await executeBrowserControlAction(args, input);
        }

        if (isBrowserAutomationAction(args.actionId)) {
            return await executeBrowserAutomationAction(args, input);
        }

        // SUPPORT MATRIX (FINALIZATION-PLAN §3.2 / §10 "label every deferral"):
        // `browser.diagnostics.*` has no UI-local producer — diagnostics/devtools/eval run against
        // the live page on the DAEMON side (sidecar CDP), which is the real owner. The UI runtime
        // executor fails closed here; the protocol surface map keeps the diagnostics family disabled
        // on every surface (no real executor), so this branch is reached only by a non-front-door
        // caller. Do NOT fake a UI dispatch — the daemon executor (`apps/cli/.../browser/actions`)
        // services it through its `browser.context`/automation routes.
        if (BROWSER_DIAGNOSTICS_ACTION_IDS.has(args.actionId)) {
            return browserRuntimeActionDisabledResult('browser_diagnostics_unavailable');
        }
        // `browser.context.annotation.*` is an IN-APP capture family — it mutates the canonical
        // `BrowserContextState` (mode machine + draft capture + composer attach) through the
        // annotation adapter, not a daemon producer. Routing it through this front-door leaf is what
        // makes the BrowserShell toolbar handlers AND an agent dispatch share one path (§12.20).
        if (isBrowserAnnotationRuntimeAction(args.actionId)) {
            const parsed = parseRuntimeActionInput(args);
            if (!parsed.ok) return parsed.result;
            const annotationExecutor = createBrowserAnnotationRuntimeExecutor({
                ...(input.annotation ? { adapter: input.annotation } : {}),
                ...(input.resolveAnnotation ? { resolveAdapter: input.resolveAnnotation } : {}),
            });
            return await annotationExecutor(args.actionId, parsed.input);
        }
        // `browser.context.capture*` egress is serviced by the DAEMON capture routes (live page +
        // redaction schemas), not by the in-UI WebView. The UI-local `context/actions.ts` helpers
        // build composer reference items for a different (already-working) attach flow, not a
        // runtime-action dispatch against a live producer. The family is surfaced on `ui`/
        // `agent` (real daemon executor), so the agent-approval floor activates; the UI
        // executor itself defers to the daemon and fails closed here.
        if (BROWSER_CONTEXT_ACTION_IDS.has(args.actionId)) {
            return browserRuntimeActionDisabledResult('browser_context_unavailable');
        }
        if (BROWSER_RECORDING_ACTION_IDS.has(args.actionId)) {
            // Only the attach-to-composer leaf has a real UI executor (resolves the registered
            // recording-attach owner). The rest of the recording family (start/stop/cancel/status/
            // listForView/discard/cleanupExpired) has no UI producer and stays disabled on every
            // surface — labeled deferral, not faked.
            if (args.actionId === 'browser.recording.attachToComposer') {
                const parsed = parseRuntimeActionInput(args);
                if (!parsed.ok) return parsed.result;
                const attachExecutor = createBrowserRecordingAttachExecutor({
                    ...(input.recordingAttach ? { adapter: input.recordingAttach } : {}),
                    ...(input.resolveRecordingAttach ? { resolveAdapter: input.resolveRecordingAttach } : {}),
                });
                return await attachExecutor(parsed.input);
            }
            return browserRuntimeActionDisabledResult('browser_recording_unavailable');
        }
        return browserRuntimeActionDisabledResult('browser_action_unbacked');
    };
}
