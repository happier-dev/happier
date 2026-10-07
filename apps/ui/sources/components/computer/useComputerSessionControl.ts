import * as React from 'react';
import type { ComputerSelectedTargetResponseV1 } from '@happier-dev/protocol';
import type { HappierPresenceTakeControlResult } from '@happier-dev/plugin-ui/presentation';

import type { BrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import {
    getComputerSessionProjection,
    type ComputerActionExecute,
    type ComputerControlClient,
    type ComputerSessionScope,
} from '@/sync/domains/computer/computerControlClient';
import { projectComputerCopresence } from '@/sync/domains/computer/presence';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

let frontDoorExecute: ComputerActionExecute | null = null;
const EMPTY_SNAPSHOT = { selection: null, status: null };
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
    /** A person's press is in flight (hand back or a fresh look). */
    busy: 'handBack' | 'check' | null;
    /** The last refusal code from the owner, for the one line that says what happened. */
    failure: string | null;
    takeControl: () => Promise<HappierPresenceTakeControlResult>;
    handBack: () => void;
    checkAgain: () => void;
    /** End the share: the owner drains the agent first and keeps the window if it cannot confirm that. */
    stopSharing: () => void;
    /** Re-read the selection and who is in control (after the picker chose, or on reopen). */
    refresh: () => void;
    /** The picker's answer, applied without another read. */
    applySelection: (selection: ComputerSelectedTargetResponseV1) => void;
}>;

/**
 * The person's side of a shared window: who is in control (the computer owner's `control.status`), and
 * Take control / Hand back / Check again against that owner. Controller truth is never mirrored here: the
 * only local fact is the gap between a press and the owner's answer. Mounted readers share the
 * domain's Session projection and refresh on Actions and actual lifecycle changes, never on frames.
 */
export function useComputerSessionControl(input: Readonly<{
    scope: ComputerSessionScope | null;
    execute?: ComputerActionExecute;
    refreshKey?: unknown;
}>): ComputerSessionControl {
    const { scope } = input;
    const execute = input.execute ?? getFrontDoorExecute();
    const serverId = scope?.serverId ?? null;
    const sessionId = scope?.sessionId ?? null;
    const machineId = scope?.machineId ?? null;
    const projection = React.useMemo(
        () => (sessionId && machineId ? getComputerSessionProjection({ serverId, sessionId, machineId }, execute) : null),
        [execute, machineId, serverId, sessionId],
    );
    const client: ComputerControlClient | null = projection?.client ?? null;
    const subscribe = React.useCallback((listener: () => void) => projection?.subscribe(listener) ?? (() => {}), [projection]);
    const getSnapshot = React.useCallback(() => projection?.getSnapshot() ?? EMPTY_SNAPSHOT, [projection]);
    const { selection, status } = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [stopRequested, setStopRequested] = React.useState(false);
    const [busy, setBusy] = React.useState<ComputerSessionControl['busy']>(null);
    const [failure, setFailure] = React.useState<string | null>(null);
    const clientRef = React.useRef(client);
    clientRef.current = client;
    const refreshStatus = React.useCallback(() => projection?.refresh() ?? Promise.resolve(), [projection]);

    React.useEffect(() => {
        setStopRequested(false);
        setFailure(null);
    }, [client]);

    const refreshKey = input.refreshKey;
    const lastRefresh = React.useRef({ projection, refreshKey });
    React.useEffect(() => {
        const previous = lastRefresh.current;
        lastRefresh.current = { projection, refreshKey };
        if (previous.projection === projection && !Object.is(previous.refreshKey, refreshKey)) void projection?.refresh(true);
    }, [projection, refreshKey]);

    const takeControl = React.useCallback(async (): Promise<HappierPresenceTakeControlResult> => {
        const owner = client;
        if (!owner) return { status: 'failed' };
        setStopRequested(true);
        setFailure(null);
        const result = await owner.interrupt();
        if (clientRef.current !== owner) return { status: 'unknown' };
        if (!result.ok) setFailure(result.code);
        else if (result.value.status === 'failed') setFailure(result.value.code);
        await refreshStatus();
        if (clientRef.current !== owner) return { status: 'unknown' };
        setStopRequested(false);
        return { status: !result.ok
            ? result.code === 'machine_unreachable' || result.code === 'invalid_action_output' ? 'unknown' : 'failed'
            : result.value.status === 'interrupted' || result.value.status === 'dispatched' ? 'accepted' : 'failed' };
    }, [client, refreshStatus]);

    const handBack = React.useCallback(() => {
        const owner = client;
        if (!owner) return;
        setBusy('handBack');
        setFailure(null);
        void (async () => {
            const result = await owner.handBack();
            if (clientRef.current !== owner) return;
            if (!result.ok) setFailure(result.code);
            else if (result.value.status === 'failed') setFailure(result.value.code);
            await refreshStatus();
            setBusy(null);
        })();
    }, [client, refreshStatus]);

    const checkAgain = React.useCallback(() => {
        const owner = client;
        if (!owner) return;
        setBusy('check');
        setFailure(null);
        void (async () => {
            // The person's own look at the window is the fresh observation that confirms the release.
            const result = await owner.observe();
            if (clientRef.current !== owner) return;
            if (!result.ok) setFailure(result.code);
            else if (result.value.status === 'failed') setFailure(result.value.code);
            await refreshStatus();
            setBusy(null);
        })();
    }, [client, refreshStatus]);

    const stopSharing = React.useCallback(() => {
        const owner = client;
        if (!owner) return;
        setBusy('handBack');
        setFailure(null);
        void (async () => {
            const result = await owner.stopSharing();
            if (clientRef.current !== owner) return;
            if (!result.ok) setFailure(result.code);
            else if (result.value.status !== 'dispatched') setFailure(result.value.status === 'failed' ? result.value.code : 'control_not_drained');
            await refreshStatus();
            setBusy(null);
        })();
    }, [client, refreshStatus]);

    const refresh = React.useCallback(() => {
        void refreshStatus();
    }, [refreshStatus]);

    const applySelection = React.useCallback((next: ComputerSelectedTargetResponseV1) => {
        projection?.applySelection(next);
        void refreshStatus();
    }, [projection, refreshStatus]);

    const presence = React.useMemo(() => projectComputerCopresence({ status, stopRequested }), [status, stopRequested]);
    const agentActing = status?.controller === 'agent' && status.activity !== undefined;
    const targetTitle = selection?.approvalDisplay.target?.title.trim() || null;
    const appName = selection?.approvalDisplay.appName ?? null;
    const machineName = selection?.approvalDisplay.machineDisplayName ?? null;

    return React.useMemo(() => ({
        selection, presence, agentActing, targetTitle, appName, machineName, busy, failure,
        takeControl, handBack, checkAgain, stopSharing, refresh, applySelection,
    }), [agentActing, appName, applySelection, busy, checkAgain, failure, handBack, machineName, presence, refresh, selection, stopSharing, takeControl, targetTitle]);
}
