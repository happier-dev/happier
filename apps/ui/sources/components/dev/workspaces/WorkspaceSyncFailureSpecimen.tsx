import * as React from 'react';
import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import { presentWorkspaceSyncFailure } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import { ItemList } from '@/components/ui/lists/ItemList';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { t } from '@/text';

/**
 * Dev-only: a refused Sync action through the real presenter, the sentence with its code under Technical
 * details. `?surface=inline` (default) draws the Add machine form's failure line and disclosure;
 * `?surface=alert` opens the Sync list's shared failure alert. `?cause=projectChanged` (a worker folder in
 * another Project) or `?cause=reviewedChanged` (the reviewed folder changed before the Sync started).
 * No RPC is issued.
 */
export type WorkspaceSyncFailureSpecimenCause = 'projectChanged' | 'reviewedChanged';
export type WorkspaceSyncFailureSpecimenSurface = 'inline' | 'alert';

function refusal(cause: WorkspaceSyncFailureSpecimenCause): Error {
    if (cause === 'projectChanged') return new RpcError('The chosen worker folder belongs to a different Project', 'project_workspace_changed');
    return Object.assign(new RpcError('Workspace sync approval is stale', 'approval_stale'), { failureCause: {
        phase: 'dispatch', errorClass: 'Error', errorCode: 'approval_stale', httpStatus: null,
        nativeErrorReason: 'root_fingerprint.absence_vs_presence',
    } });
}

export function WorkspaceSyncFailureSpecimen(props: Readonly<{ cause: WorkspaceSyncFailureSpecimenCause; surface: WorkspaceSyncFailureSpecimenSurface }>) {
    const failure = React.useMemo(() => presentWorkspaceSyncFailure(refusal(props.cause)), [props.cause]);
    React.useEffect(() => {
        if (props.surface !== 'alert') return;
        alertActionFailure({ reason: failure?.message ?? t('errors.operationFailed'), code: failure?.code ?? null });
    }, [failure, props.surface]);
    if (props.surface === 'alert' || !failure) return <ScrollView testID="workspace-sync-failure-specimen" style={styles.root} />;
    return (
        <ItemList testID="workspace-sync-failure-specimen" presentation="grouped">
            <SurfaceStateCard testID="workspace-sync-add-machine-status" size="line" kind="error"
                title={failure.message} accessibilitySemantics="alert" />
            <TechnicalDetailsDisclosure testID="workspace-sync-add-machine-technical-details"
                title={t('approvals.technicalDetails')} lines={failure.technicalDetails} />
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.base },
}));
