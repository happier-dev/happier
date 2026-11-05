import { UiActionDispatchRequestV1Schema, parseClientActionDispatchResult, type UiActionDispatchRequestV1 } from '@happier-dev/protocol/actions/clientDispatchV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ComposerTransactionApplyInputV1Schema } from '@happier-dev/protocol/actions/composerIngressAction';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import { ComposerSnapshotV1Schema, type ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import { randomUUID } from '@/platform/randomUUID';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { applyDesktopSessionDraftTransaction, DESKTOP_SESSION_DRAFT_WATCH, DESKTOP_SESSION_DRAFT_UNWATCH, readDesktopSessionDraftWatchTarget, watchDesktopSessionDraft } from '@/sync/ops/actions/desktopAppWindowActionDispatch';
import { emitDesktopWindowAction, emitDesktopWindowActionResult, executeDesktopWindowActionWithResult, listenDesktopWindowActionResult, type DesktopWindowActionRequest } from '@/utils/platform/desktopWindowActionBridge';

export type DesktopActivityOverlayActionRequest = Readonly<{
    serverId: string;
    accountId: string;
    request: UiActionDispatchRequestV1;
}>;

/** The auxiliary overlay has no Sync; main routes person input to its document owner and admits agent Actions. */
export async function executeDesktopActivityOverlayAction(input: DesktopActivityOverlayActionRequest): Promise<ActionExecuteResult> {
    const result = await executeDesktopWindowActionWithResult({ windowLabel: 'activity_overlay',
        actionIdentifier: RPC_METHODS.UI_ACTION_EXECUTE, data: input });
    return parseClientActionDispatchResult(input.request.actionId, { v: 1, execution: result.ok
        ? { ok: true, result: result.result }
        : { ok: false, errorCode: result.errorCode ?? 'action_failed', error: result.error ?? 'action_failed' } })
        ?? { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
}

/** Initial read and later changes share one exact-address subscription; dispose on retarget/unmount. */
export async function watchDesktopActivityOverlaySessionDraft(target: ExactSessionMachineTargetIdentity,
    onSnapshot: (snapshot: ComposerSnapshotV1 | null) => void,
    options: Readonly<{ signal?: AbortSignal }> = {}): Promise<() => Promise<void>> {
    const requestId = randomUUID();
    let stopped = false;
    const unlisten = await listenDesktopWindowActionResult(result => {
        if (stopped || result.phase === 'admitted' || result.windowLabel !== 'activity_overlay' || result.requestId !== requestId) return;
        const parsed = ComposerSnapshotV1Schema.safeParse(result.result);
        if (result.ok && (parsed.success || result.result === null)) onSnapshot(parsed.success ? parsed.data : null);
    });
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        unlisten();
        options.signal?.removeEventListener('abort', onAbort);
        await emitDesktopWindowAction({ windowLabel: 'activity_overlay', actionIdentifier: DESKTOP_SESSION_DRAFT_UNWATCH,
            data: { watchId: requestId } });
    };
    const onAbort = () => { fireAndForget(stop()); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const initial = await executeDesktopWindowActionWithResult({ windowLabel: 'activity_overlay', requestId,
            actionIdentifier: DESKTOP_SESSION_DRAFT_WATCH, data: { ...target } }, { signal: options.signal });
        if (!initial.ok) throw Object.assign(new Error(initial.error ?? 'target_unavailable'), { code: initial.errorCode });
        return stop;
    } catch (error) { await stop(); throw error; }
}

