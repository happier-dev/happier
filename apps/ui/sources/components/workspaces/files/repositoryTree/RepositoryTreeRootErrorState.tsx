import * as React from 'react';
import { resolveFilesystemErrorReason } from '@/components/ui/filesystemBrowser/filesystemErrorReason';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { CheckoutUnreachableState, useAnnouncedCheckoutMachine, useCheckoutReachability, type CheckoutMachineScope } from '@/components/workspaces/reachability/checkoutReachability';
import { t } from '@/text';

/** Files failures belong here, including an unresolved target before any directory read. */
export function RepositoryTreeRootErrorState(props: Readonly<{
    /** The machine the files live on, so the title says where the listing failed. */
    machineName?: string | null;
    /** Known attribution when target resolution cannot yet supply an executable scope. */
    machineScope?: CheckoutMachineScope | null;
}> & (Readonly<{ kind?: 'error'; error: string; onRetry: () => void }>
    | Readonly<{ kind: 'unavailable'; error?: never; onRetry?: () => void }>)) {
    // A listing that waits for an unreachable machine is that one state, not a failure of its own.
    const announcedMachine = useAnnouncedCheckoutMachine();
    const reachability = useCheckoutReachability(props.machineScope ?? announcedMachine);
    if (props.kind === 'unavailable' && reachability.unreachable) {
        return <CheckoutUnreachableState reachability={reachability} testID="repository-tree-unreachable" />;
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
        action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
    />;
}
