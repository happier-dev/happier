import * as React from 'react';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useSessionActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { refreshActionOperationSnapshot } from '@/sync/domains/actionOperations/consumeActionOperationSnapshotPush';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { describeActionOperationStatusLabel, resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/** The Session selector owns Home/Account attribution; each retained result stays with its operation owner. */
export function DeploymentPreparationOperations(props: Readonly<{ session: SessionAddress; accountId: string }>) {
    const operations = useSessionActionOperations({ ...props.session, accountId: props.accountId });
    if (operations.length === 0) return null;
    return <ItemGroup title={t('projects.deployments.preparation.operationsTitle')}>
        {operations.map(operation => <PreparationOperation key={operation.snapshot.operationId} operation={operation} />)}
    </ItemGroup>;
}

function PreparationOperation({ operation }: Readonly<{ operation: ActionOperationProjection }>) {
    const { serverId, snapshot, snapshotComplete, observation } = operation;
    const { accountId, machineId } = snapshot.scope;
    const { operationId, revision } = snapshot;
    const terminal = isActionOperationTerminal(snapshot.state);
    const [retry, setRetry] = React.useState(0);
    const operationRef = React.useRef(operation);
    operationRef.current = operation;
    // Live lifecycle comes from push/list. Read the complete result only when it
    // settles; an already-complete matching snapshot needs no second read.
    React.useEffect(() => {
        if (!terminal || snapshotComplete) return;
        const cancellation = new AbortController();
        void refreshActionOperationSnapshot({
            operation: operationRef.current,
            shouldContinue: () => !cancellation.signal.aborted,
            readSnapshot: id => getActionOperation({ serverId, accountId, machineId,
                operationId: id, signal: cancellation.signal }),
        });
        return () => cancellation.abort();
    }, [serverId, accountId, machineId, operationId, revision, terminal, snapshotComplete, retry]);
    const testID = `project-deployments.prepare.operation.${operationId}`;
    const status = resolveActionOperationStatus(snapshot, observation);
    return <>
        <Item testID={testID} title={snapshot.title} subtitle={describeActionOperationStatusLabel(status.label)}
            onPress={() => openActionOperationDetail({ serverId, operationId })} />
        {terminal && !snapshotComplete && observation === 'unavailable'
            ? <SurfaceStateCard size="line" kind="unavailable" title={t('projects.deployments.unavailableTitle')}
                action={{ label: t('common.retry'), testID: `${testID}.retry`, onPress: () => setRetry(value => value + 1) }} />
            : null}
    </>;
}
