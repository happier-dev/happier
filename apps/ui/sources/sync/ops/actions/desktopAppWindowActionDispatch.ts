import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { UiActionDispatchRequestV1Schema, buildUiActionDispatchRequestV1, parseClientActionDispatchResult } from '@happier-dev/protocol/actions/clientDispatchV1';
import { ComposerTransactionApplyInputV1Schema, type ComposerTransactionApplyInputV1 } from '@happier-dev/protocol/actions/composerIngressAction';
import { SessionDraftAddressV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { ComposerSnapshotV1Schema, type ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import { randomUUID } from '@/platform/randomUUID';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { getDesktopHostWindowLabel } from '@/utils/platform/desktopHost';
import { subscribeFocusedDesktopAppWindowSurface } from '@/desktop/window/appWindowSurface';
import {
    emitDesktopWindowActionResult,
    executeDesktopWindowActionWithResult,
    listenDesktopWindowAction,
    emitDesktopWindowAction,
    listenDesktopWindowActionResult,
} from '@/utils/platform/desktopWindowActionBridge';

/** Private continuation of an Action already admitted by its originating data realm. */
const ADMITTED_CLIENT_ACTION = 'desktop.clientAction.execute.admitted';
const RETURN_PRESENTATION = 'desktop.window.return';
const RESUME_PRESENTATION = 'desktop.window.resume';
/** The person's direct input uses the incumbent composer owner, independently of agent Action approvals. */
const PERSON_COMPOSER_TRANSACTION = 'desktop.sessionDraft.transaction.apply';
export const DESKTOP_SESSION_DRAFT_WATCH = 'desktop.sessionDraft.watch';
export const DESKTOP_SESSION_DRAFT_UNWATCH = 'desktop.sessionDraft.unwatch';
export type DesktopAppWindowReturnIntent = 'return' | 'close';
let presentation: Readonly<{ prepare: (intent: DesktopAppWindowReturnIntent) => Promise<boolean>; resume?: () => Promise<void> }> | undefined;

/** The mounted route retains its existing navigation guard and writable-release lifecycle. */
export function registerDesktopAppWindowReturnHandler(handler: (intent: DesktopAppWindowReturnIntent) => Promise<boolean>, resume?: () => Promise<void>): () => void {
    const owner = { prepare: handler, resume };
    presentation = owner;
    return () => { if (presentation === owner) presentation = undefined; };
}

export async function prepareDesktopAppWindowReturn(intent: DesktopAppWindowReturnIntent = 'return'): Promise<boolean> {
    return await presentation?.prepare(intent) ?? false;
}

export async function requestDesktopAppWindowReturn(label: `destination_${string}`, intent: DesktopAppWindowReturnIntent = 'return'): Promise<boolean> {
    const result = await executeDesktopWindowActionWithResult({ windowLabel: 'main', targetWindowLabel: label,
        actionIdentifier: RETURN_PRESENTATION, data: { intent } });
    return result.ok && result.result !== null && typeof result.result === 'object'
        && 'returned' in result.result && result.result.returned === true;
}

/** Native create/update/close may fail after release; restore the same route's existing draft owner. */
export async function requestDesktopAppWindowResume(label: `destination_${string}`): Promise<boolean> {
    if (getDesktopHostWindowLabel() === label) {
        try { return await resumePresentation(); } catch { return false; }
    }
    const result = await executeDesktopWindowActionWithResult({ windowLabel: 'main', targetWindowLabel: label,
        actionIdentifier: RESUME_PRESENTATION, data: {} });
    return result.ok && result.result !== null && typeof result.result === 'object'
        && 'resumed' in result.result && result.result.resumed === true;
}

async function resumePresentation(): Promise<boolean> {
    const resume = presentation?.resume;
    if (!resume) return false;
    await resume();
    return true;
}

export type DesktopAppWindowActionOptions = Readonly<{
    screenCaptureSendDraftOnly?: boolean;
    screenCaptureWindowPress?: boolean;
}>;

export function readDesktopSessionDraftWatchTarget(data: Record<string, unknown>): ExactSessionMachineTargetIdentity | null {
    const address = SessionDraftAddressV2Schema.safeParse({ kind: 'session', sessionId: data.sessionId });
    return address.success && address.data.kind === 'session' && typeof data.serverId === 'string' && data.serverId.length > 0
        && typeof data.accountId === 'string' && data.accountId.length > 0
        ? { serverId: data.serverId, accountId: data.accountId, sessionId: address.data.sessionId } : null;
}

async function watchLocalSessionDraft(target: ExactSessionMachineTargetIdentity,
    publish: (snapshot: ComposerSnapshotV1 | null) => void, signal: AbortSignal): Promise<() => void> {
    const { createExistingSessionComposerDocumentOwner } = await import('@/components/sessions/composer/existingSessionComposerDocumentOwner');
    const { readSessionDraftComposerSnapshot } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
    if (signal.aborted) return () => {};
    const ref = { kind: 'session' as const, sessionId: target.sessionId };
    const owner = createExistingSessionComposerDocumentOwner({ scope: target, ref });
    const read = () => { if (!signal.aborted) publish(readSessionDraftComposerSnapshot(ref, target)); };
    const stop = owner.observe(read);
    read();
    return stop;
}

/** Read-only demand follows canonical presentation; main never retains a writable replica. */
export async function watchDesktopSessionDraft(target: ExactSessionMachineTargetIdentity,
    publish: (snapshot: ComposerSnapshotV1 | null) => void, signal: AbortSignal): Promise<() => void> {
    const runtime = await import('@/desktop/window/appWindowRuntime');
    if (signal.aborted) return () => {};
    const source = getDesktopHostWindowLabel();
    const windowLabel = source?.startsWith('destination_') ? source as `destination_${string}` : 'main';
    const address = { input: { sessionId: target.sessionId }, serverId: target.serverId, accountId: target.accountId };
    let label: `destination_${string}` | null | undefined;
    let active: AbortController | undefined;
    let stopped = false;
    // Session owners project the persisted repository documentRevision, including after realm transfer.
    let lastRevision: number | null | undefined;
    const changed = (snapshot: ComposerSnapshotV1 | null) => {
        const revision = snapshot?.revision ?? null;
        if (signal.aborted || stopped || revision === lastRevision) return;
        lastRevision = revision;
        publish(snapshot);
    };
    const bind = async () => {
        await runtime.waitForDesktopAppWindowPresentation(address);
        if (signal.aborted || stopped) return;
        const resolved = runtime.resolveDesktopAppWindowForAction(address);
        const next = resolved === windowLabel ? null : resolved;
        if (label === next) return;
        label = next;
        active?.abort();
        const lifetime = new AbortController();
        active = lifetime;
        let release: () => void;
        if (next) {
            const requestId = randomUUID();
            const unlisten = await listenDesktopWindowActionResult(result => {
                if (lifetime.signal.aborted || result.windowLabel !== windowLabel || result.requestId !== requestId) return;
                if (result.phase === 'admitted') return;
                const snapshot = ComposerSnapshotV1Schema.safeParse(result.result);
                if (result.ok && (snapshot.success || result.result === null)) changed(snapshot.success ? snapshot.data : null);
                else if (!result.ok && lastRevision === undefined) changed(null);
            });
            release = () => {
                unlisten();
                fireAndForget(emitDesktopWindowAction({ windowLabel, targetWindowLabel: next,
                    actionIdentifier: DESKTOP_SESSION_DRAFT_UNWATCH, data: { watchId: requestId } }));
            };
            // Install cleanup before sending: cancellation can happen while the native command is pending.
            if (lifetime.signal.aborted) { release(); return; }
            lifetime.signal.addEventListener('abort', release, { once: true });
            try { await emitDesktopWindowAction({ windowLabel, targetWindowLabel: next,
                requestId, actionIdentifier: DESKTOP_SESSION_DRAFT_WATCH, data: { ...target } }); }
            catch (error) { lifetime.abort(); throw error; }
            return;
        } else {
            release = await watchLocalSessionDraft(target, changed, lifetime.signal);
        }
        if (lifetime.signal.aborted) release();
        else lifetime.signal.addEventListener('abort', release, { once: true });
    };
    const unlistenPlacement = runtime.subscribeDesktopAppWindows(() => {
        fireAndForget(bind(), { onError: () => { if (lastRevision === undefined) changed(null); } });
    });
    const unlistenFocus = subscribeFocusedDesktopAppWindowSurface(() => {
        fireAndForget(bind(), { onError: () => { if (lastRevision === undefined) changed(null); } });
    });
    const stop = () => { stopped = true; unlistenPlacement(); unlistenFocus(); active?.abort(); };
    signal.addEventListener('abort', stop, { once: true });
    try { await bind(); } catch (error) { stop(); throw error; }
    return () => { signal.removeEventListener('abort', stop); stop(); };
}

async function applyLocalPersonComposerTransaction(input: ComposerTransactionApplyInputV1): Promise<ActionExecuteResult> {
    const { applyMountedComposerPresentationTransaction } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
    return { ok: true, result: applyMountedComposerPresentationTransaction(input) };
}

/** Same direct document path as the person's main composer; placement owns the sole writable presenter. */
export async function applyDesktopSessionDraftTransaction(input: ComposerTransactionApplyInputV1): Promise<ActionExecuteResult> {
    const { resolveDesktopAppWindowForAction, waitForDesktopAppWindowPresentation } = await import('@/desktop/window/appWindowRuntime');
    const address = { actionId: 'composer.transaction.apply' as const, input, serverId: input.scope.serverId, accountId: input.scope.accountId };
    await waitForDesktopAppWindowPresentation(address);
    const label = resolveDesktopAppWindowForAction(address);
    if (!label || getDesktopHostWindowLabel() === label) return applyLocalPersonComposerTransaction(input);
    const result = await executeDesktopWindowActionWithResult({ windowLabel: 'main', targetWindowLabel: label,
        actionIdentifier: PERSON_COMPOSER_TRANSACTION, data: { input } });
    return parseClientActionDispatchResult('composer.transaction.apply', { v: 1, execution: result.ok
        ? { ok: true, result: result.result }
        : { ok: false, errorCode: result.errorCode ?? 'target_unavailable', error: result.error ?? 'target_unavailable' } })
        ?? { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
}

export async function executeDesktopAppWindowClientAction(
    request: Parameters<NonNullable<ActionExecutorDeps['clientActionExecute']>>[0],
    options: DesktopAppWindowActionOptions = {},
): Promise<ActionExecuteResult> {
    const { serverId, runtimeAccountId: accountId } = request.context;
    if (!serverId || !accountId) return request.execute();
    const { resolveDesktopAppWindowForAction, waitForDesktopAppWindowPresentation } = await import('@/desktop/window/appWindowRuntime');
    const address = { actionId: request.actionId, input: request.input, serverId, accountId,
        defaultSessionId: request.context.defaultSessionId };
    await waitForDesktopAppWindowPresentation(address);
    const label = resolveDesktopAppWindowForAction(address);
    if (!label || label === getDesktopHostWindowLabel()) return request.execute();
    return executeDesktopAppWindowAdmittedAction(label, request, options);
}

/** Continue an already-admitted mounted effect at an exact renderer, including workspace lifecycle callers. */
export async function executeDesktopAppWindowAdmittedAction(
    label: `destination_${string}`,
    request: Pick<Parameters<NonNullable<ActionExecutorDeps['clientActionExecute']>>[0], 'actionId' | 'input' | 'context'>,
    options: DesktopAppWindowActionOptions = {},
): Promise<ActionExecuteResult> {
    const context = request.context;
    const { serverId, runtimeAccountId: accountId } = context;
    if (!serverId || !accountId) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    if (getDesktopHostWindowLabel() === label) {
        const { executeAdmittedDesktopAppWindowAction } = await import('./defaultActionExecutor');
        return executeAdmittedDesktopAppWindowAction(request.actionId, request.input, { ...context, serverId }, options);
    }
    const wire = buildUiActionDispatchRequestV1(request);
    const source = getDesktopHostWindowLabel();
    const windowLabel = source?.startsWith('destination_') ? source as `destination_${string}` : 'main';
    const result = await executeDesktopWindowActionWithResult({ windowLabel,
        targetWindowLabel: label, actionIdentifier: ADMITTED_CLIENT_ACTION,
        data: { request: wire, serverId, accountId, options } }, { signal: context.signal });
    const execution = result.ok ? { ok: true as const, result: result.result }
        : { ok: false as const, errorCode: result.errorCode ?? 'target_unavailable', error: result.error ?? 'target_unavailable',
            ...(result.details === undefined ? {} : { details: result.details }) };
    return parseClientActionDispatchResult(request.actionId, { v: 1, execution })
        ?? { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
}

/** A destination consumes admitted effects through its existing mounted owners. */
export async function registerDesktopAppWindowActionResponder(): Promise<() => void> {
    if (!getDesktopHostWindowLabel()?.startsWith('destination_')) return () => {};
    const watches = new Map<string, AbortController>();
    const unlisten = await listenDesktopWindowAction(request => {
        if (request.windowLabel === 'main' && request.actionIdentifier === PERSON_COMPOSER_TRANSACTION && request.requestId) {
            const requestId = request.requestId;
            fireAndForget((async () => {
                const input = ComposerTransactionApplyInputV1Schema.safeParse(request.data.input);
                const result = input.success ? await applyLocalPersonComposerTransaction(input.data)
                    : { ok: false as const, errorCode: 'invalid_action_input', error: 'invalid_action_input' };
                await emitDesktopWindowActionResult({ windowLabel: 'main', requestId, phase: 'settled', ...result });
            })(), { onError: () => fireAndForget(emitDesktopWindowActionResult({ windowLabel: 'main', requestId,
                phase: 'settled', ok: false, errorCode: 'action_failed', error: 'action_failed' })) });
            return;
        }
        if (request.actionIdentifier === DESKTOP_SESSION_DRAFT_UNWATCH) {
            if (typeof request.data.watchId === 'string') {
                watches.get(request.data.watchId)?.abort();
                watches.delete(request.data.watchId);
            }
            return;
        }
        if (request.actionIdentifier === DESKTOP_SESSION_DRAFT_WATCH && request.requestId) {
            const target = readDesktopSessionDraftWatchTarget(request.data);
            if (!target) return;
            const requestId = request.requestId;
            watches.get(requestId)?.abort();
            const lifetime = new AbortController();
            watches.set(requestId, lifetime);
            lifetime.signal.addEventListener('abort', () => {
                if (watches.get(requestId) === lifetime) watches.delete(requestId);
            }, { once: true });
            void watchLocalSessionDraft(target, snapshot => {
                fireAndForget(emitDesktopWindowActionResult({ windowLabel: request.windowLabel, requestId, phase: 'settled',
                    ok: true, result: snapshot }));
            }, lifetime.signal).then(stop => {
                if (lifetime.signal.aborted) stop();
                else lifetime.signal.addEventListener('abort', stop, { once: true });
            }).catch(() => {
                if (!lifetime.signal.aborted) fireAndForget(emitDesktopWindowActionResult({ windowLabel: request.windowLabel,
                    requestId, phase: 'settled', ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }));
                lifetime.abort();
                if (watches.get(requestId) === lifetime) watches.delete(requestId);
            });
            return;
        }
        if ((request.actionIdentifier !== ADMITTED_CLIENT_ACTION && request.actionIdentifier !== RETURN_PRESENTATION
            && request.actionIdentifier !== RESUME_PRESENTATION) || !request.requestId) return;
        void (async () => {
            const address = { windowLabel: request.windowLabel, requestId: request.requestId! };
            if (request.actionIdentifier === RETURN_PRESENTATION) {
                try {
                    const returned = await prepareDesktopAppWindowReturn(request.data.intent === 'close' ? 'close' : 'return');
                    await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: returned,
                        ...(returned ? { result: { returned: true } } : { errorCode: 'cancelled', error: 'cancelled' }) });
                } catch {
                    await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: false,
                        errorCode: 'action_failed', error: 'action_failed' });
                }
                return;
            }
            if (request.actionIdentifier === RESUME_PRESENTATION) {
                try {
                    const resumed = await resumePresentation();
                    await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: resumed,
                        ...(resumed ? { result: { resumed: true } } : { errorCode: 'target_unavailable', error: 'target_unavailable' }) });
                } catch {
                    await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: false,
                        errorCode: 'action_failed', error: 'action_failed' });
                }
                return;
            }
            const admitted = UiActionDispatchRequestV1Schema.safeParse(request.data.request);
            const { serverId, accountId } = request.data;
            if (!admitted.success || typeof serverId !== 'string' || typeof accountId !== 'string') {
                await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: false,
                    errorCode: 'invalid_action_input', error: 'invalid_action_input' });
                return;
            }
            try {
                const { executeAdmittedDesktopAppWindowAction } = await import('./defaultActionExecutor');
                const execution = await executeAdmittedDesktopAppWindowAction(admitted.data.actionId, admitted.data.input,
                    { ...admitted.data.context, serverId, runtimeAccountId: accountId, expectedAccountId: accountId },
                    { screenCaptureSendDraftOnly: request.data.options !== null && typeof request.data.options === 'object'
                        && 'screenCaptureSendDraftOnly' in request.data.options && request.data.options.screenCaptureSendDraftOnly === true,
                    screenCaptureWindowPress: request.data.options !== null && typeof request.data.options === 'object'
                        && 'screenCaptureWindowPress' in request.data.options && request.data.options.screenCaptureWindowPress === true });
                await emitDesktopWindowActionResult({ ...address, phase: 'settled', ...execution });
            } catch {
                await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: false,
                    errorCode: 'action_failed', error: 'action_failed' });
            }
        })();
    });
    return () => { unlisten(); for (const lifetime of watches.values()) lifetime.abort(); watches.clear(); };
}
