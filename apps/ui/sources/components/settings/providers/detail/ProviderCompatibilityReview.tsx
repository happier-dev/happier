import * as React from 'react';

import { SessionModelPicker } from '@/components/sessions/modelPicker/SessionModelPicker';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useConfirmExperimentalProviderModel } from '@/providers/hooks/useConfirmExperimentalProviderModel';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { t } from '@/text';

const NO_NATIVE_MODELS = [] as const;

/** Provider recovery reviews the same projected rows and explicit Action as New Session. */
export function ProviderCompatibilityReview(props: Readonly<{
    connectionId: string;
    agentTargetKey: string;
    machineId: string | null;
    serverId: string | null;
    onReviewed: () => void;
}>): React.ReactElement {
    const projection = useProviderModelProjection({
        enabled: true,
        machineId: props.machineId,
        serverId: props.serverId,
        agentTargetKey: props.agentTargetKey,
        sourceConnectionId: props.connectionId,
    });
    const confirmation = useConfirmExperimentalProviderModel({
        enabled: true,
        machineId: props.machineId,
        serverId: props.serverId,
        agentTargetKey: props.agentTargetKey,
        refresh: projection.refresh,
    });
    return <ItemGroup title={t('settingsProviders.errors.actions.reviewCompatibility')}>
        <SessionModelPicker
            agentTargetKey={props.agentTargetKey}
            nativeModels={NO_NATIVE_MODELS}
            providerGroups={projection.data?.groups.filter(group => group.connectionId === props.connectionId) ?? []}
            providerProjectionAuthoritative={projection.data !== null}
            projectionError={projection.error}
            projectionFailures={projection.refreshFailures}
            projectionApproval={projection.pendingApproval}
            retryProjection={projection.refresh}
            selected={null}
            allowAutomatic={false}
            canEnterCustomValue={false}
            experimentalConfirmation={confirmation}
            onSelect={props.onReviewed}
            onRequestClose={props.onReviewed}
        />
    </ItemGroup>;
}