/** Owns only active overlay subscriptions; document state stays in the presenting repository. */
export function createDesktopActivityOverlayActionHandler(executor: Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'>): Readonly<{
    handle(request: DesktopWindowActionRequest): boolean;
    dispose(): void;
}> {
    const watches = new Map<string, AbortController>();
    return {
        handle(request) {
            if (request.windowLabel !== 'activity_overlay') return false;
            if (request.actionIdentifier === RPC_METHODS.UI_ACTION_EXECUTE) {
                fireAndForget(dispatchDesktopActivityOverlayAction(request, executor));
                return true;
            }
            if (request.actionIdentifier === DESKTOP_SESSION_DRAFT_UNWATCH) {
                if (typeof request.data.watchId === 'string') {
                    watches.get(request.data.watchId)?.abort();
                    watches.delete(request.data.watchId);
                }
                return true;
            }
            if (request.actionIdentifier !== DESKTOP_SESSION_DRAFT_WATCH || !request.requestId) return false;
            const requestId = request.requestId;
            const target = readDesktopSessionDraftWatchTarget(request.data);
            const publish = (snapshot: ComposerSnapshotV1 | null) => emitDesktopWindowActionResult({
                windowLabel: 'activity_overlay', requestId, phase: 'settled', ok: true, result: snapshot });
            if (!target) {
                fireAndForget(emitDesktopWindowActionResult({ windowLabel: 'activity_overlay', requestId, phase: 'settled',
                    ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' }));
                return true;
            }
            watches.get(requestId)?.abort();
            const lifetime = new AbortController();
            watches.set(requestId, lifetime);
            lifetime.signal.addEventListener('abort', () => {
                if (watches.get(requestId) === lifetime) watches.delete(requestId);
            }, { once: true });
            void (async () => {
                const account = await captureLazyActionAccountContext(target.serverId, lifetime.signal);
                if (!areServerAccountScopesEqual(account.accountLifetime.scope, target)) {
                    account.dispose();
                    throw new Error('action_account_scope_changed');
                }
                let stopWatch = () => {};
                const retirement = account.accountLifetime.onRetire(() => { fireAndForget(publish(null)); lifetime.abort(); });
                const release = () => { stopWatch(); retirement.dispose(); account.dispose(); };
                lifetime.signal.addEventListener('abort', release, { once: true });
                if (lifetime.signal.aborted) { release(); return; }
                stopWatch = await watchDesktopSessionDraft(target, snapshot => { fireAndForget(publish(snapshot)); }, lifetime.signal);
                if (lifetime.signal.aborted) stopWatch();
            })().catch(() => {
                if (!lifetime.signal.aborted) fireAndForget(emitDesktopWindowActionResult({ windowLabel: 'activity_overlay', requestId,
                    phase: 'settled', ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }));
                lifetime.abort();
                if (watches.get(requestId) === lifetime) watches.delete(requestId);
            });
            return true;
        },
        dispose() { for (const lifetime of watches.values()) lifetime.abort(); watches.clear(); },
    };
}

/** Called by the existing main overlay listener, before legacy snapshot interactions. */
export async function dispatchDesktopActivityOverlayAction(
    request: DesktopWindowActionRequest,
    executor: Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'>,
): Promise<void> {
    if (request.windowLabel !== 'activity_overlay' || !request.requestId) return;
    const address = { windowLabel: request.windowLabel, requestId: request.requestId };
    const parsed = UiActionDispatchRequestV1Schema.safeParse(request.data.request);
    const { serverId, accountId } = request.data;
    if (!parsed.success || typeof serverId !== 'string' || typeof accountId !== 'string') {
        await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: false,
            errorCode: 'invalid_action_input', error: 'invalid_action_input' });
        return;
    }
    try {
        const { actionId, input, context } = parsed.data;
        // S2: typing is the person's direct composer input. Agent requests retain ordinary Action admission.
        const personTransaction = actionId === 'composer.transaction.apply' && context.surface === 'ui'
            && context.authority === 'present_user' ? ComposerTransactionApplyInputV1Schema.safeParse(input) : null;
        let result: ActionExecuteResult;
        if (personTransaction && (!personTransaction.success || personTransaction.data.ref.kind === 'session')) {
            result = !personTransaction.success
                ? { ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' }
                : !areServerAccountScopesEqual(personTransaction.data.scope, { serverId, accountId })
                    ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }
                    : await applyDesktopSessionDraftTransaction(personTransaction.data);
        } else {
            result = await executor.execute(actionId, input, { ...context, serverId, expectedAccountId: accountId, runtimeAccountId: accountId });
        }
        await emitDesktopWindowActionResult({ ...address, phase: 'settled', ...result });
    } catch {
        await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: false,
            errorCode: 'action_failed', error: 'action_failed' });
    }
}
