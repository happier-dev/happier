import * as React from 'react';
import type { ComputerGrantStatusV1, ComputerSelectedTargetResponseV1, ComputerTargetV1 } from '@happier-dev/protocol/computer/v1';
import type { HappierPresenceTakeControlResult } from '@happier-dev/plugin-ui/presentation';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { BrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import {
    getComputerSessionProjection,
    createComputerControlClient,
    type ComputerActionExecute,
    type ComputerControlClient,
    type ComputerScope,
} from '@/sync/domains/computer/computerControlClient';
import { projectComputerCopresence } from '@/sync/domains/computer/presence';
import { resolveComputerRecovery } from '@/sync/domains/computer/targets';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ComputerClipboardOperationV1, ComputerClipboardResultV1 } from '@happier-dev/protocol/computer/v1';

let frontDoorExecute: ComputerActionExecute | null = null;
const EMPTY_SNAPSHOT = { selection: null, status: null, grants: null, failure: null, failureCause: undefined };
/** The one Action front door, resolved on first use so mounting a viewer builds nothing. */
function getFrontDoorExecute(): ComputerActionExecute {
    return frontDoorExecute ??= createFrontDoorActionExecute();
}

export type ComputerSessionControl = Readonly<{
    /** The Session's selected target and its owner-resolved display facts (null until read). */
    selection: ComputerSelectedTargetResponseV1 | null;
    presence: BrowserCopresence;
    /** The agent's action is in flight (not merely allowed to use the window). */
    agentActing: boolean;
    /** The shared window's title or display label, as the computer owner names it. */
    targetTitle: string | null;
    appName: string | null;
    machineName: string | null;
    /** A person's press is in flight (hand back, a fresh look, or Stop sharing). */
    busy: 'handBack' | 'check' | 'stop' | null;
    /** The last refusal code from the owner, for the one line that says what happened. */
    failure: string | null;
    failureCause?: ActionFailureCauseV1;
    /** `failure` came from the person's Stop sharing: the share is still on and the press can be retried. */
    stopFailed: boolean;
    /** Current owner facts, independent of whether the settings page was opened. */
    canRead: boolean;
    canInput: boolean;
    /** Watching is allowed but the machine's OS denies mouse and keyboard (not a transient stop). */
    inputDenied: boolean;
    /** The machine's OS grants as the owner last read them (null until read). */
    grants: ComputerGrantStatusV1 | null;
    /** The gap between asking the machine to open its privacy pane and its answer. */
    openSettings: 'idle' | 'opening' | 'opened' | 'failed';
    /** Ask the machine's daemon to open the privacy pane for one permission, there. */
    requestSettings: (permission: 'capture' | 'input') => void;
    takeControl: () => Promise<HappierPresenceTakeControlResult>;
    handBack: () => void;
    checkAgain: () => void;
    /** End the share: the owner drains the agent first and keeps the window if it cannot confirm that. */
    stopSharing: () => void;
    /** Re-read the selection and who is in control (after the picker chose, or on reopen). */
    refresh: () => void;
    /** The picker's answer, applied without another read. */
    applySelection: (selection: ComputerSelectedTargetResponseV1) => void;
    clipboard: (operation: ComputerClipboardOperationV1) => Promise<ComputerClipboardResultV1>;
}>;
const EMPTY_LOCAL_PRESENTATION: Readonly<{ stopRequested: boolean; busy: ComputerSessionControl['busy']; failure: string | null; failureCause?: ActionFailureCauseV1; stopFailed: boolean; openSettings: ComputerSessionControl['openSettings'] }> = {
    stopRequested: false, busy: null, failure: null, stopFailed: false, openSettings: 'idle',
};

/**
 * The person's side of a shared window: who is in control (the computer owner's `control.status`), and
 * Take control / Hand back / Check again against that owner. Controller truth is never mirrored here: the
 * only local fact is the gap between a press and the owner's answer. Mounted readers share the
 * domain's Session projection and refresh on Actions and actual lifecycle changes, never on frames.
 */
