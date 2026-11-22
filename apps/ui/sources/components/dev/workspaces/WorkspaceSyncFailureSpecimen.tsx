import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import { presentWorkspaceSyncFailure } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * Dev-only: the alert a Sync action raises when its relationship owner refuses it, through the real presenter
 * and the same `Modal.alert` call the Sync list makes. `?cause=projectChanged` (a worker folder in another
 * Project) or `?cause=reviewedChanged` (the reviewed folder changed before the Sync started). No RPC is issued.
 */
export type WorkspaceSyncFailureSpecimenCause = 'projectChanged' | 'reviewedChanged';

function refusal(cause: WorkspaceSyncFailureSpecimenCause): Error {
    if (cause === 'projectChanged') return new RpcError('The chosen worker folder belongs to a different Project', 'project_workspace_changed');
    return Object.assign(new RpcError('Workspace sync approval is stale', 'approval_stale'), { failureCause: {
        phase: 'dispatch', errorClass: 'Error', errorCode: 'approval_stale', httpStatus: null,
        nativeErrorReason: 'root_fingerprint.absence_vs_presence',
    } });
}

export function WorkspaceSyncFailureSpecimen(props: Readonly<{ cause: WorkspaceSyncFailureSpecimenCause }>) {
    React.useEffect(() => {
        Modal.alert(t('common.error'), presentWorkspaceSyncFailure(refusal(props.cause)) ?? t('errors.operationFailed'));
    }, [props.cause]);
    return <View testID={`workspace-sync-failure-specimen-${props.cause}`} style={styles.root} />;
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.base },
}));
