import * as React from 'react';
import {
    RequesterDisclosureContent,
    type RequesterDisclosureModel,
} from '@/components/machines/managed/RequesterDisclosure';
import { useActiveServerAccountScope, useServerScopedMachine, useServerScopedMachineLabel } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

type WorkflowRequesterDisclosureProps = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    retention: 'run' | 'trigger';
}>;

const selectCustodian = (machine: Machine | null) => machine?.access?.custodian ?? null;

/**
 * Presents the selected Machine's admitted ownership facts; admission remains with the Action owner.
 * A non-null model is the one "runs on someone else's Machine" fact: surfaces that otherwise say the
 * work runs on the person's own machines read it here rather than deciding placement again.
 */
export function useWorkflowRequesterDisclosure(props: WorkflowRequesterDisclosureProps): RequesterDisclosureModel | null {
    const lifetime = useWorkflowAccountLifetime(props.accountLifetime);
    const activeScope = useActiveServerAccountScope(props.serverId === null ? undefined : props.serverId);
    const scope = lifetime === undefined ? activeScope : lifetime?.scope ?? null;
    const serverId = scope?.serverId ?? props.serverId;
    const custodian = useServerScopedMachine(serverId, props.machineId, selectCustodian);
    const machineLabel = useServerScopedMachineLabel(serverId, props.machineId);
    return React.useMemo<RequesterDisclosureModel | null>(() => scope && custodian && custodian.accountId !== scope.accountId && props.machineId
        ? { owner: custodian.displayName || t('shareSheet.person'), machine: machineLabel || props.machineId,
            signIn: 'full', retention: props.retention }
        : null, [custodian, machineLabel, props.machineId, props.retention, scope]);
}

export function WorkflowRequesterDisclosure(props: WorkflowRequesterDisclosureProps): React.ReactElement | null {
    const model = useWorkflowRequesterDisclosure(props);
    return <WorkflowRequesterDisclosureView model={model} />;
}

export function WorkflowRequesterDisclosureView(props: Readonly<{ model: RequesterDisclosureModel | null }>): React.ReactElement | null {
    return props.model ? <RequesterDisclosureContent model={props.model} /> : null;
}
