import * as React from 'react';
import { isFilesystemErrorRetryable, resolveFilesystemErrorReason } from '@/components/ui/filesystemBrowser/filesystemErrorReason';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { CheckoutUnreachableState, useAnnouncedCheckoutMachine, useCheckoutReachability, type CheckoutMachineScope } from '@/components/workspaces/reachability/checkoutReachability';
import { useManagedWorkspaceStart } from '@/components/settings/machines/managed/useManagedWorkspaceStart';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

/** The managed refusal code a stopped provider resource returns (protocol `managedRefusalCodeV1`). */
const MANAGED_POWER_REQUIRED = 'managed_power_required';

/** Files failures belong here, including an unresolved target before any directory read. */
export function RepositoryTreeRootErrorState(props: Readonly<{
    /** The machine the files live on, so the title says where the listing failed. */
    machineName?: string | null;
    /** Known attribution when target resolution cannot yet supply an executable scope. */
    machineScope?: CheckoutMachineScope | null;
    /** The attached workspace this listing reads; a stopped one offers Start through its managed owner. */
    workspaceScope?: WorkspaceScopeBase | null;
}> & (Readonly<{ kind?: 'error'; error: string; onRetry: () => void }>
    | Readonly<{ kind: 'unavailable'; error?: never; onRetry?: () => void }>)) {
    // A listing that waits for an unreachable machine is that one state, not a failure of its own.
    const announcedMachine = useAnnouncedCheckoutMachine();
    const reachability = useCheckoutReachability(props.machineScope ?? announcedMachine);
    if (props.kind === 'unavailable' && reachability.unreachable) {
        return <CheckoutUnreachableState reachability={reachability} returns={t('projects.checkouts.filesReturn')} testID="repository-tree-unreachable" />;
    }
    // A stopped workspace is not a listing failure: it names the workspace and its one next step (lab project-stoppedCold).
    if (props.kind !== 'unavailable' && props.error === MANAGED_POWER_REQUIRED) {
        return props.workspaceScope?.workspace
            ? <StartableWorkspaceStoppedState workspaceName={props.machineName ?? null} workspaceScope={props.workspaceScope} onStarted={props.onRetry} />
            : <WorkspaceStoppedState workspaceName={props.machineName ?? null} action={null} />;
    }
    const reason = props.kind === 'unavailable'
        ? t('files.pane.workspaceUnavailableReason')
        : resolveFilesystemErrorReason(props.error);

    return <SurfaceStateCard
        testID="repository-tree-root-error"
        kind={props.kind ?? 'error'}
        iconName="folder"
        title={props.machineName
            ? t('files.pane.rootErrorTitle', { machine: props.machineName })
            : t('files.pane.rootErrorTitleUnnamed')}
        reason={reason}
        diagnosticCode={props.error}
        action={props.onRetry && isFilesystemErrorRetryable(props.error)
            ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
    />;
}

/** Stopped → Starting → the listing again; Start shows only when the managed owner lets this person start it. */
function StartableWorkspaceStoppedState(props: Readonly<{
    workspaceName: string | null;
    workspaceScope: WorkspaceScopeBase;
    onStarted: () => void;
}>) {
    const start = useManagedWorkspaceStart(props.workspaceScope);
    const pending = start?.pending === true;
    const wasPending = React.useRef(pending);
    const onStarted = React.useRef(props.onStarted);
    onStarted.current = props.onStarted;
    React.useEffect(() => {
        // The power operation settled: read the folder again rather than guessing the workspace's state.
        if (wasPending.current && !pending) onStarted.current();
        wasPending.current = pending;
    }, [pending]);
    if (pending && props.workspaceName) {
        return <SurfaceStateCard testID="repository-tree-root-error" kind="loading"
            title={t('files.pane.managedStartingTitle', { workspace: props.workspaceName })} />;
    }
    return <WorkspaceStoppedState workspaceName={props.workspaceName}
        action={start?.reviewApproval ? { label: t('approvals.details'), onPress: start.reviewApproval }
            : start && !pending ? { label: t('managedMachines.actions.start'), onPress: start.start } : null} />;
}

function WorkspaceStoppedState(props: Readonly<{ workspaceName: string | null; action: Readonly<{ label: string; onPress: () => void }> | null }>) {
    return <SurfaceStateCard
        testID="repository-tree-root-error"
        kind="unavailable"
        iconName="stop-circle"
        title={props.workspaceName
            ? t('files.pane.managedStoppedTitle', { workspace: props.workspaceName })
            : t('files.pane.rootErrorTitleUnnamed')}
        reason={t('files.pane.managedStoppedReason')}
        action={props.action ?? undefined}
    />;
}
