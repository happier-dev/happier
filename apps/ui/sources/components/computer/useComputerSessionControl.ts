import * as React from 'react';
import type { ComputerGrantStatusV1, ComputerSelectedTargetResponseV1 } from '@happier-dev/protocol';
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
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';

let frontDoorExecute: ComputerActionExecute | null = null;
const EMPTY_SNAPSHOT = { selection: null, status: null, grants: null, failure: null };
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
}>;
const EMPTY_LOCAL_PRESENTATION: Readonly<{ stopRequested: boolean; busy: ComputerSessionControl['busy']; failure: string | null; openSettings: ComputerSessionControl['openSettings'] }> = {
    stopRequested: false, busy: null, failure: null, openSettings: 'idle',
};

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
    const projection = React.useMemo(
        () => (sessionId && machineId && accountLifetime !== null ? getComputerSessionProjection({ serverId, sessionId, machineId }, execute, accountLifetime) : null),
        [accountLifetime, execute, machineId, serverId, sessionId],
    );
    const client: ComputerControlClient | null = projection?.client ?? null;
    const enabled = input.enabled ?? true;
    const subscribe = React.useCallback((listener: () => void) => projection?.subscribe(listener, enabled) ?? (() => {}), [enabled, projection]);
    const getSnapshot = React.useCallback(() => projection?.getSnapshot() ?? EMPTY_SNAPSHOT, [projection]);
    const { selection, status, grants, failure: ownerFailure } = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [localPresentation, setLocalPresentation] = React.useState(() => ({ owner: client, ...EMPTY_LOCAL_PRESENTATION }));
    // Press feedback belongs to the exact invoking owner, just like its source
    // facts. Withdraw it during retirement/new binding, before any cleanup effect.
    const { stopRequested, busy, failure, openSettings } = localPresentation.owner === client && client?.isCurrent()
        ? localPresentation : EMPTY_LOCAL_PRESENTATION;
    const updateLocalPresentation = React.useCallback((next: Partial<typeof EMPTY_LOCAL_PRESENTATION>) => {
        setLocalPresentation(previous => ({ ...(previous.owner === client ? previous : EMPTY_LOCAL_PRESENTATION), owner: client, ...next }));
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
        if (!result.ok) updateLocalPresentation({ failure: result.code });
        else if (result.value.status === 'failed') updateLocalPresentation({ failure: result.value.code });
        await refreshStatus();
        if (clientRef.current !== owner || !owner.isCurrent()) return { status: 'unknown' };
        updateLocalPresentation({ stopRequested: false });
        return { status: !result.ok
            ? result.code === 'machine_unreachable' || result.code === 'invalid_action_output' ? 'unknown' : 'failed'
            : result.value.status === 'interrupted' || result.value.status === 'dispatched' ? 'accepted' : 'failed' };
    }, [client, refreshStatus, updateLocalPresentation]);

    const handBack = React.useCallback(() => {
        const owner = client;
        if (!owner?.isCurrent()) return;
        updateLocalPresentation({ busy: 'handBack', failure: null });
        void (async () => {
            const result = await owner.handBack();
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            if (!result.ok) updateLocalPresentation({ failure: result.code });
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
            // The person's own look at the window is the fresh observation that confirms the release.
            const result = await owner.observe();
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            if (!result.ok) updateLocalPresentation({ failure: result.code });
            else if (result.value.status === 'failed') updateLocalPresentation({ failure: result.value.code });
            await refreshStatus();
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            updateLocalPresentation({ busy: null });
        })();
    }, [client, refreshStatus, updateLocalPresentation]);

    const stopSharing = React.useCallback(() => {
        const owner = client;
        if (!owner?.isCurrent()) return;
        updateLocalPresentation({ busy: 'handBack', failure: null });
        void (async () => {
            const result = await owner.stopSharing();
            if (clientRef.current !== owner || !owner.isCurrent()) return;
            if (!result.ok) updateLocalPresentation({ failure: result.code });
            else if (result.value.status !== 'dispatched') updateLocalPresentation({ failure: result.value.status === 'failed' ? result.value.code : 'control_not_drained' });
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
    const machineName = selection?.approvalDisplay.machineDisplayName ?? null;
    const canRead = Boolean(selection?.sourceId && grants?.capture === 'granted');
    // See/use constrains the Agent, not the person's native stream controls.
    const canInput = canRead && grants?.input === 'granted' && Boolean(status && !status.stopping && !status.uncertain);
    const inputDenied = canRead && grants?.input === 'denied';
    const currentFailure = ownerFailure ?? failure;

    return React.useMemo(() => ({
        selection, presence, agentActing, targetTitle, appName, machineName, busy, failure: currentFailure, canRead, canInput, inputDenied,
        grants, openSettings, requestSettings,
        takeControl, handBack, checkAgain, stopSharing, refresh, applySelection,
    }), [agentActing, appName, applySelection, busy, canInput, canRead, inputDenied, checkAgain, currentFailure, grants, handBack, machineName, openSettings, presence, refresh, requestSettings, selection, stopSharing, takeControl, targetTitle]);
}