export function useComputerSessionControl(input: Readonly<{
    scope: ComputerScope | null;
    execute?: ComputerActionExecute;
    refreshKey?: unknown;
    /** A parked viewer retains its owner but withdraws ordinary presentation demand. */
    enabled?: boolean;
    /** Borrowed Session source authority; null deliberately admits no Account reader. */
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): ComputerSessionControl {
    const { scope } = input;
    const borrowedLifetime = useSessionViewerSourceAccountLifetime();
    // An explicit executor owns its source binding. Ordinary UI readers borrow
    // the Session shell's authority, never capture another one here.
    const accountLifetime = input.accountLifetime === undefined
        ? borrowedLifetime ?? (input.execute ? undefined : null) : input.accountLifetime;
    const execute = input.execute ?? getFrontDoorExecute();
    const serverId = scope?.serverId ?? accountLifetime?.scope.serverId ?? null;
    const sessionId = scope?.sessionId ?? null;
    const machineId = scope?.machineId ?? null;
    const personId = scope && 'source' in scope ? scope.source.personId : null;
    const controlScope = React.useMemo<ComputerScope | null>(() => !machineId ? null
        : sessionId ? { sessionId, machineId, serverId }
        : personId ? { source: { kind: 'machine-person', personId }, machineId, serverId } : null,
    [machineId, personId, serverId, sessionId]);
    const enabled = input.enabled ?? true;
    const store = getStorage();
    // Machine identity survives an unavailable Computer owner, but the cached
    // inventory may only disclose facts for this borrowed Home/Account.
    const readCachedMachineName = React.useCallback(() => {
        const state = store.getState();
        if (!machineId || !accountLifetime?.isCurrent()
            || !areServerAccountScopesEqual(state.profileScope, accountLifetime.scope)
            || !selectActiveServerAccountScopeForServer(accountLifetime.scope, serverId)) return null;
        // The viewer puts this name in sentences ("Opening … on {machine}"), so a Machine this device
        // cannot read yet has no name rather than the "Locked machine" / "Loading…" title placeholder.
        return readMachineName(resolveServerScopedMachine(state, serverId, machineId));
    }, [accountLifetime, machineId, serverId, store]);
    const subscribeCachedMachineName = React.useCallback((listener: () => void) =>
        enabled && accountLifetime && machineId ? store.subscribe(listener, {
            machines: true, machineListByServerId: true, machineListStatusByServerId: true, profileScope: true,
        }) : () => {},
    [accountLifetime, enabled, machineId, store]);
    const cachedMachineName = React.useSyncExternalStore(subscribeCachedMachineName, readCachedMachineName, readCachedMachineName);
    const projection = React.useMemo(
        () => (controlScope && accountLifetime !== null ? getComputerSessionProjection(controlScope, execute, accountLifetime) : null),
        [accountLifetime, controlScope, execute],
    );
    const mountedEffects = useMountedActionExecution(input.execute ? null : accountLifetime?.scope ?? null);
    const mountedExecute: ComputerActionExecute = React.useCallback((actionId, actionInput, context) => mountedEffects.execute(actionId, actionInput, {
        ...(context.defaultSessionId ? { defaultSessionId: context.defaultSessionId } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
    }), [mountedEffects.execute]);
    // Read projections keep the incumbent shared executor identity. A mounted
    // effect borrows the same Account but awaits the existing approval owner.
    const client: ComputerControlClient | null = React.useMemo(() => input.execute
        ? projection?.client ?? null
        : controlScope && accountLifetime ? createComputerControlClient(controlScope, mountedExecute, accountLifetime) : null,
    [accountLifetime, controlScope, input.execute, mountedExecute, projection]);
    const subscribe = React.useCallback((listener: () => void) => projection?.subscribe(listener, enabled) ?? (() => {}), [enabled, projection]);
    const getSnapshot = React.useCallback(() => projection?.getSnapshot() ?? EMPTY_SNAPSHOT, [projection]);
    const { selection, status, grants, failure: ownerFailure, failureCause: ownerFailureCause } = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [localPresentation, setLocalPresentation] = React.useState(() => ({ owner: client, ...EMPTY_LOCAL_PRESENTATION }));
    // Press feedback belongs to the exact invoking owner, just like its source
    // facts. Withdraw it during retirement/new binding, before any cleanup effect.
    const { stopRequested, busy, failure, failureCause, stopFailed, openSettings } = localPresentation.owner === client && client?.isCurrent()
        ? localPresentation : EMPTY_LOCAL_PRESENTATION;
    const updateLocalPresentation = React.useCallback((next: Partial<typeof EMPTY_LOCAL_PRESENTATION>) => {
        // A new failure (or its clearing) belongs to whichever press wrote it; only Stop sharing marks its own.
        const owned = 'failure' in next ? { stopFailed: false, failureCause: undefined, ...next } : next;
        setLocalPresentation(previous => ({ ...(previous.owner === client ? previous : EMPTY_LOCAL_PRESENTATION), owner: client, ...owned }));
    }, [client]);
    const clientRef = React.useRef(client);
    clientRef.current = client?.isCurrent() ? client : null;
    const refreshStatus = React.useCallback(() => enabled ? projection?.refresh() ?? Promise.resolve() : Promise.resolve(), [enabled, projection]);

    React.useEffect(() => {
        setLocalPresentation({ owner: client, ...EMPTY_LOCAL_PRESENTATION });
    }, [client]);

    const refreshKey = input.refreshKey;
    const lastRefresh = React.useRef({ projection, refreshKey });
    React.useEffect(() => {
        const previous = lastRefresh.current;
        lastRefresh.current = { projection, refreshKey };
        if (enabled && previous.projection === projection && !Object.is(previous.refreshKey, refreshKey)) void projection?.refresh(true);
    }, [enabled, projection, refreshKey]);

    const takeControl = React.useCallback(async (): Promise<HappierPresenceTakeControlResult> => {
        const owner = client;
        if (!owner?.isCurrent()) return { status: 'failed' };
        updateLocalPresentation({ stopRequested: true, failure: null });
        const result = await owner.interrupt();
        if (clientRef.current !== owner || !owner.isCurrent()) return { status: 'unknown' };
        if (!result.ok) updateLocalPresentation({ failure: result.code, failureCause: result.failureCause });
        else if (result.value.status === 'failed') updateLocalPresentation({ failure: result.value.code });
        await refreshStatus();
        if (clientRef.current !== owner || !owner.isCurrent()) return { status: 'unknown' };
        updateLocalPresentation({ stopRequested: false });
        return { status: !result.ok
            ? result.code === 'machine_unreachable' || result.code === 'invalid_action_output' ? 'unknown' : 'failed'
            : result.value.status === 'interrupted' || result.value.status === 'dispatched' ? 'accepted' : 'failed' };
    }, [client, refreshStatus, updateLocalPresentation]);

    const clipboard = React.useCallback(async (operation: ComputerClipboardOperationV1): Promise<ComputerClipboardResultV1> => {
        const owner = client;
        if (!owner?.isCurrent()) return { ok: false, code: 'action_account_scope_changed' };
        const result = await owner.clipboard(operation);
        if (operation.kind === 'read' && (clientRef.current !== owner || !owner.isCurrent())) return { ok: false, code: 'action_account_scope_changed' };
        return result.ok ? result.value : { ok: false, code: result.code };
    }, [client]);

    const handBack = React.useCallback(() => {
        const owner = client;
        if (!owner?.isCurrent()) return;
        updateLocalPresentation({ busy: 'handBack', failure: null });
        void (async () => {
            const result = await owner.handBack();
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            if (!result.ok) updateLocalPresentation({ failure: result.code, failureCause: result.failureCause });
            else if (result.value.status === 'failed') updateLocalPresentation({ failure: result.value.code });
            await refreshStatus();
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            updateLocalPresentation({ busy: null });
        })();
    }, [client, refreshStatus, updateLocalPresentation]);

    const checkAgain = React.useCallback(() => {
        const owner = client;
        if (!owner?.isCurrent()) return;
        updateLocalPresentation({ busy: 'check', failure: null });
        void (async () => {
            const snapshot = projection?.getSnapshot();
            let identity: Readonly<{ target: ComputerTargetV1; sourceId: string }> | undefined;
            if (snapshot?.status?.uncertain || snapshot?.failure === 'human_input_interruption_uncertain') {
                const selected = snapshot.selection;
                if (!selected?.selectedTarget || !selected.sourceId) {
                    updateLocalPresentation({ busy: null, failure: 'computer_target_not_open' });
                    return;
                }
                // Only the existing selection owner can retire the uncertain
                // native process. A fresh observation cannot clear that quarantine.
                const access = selected.access ?? selected.approvalDisplay.access;
                if (!access) {
                    // Optional wire facts are not permission to widen an existing selection.
                    updateLocalPresentation({ busy: null, failure: 'invalid_action_output' });
                    return;
                }
                const recovered = await owner.selectTarget(selected.selectedTarget, access);
                if (clientRef.current !== owner || !owner.isCurrent()) return;
                if (!recovered.ok || !recovered.value.selectedTarget || !recovered.value.sourceId) {
                    updateLocalPresentation({ failure: recovered.ok ? 'invalid_action_output' : recovered.code,
                        failureCause: recovered.ok ? undefined : recovered.failureCause });
                    await refreshStatus();
                    if (clientRef.current !== owner || !owner.isCurrent()) return;
                    updateLocalPresentation({ busy: null });
                    return;
                }
                projection?.applySelection(recovered.value);
                identity = { target: recovered.value.selectedTarget, sourceId: recovered.value.sourceId };
            }
            // The person's own look at the window is the fresh observation that confirms the release.
            const result = await owner.observe(identity);
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            if (!result.ok) updateLocalPresentation({ failure: result.code, failureCause: result.failureCause });
            else if (result.value.status === 'failed') updateLocalPresentation({ failure: result.value.code });
            await refreshStatus();
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            updateLocalPresentation({ busy: null });
        })();
    }, [client, projection, refreshStatus, updateLocalPresentation]);

    const stopSharing = React.useCallback(() => {
        const owner = client;
        if (!owner?.isCurrent()) return;
        updateLocalPresentation({ busy: 'stop', failure: null });
        void (async () => {
            const result = await owner.stopSharing();
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            // The answer ends the press: Retry is offered at once, not after the follow-up read settles.
            if (!result.ok) updateLocalPresentation({ failure: result.code, failureCause: result.failureCause, stopFailed: true, busy: null });
            else if (result.value.status !== 'dispatched') updateLocalPresentation({ failure: result.value.status === 'failed' ? result.value.code : 'control_not_drained', stopFailed: true, busy: null });
            else {
                updateLocalPresentation({ failure: null, stopFailed: false, busy: null });
                return;
            }
            await refreshStatus();
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            updateLocalPresentation({ busy: null });
        })();
    }, [client, refreshStatus, updateLocalPresentation]);

    const refresh = React.useCallback(() => {
        void refreshStatus();
    }, [refreshStatus]);

    const requestSettings = React.useCallback((permission: 'capture' | 'input') => {
        const owner = client;
        if (!owner?.isCurrent()) return;
        updateLocalPresentation({ openSettings: 'opening' });
        void owner.openSettings(permission).then(result => {
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            updateLocalPresentation({ openSettings: result.ok && result.value.status === 'dispatched' ? 'opened' : 'failed' });
        });
    }, [client, updateLocalPresentation]);

    const applySelection = React.useCallback((next: ComputerSelectedTargetResponseV1) => {
        projection?.applySelection(next);
        void refreshStatus();
    }, [projection, refreshStatus]);

    const presence = React.useMemo(() => projectComputerCopresence({ status, stopRequested }), [status, stopRequested]);
    const agentActing = status?.controller === 'agent' && status.activity !== undefined;
    const targetTitle = selection?.approvalDisplay.target?.title.trim() || null;
    const appName = selection?.approvalDisplay.appName ?? null;
    const machineName = selection?.approvalDisplay.machineDisplayName ?? cachedMachineName;
    const canRead = Boolean(selection?.sourceId && grants?.capture === 'granted');
    // A failed Stop sharing is what the person just did; a read failing alongside it does not replace it.
    const stopFailedNow = stopFailed && failure !== null;
    const currentFailure = stopFailedNow ? failure : ownerFailure ?? failure;
    const currentFailureCause = stopFailedNow || ownerFailure === null ? failureCause : ownerFailureCause;
    const recoveryAction = currentFailure === null ? null : resolveComputerRecovery({ kind: 'failed', code: currentFailure }, 'use')?.action;
    // See/use constrains the Agent, not the person's native stream controls.
    const canInput = canRead && recoveryAction !== 'capture' && recoveryAction !== 'repair_driver'
        && grants?.input === 'granted' && Boolean(status && !status.stopping && !status.uncertain);
    const inputDenied = canRead && grants?.input === 'denied';

    return React.useMemo(() => ({
        selection, presence, agentActing, targetTitle, appName, machineName, busy, failure: currentFailure, failureCause: currentFailureCause, stopFailed: stopFailedNow, canRead, canInput, inputDenied,
        grants, openSettings, requestSettings,
        takeControl, handBack, checkAgain, stopSharing, refresh, applySelection, clipboard,
    }), [agentActing, appName, applySelection, busy, canInput, canRead, inputDenied, checkAgain, clipboard, currentFailure, currentFailureCause, grants, handBack, machineName, openSettings, presence, refresh, requestSettings, selection, stopFailedNow, stopSharing, takeControl, targetTitle]);
}
