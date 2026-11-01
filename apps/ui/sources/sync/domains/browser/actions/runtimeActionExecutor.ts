import { ACTION_ID_FAMILIES_V1, type RuntimeActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { BrowserAutomationCancelActiveResultV1Schema, BrowserAutomationActionRequestV1Schema, resolveBrowserAutomationActionRequester, type BrowserAutomationActionRequestV1 } from '@happier-dev/protocol/browser/automation/v1';
import { BrowserCommandDispatchResultV1Schema, BrowserCommandV1Schema, type BrowserCommandV1 } from '@happier-dev/protocol/browser/control/v1';
import type { BrowserEventV1 } from '@happier-dev/protocol/browser/events/v1';
import { createUnavailableRuntimeActionExecutor, resolveRuntimeActionExecutionFamily } from '@happier-dev/protocol/actions/executor/dispatch';
import { getActionSpec, PUBLIC_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { RuntimeActionExecute, RuntimeActionExecuteArgs } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
    readClaimedBrowserRuntimeWorkspaceOpenRegion,
    readRegisteredBrowserRuntimeWorkspaceOpeningAdapter,
    type BrowserWorkspaceOpenerRegion,
} from './runtimeControlRegistry';
import { MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';

import {
    dispatchBrowserControlCommand,
    isDaemonAuthoritativeBrowserView,
    type BrowserControlCommandDispatchResult,
    type BrowserControlCommandEffect,
    type BrowserControlCommandDispatchOptions,
} from '../control/commands';
import type { BrowserDaemonControlDispatchClientResult } from '../control/machineRpc';
import { buildOpenExternalTabSelection, openBrowserExternalTabSelection } from '../adapters/selection';
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
    | 'browser_adapter_unavailable'
    /** AMD-8: a third-party page in the web iframe engine keeps its history and loading to itself. */
    | 'browser_page_history_uncontrollable';

type BrowserRuntimeActionFailure = Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

export type BrowserRuntimeControlAdapter = Readonly<{
    /** Exact mounted owner; workspace reopens must not borrow a same-id view from another Home. */
    accountLifetime?: ServerAccountScopeLifetime | null;
    readState: () => BrowserControlState | null | undefined;
    applyDispatchResult: (result: BrowserControlCommandDispatchResult) => void | Promise<void>;
    /** Project authoritative Machine events through the mounted host's existing reducer. */
    applyDaemonEvents?: (events: readonly BrowserEventV1[]) => void | Promise<void>;
    sendDaemonCommand?: (command: BrowserCommandV1) => Promise<BrowserDaemonControlDispatchClientResult>;
    /** Trusted mounted platform/target facts, shared by UI and Agent dispatch. */
    readDispatchOptions?: (command: BrowserCommandV1) => Omit<BrowserControlCommandDispatchOptions, 'sendDaemonCommand' | 'clientControlService'>;
}>;

export type BrowserRuntimeAutomationAdapter = Readonly<{
    controlService: BrowserAutomationControlService | null | undefined;
}>;

export type BrowserRuntimeDiagnosticsAdapter = Readonly<{ execute: RuntimeActionExecute }>;

/** A real workspace presentation owner, with no synthetic Browser view or control state. */
export type BrowserRuntimeWorkspaceOpeningAdapter = Readonly<{
    scopeId: string;
    accountLifetime: ServerAccountScopeLifetime | null;
    open: (
        input: PublicActionInputById['browser.workspace.open'],
        context: ActionExecutorContext,
        presentation?: Readonly<{ openerRegion: BrowserWorkspaceOpenerRegion }>,
    ) => Promise<unknown>;
}>;

export type CreateBrowserRuntimeActionExecutorInput = Readonly<{
    control?: BrowserRuntimeControlAdapter;
    resolveControl?: (input: Readonly<{ browserSessionId: string; viewId: string; kind?: BrowserCommandV1['kind'] }>) => BrowserRuntimeControlAdapter | null | undefined;
    automation?: BrowserRuntimeAutomationAdapter;
    diagnostics?: BrowserRuntimeDiagnosticsAdapter;
    resolveDiagnostics?: (input: Readonly<{ browserSessionId: string; viewId: string }>) => BrowserRuntimeDiagnosticsAdapter | null | undefined;
    resolveAutomation?: (
        input: Readonly<{ browserSessionId: string; viewId?: string }>,
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
    /** Existing captured-Account machine Action transport, for daemon-owned views only. */
    executeOnMachine?: RuntimeActionExecute;
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

async function executeBrowserMachineAction(
    args: RuntimeActionExecuteArgs,
    parsedInput: unknown,
    executeOnMachine: RuntimeActionExecute | undefined,
    unavailableReason: BrowserRuntimeActionDisabledReason = 'browser_control_route_unavailable',
    control?: Pick<BrowserRuntimeControlAdapter, 'applyDaemonEvents'>,
): Promise<unknown> {
    const target = args.context.externalActionTarget;
    if (!executeOnMachine || target?.kind !== 'machine' || !target.machineId.trim()) {
        return browserRuntimeActionDisabledResult(unavailableReason);
    }
    const result = await executeOnMachine({ ...args, input: parsedInput });
    if (control?.applyDaemonEvents) {
        const dispatched = BrowserCommandDispatchResultV1Schema.safeParse(result);
        if (dispatched.success && dispatched.data.status === 'dispatched') {
            await control.applyDaemonEvents(dispatched.data.events);
        }
    }
    return result;
}

function mapControlRejectedReason(
    reasonCode: Extract<BrowserControlCommandEffect, { kind: 'commandRejected' }>['reasonCode'],
): BrowserRuntimeActionDisabledReason {
    switch (reasonCode) {
        case 'adapter_unavailable':
            return 'browser_adapter_unavailable';
        case 'page_history_uncontrollable':
            return 'browser_page_history_uncontrollable';
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
    input: Pick<CreateBrowserRuntimeActionExecutorInput, 'control' | 'resolveControl' | 'automation' | 'resolveAutomation' | 'executeOnMachine'>,
): Promise<unknown> {
    if (args.actionId === 'browser.workspace.open') {
        // Input is parsed by the catalog schema, not a second workspace parser.
        const parsed = PUBLIC_ACTION_INPUT_SCHEMAS['browser.workspace.open'].safeParse(args.input ?? {});
        if (!parsed.success) return invalidParametersResult;
        const request = parsed.data;
        const serverId = resolveServerProfileScopeIdForIdentifier(args.context.serverId);
        const scope = serverId && args.context.runtimeAccountId
            ? { serverId, accountId: args.context.runtimeAccountId } : null;
        const owner = scope ? readRegisteredBrowserRuntimeWorkspaceOpeningAdapter(scope, request.scopeId) : null;
        if (!owner || owner.scopeId !== request.scopeId) return browserRuntimeActionDisabledResult('browser_view_unavailable');
        const lifetime = owner.accountLifetime;
        if (!lifetime?.isCurrent() || args.context.signal?.aborted
            || serverId !== lifetime.scope.serverId
            || args.context.runtimeAccountId !== lifetime.scope.accountId) {
            return browserRuntimeActionDisabledResult('browser_view_unavailable');
        }
        const openerRegion = readClaimedBrowserRuntimeWorkspaceOpenRegion(lifetime.scope, request.scopeId, request.commandId);
        return await owner.open(request, args.context, openerRegion ? { openerRegion } : undefined);
    }

    const parsed = parseRuntimeActionInput(args);
    if (!parsed.ok) return parsed.result;

    if (args.actionId === 'browser.view.openExternal') {
        const viewInput = readBrowserViewInput(parsed.input);
        if (!viewInput || !parsed.input || typeof parsed.input !== 'object' || !('commandId' in parsed.input)
            || typeof parsed.input.commandId !== 'string') return invalidParametersResult;
        const control = input.control ?? input.resolveControl?.(viewInput);
        const view = control?.readState()?.viewsById[viewInput.viewId];
        if (!view || view.browserSessionId !== viewInput.browserSessionId
            || (view.target.kind !== 'externalUrl' && view.target.kind !== 'localServicePreview')) {
            return browserRuntimeActionDisabledResult('browser_view_unavailable');
        }
        const url = view.pendingUrl ?? view.currentUrl ?? (view.target.kind === 'externalUrl' ? view.target.url : null);
        if (!url || !await openBrowserExternalTabSelection(buildOpenExternalTabSelection(url))) {
            return browserRuntimeActionDisabledResult('browser_adapter_unavailable');
        }
        return BrowserCommandDispatchResultV1Schema.parse({ v: 1, commandId: parsed.input.commandId,
            status: 'dispatched', adapterKind: 'externalUrl', events: [] });
    }

    const command = BrowserCommandV1Schema.safeParse(parsed.input);
    if (!command.success) {
        // The catalog has already validated this Action. Control-family membership
        // also includes Machine operations that are not BrowserCommands.
        return await executeBrowserMachineAction(args, parsed.input, input.executeOnMachine);
    }

    // A Machine-targeted open creates the daemon-owned Browser before any viewer exists.
    // Mounted in-app engines supply their control explicitly and retain their local policy owner.
    const machineTarget = args.context.externalActionTarget;
    if (command.data.kind === 'openView' && !input.control && machineTarget?.kind === 'machine') {
        return await executeBrowserMachineAction(args, command.data, input.executeOnMachine);
    }

    const control = input.control ?? input.resolveControl?.(command.data) ?? undefined;
    if (!control) {
        return await executeBrowserMachineAction(args, command.data, input.executeOnMachine, 'browser_control_unavailable');
    }

    const state = control.readState();
    if (!state) {
        return await executeBrowserMachineAction(args, command.data, input.executeOnMachine, 'browser_control_unavailable');
    }
    const view = 'viewId' in command.data ? state.viewsById[command.data.viewId] : null;
    if (command.data.kind !== 'openView' && 'viewId' in command.data && !view) {
        return await executeBrowserMachineAction(args, command.data, input.executeOnMachine, 'browser_control_unavailable');
    }
    if (view?.browserSessionId === command.data.browserSessionId
        && isDaemonAuthoritativeBrowserView(view) && machineTarget?.kind === 'machine') {
        return await executeBrowserMachineAction(args, command.data, input.executeOnMachine, 'browser_control_route_unavailable', control);
    }

    const daemonDispatch: { pending?: Promise<BrowserDaemonControlDispatchClientResult> } = {};
    const result = dispatchBrowserControlCommand(state, command.data, {
        ...control.readDispatchOptions?.(command.data),
        clientControlService: (input.automation ?? input.resolveAutomation?.(command.data))?.controlService ?? undefined,
        ...(control.sendDaemonCommand ? { sendDaemonCommand: (cmd: BrowserCommandV1) => {
            daemonDispatch.pending = control.sendDaemonCommand?.(cmd);
        } } : {}),
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
    if (result.effects.some((effect) => effect.kind === 'daemonCommand')) {
        const dispatched = await daemonDispatch.pending;
        if (!dispatched) return browserRuntimeActionDisabledResult('browser_control_route_unavailable');
        if (dispatched.ok) return dispatched.result;
        if (dispatched.reason === 'unavailable') return browserRuntimeActionDisabledResult('browser_control_route_unavailable');
        return { ok: false, errorCode: 'browser_control_unconfirmed', error: 'browser_control_unconfirmed' } satisfies BrowserRuntimeActionFailure;
    }

    const externalTab = result.effects.find((effect) => effect.kind === 'openExternalTab');
    if (externalTab) {
        if (!await openBrowserExternalTabSelection(externalTab.selection)) {
            return browserRuntimeActionDisabledResult('browser_adapter_unavailable');
        }
        return BrowserCommandDispatchResultV1Schema.parse({ v: 1, commandId: command.data.commandId,
            status: 'dispatched', adapterKind: externalTab.selection.adapterKind, events: [] });
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
    input: Pick<CreateBrowserRuntimeActionExecutorInput, 'automation' | 'resolveAutomation' | 'control' | 'resolveControl' | 'executeOnMachine'>,
): Promise<unknown> {
    const parsed = parseRuntimeActionInput(args);
    if (!parsed.ok) return parsed.result;

    const target = readBrowserViewInput(parsed.input);
    const control = target ? input.control ?? input.resolveControl?.(target) : null;
    const state = control?.readState();
    const view = target ? state?.viewsById[target.viewId] : null;
    if (!view && args.context.externalActionTarget?.kind === 'machine') {
        return await executeBrowserMachineAction(args, parsed.input, input.executeOnMachine, 'browser_automation_unavailable');
    }
    if (control && (!view || view.browserSessionId !== target?.browserSessionId)) {
        return browserRuntimeActionDisabledResult('browser_view_unavailable');
    }
    if (view && isDaemonAuthoritativeBrowserView(view)) {
        return await executeBrowserMachineAction(args, parsed.input, input.executeOnMachine, 'browser_automation_unavailable');
    }

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

        // `browser.context.annotation.*` is an IN-APP capture family — it mutates the canonical
        // `BrowserContextState` (mode machine + draft capture + composer attach) through the
        // annotation adapter, not a daemon producer. Routing it through this front-door leaf is what
        // makes the BrowserShell toolbar handlers AND an agent dispatch share one path (§12.20).
        if (isBrowserAnnotationRuntimeAction(args.actionId) || (args.actionId === 'browser.context.attachToComposer'
            && typeof args.input === 'object' && args.input !== null && 'source' in args.input && args.input.source !== undefined)) {
            const parsed = parseRuntimeActionInput(args);
            if (!parsed.ok) return parsed.result;
            const annotationExecutor = createBrowserAnnotationRuntimeExecutor({
                ...(input.annotation ? { adapter: input.annotation } : {}),
                ...(input.resolveAnnotation ? { resolveAdapter: input.resolveAnnotation } : {}),
            });
            return await annotationExecutor(args.actionId, parsed.input, args.context.signal);
        }
        if (args.actionId === 'browser.recording.attachToComposer') {
            const parsed = parseRuntimeActionInput(args);
            if (!parsed.ok) return parsed.result;
            const attachExecutor = createBrowserRecordingAttachExecutor({
                ...(input.recordingAttach ? { adapter: input.recordingAttach } : {}),
                ...(input.resolveRecordingAttach ? { resolveAdapter: input.resolveRecordingAttach } : {}),
            });
            return await attachExecutor(parsed.input);
        }

        // Other diagnostics, capture and recording use catalog admission and the exact-Machine
        // transport. Interactive diagnostics prefer the exact registered mounted engine below.
        const parsed = parseRuntimeActionInput(args);
        if (!parsed.ok) return parsed.result;
        if ((MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS as readonly string[]).includes(args.actionId)) {
            const view = readBrowserViewInput(parsed.input);
            const diagnostics = input.diagnostics ?? (view ? input.resolveDiagnostics?.(view) : null);
            if (diagnostics) return await diagnostics.execute({ ...args, input: parsed.input });
        }
        const unavailableReason = BROWSER_DIAGNOSTICS_ACTION_IDS.has(args.actionId) ? 'browser_diagnostics_unavailable'
            : BROWSER_CONTEXT_ACTION_IDS.has(args.actionId) ? 'browser_context_unavailable'
                : BROWSER_RECORDING_ACTION_IDS.has(args.actionId) ? 'browser_recording_unavailable'
                    : 'browser_action_unbacked';
        return await executeBrowserMachineAction(args, parsed.input, input.executeOnMachine, unavailableReason);
    };
}
