import * as React from 'react';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';

import { useMachineServicesList } from '@/components/machines/services/useMachineServicesList';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { useAccountWorkflowEditor } from './AccountTriggersSection';
import { projectAccountTriggerRows, type AccountTriggerRow, type TriggerSubject } from './accountTriggerRows';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';

const ACCOUNT_TRIGGER_QUERY = { scope: 'account_inline' } as const;

export type ResourceAutomationsSectionInput = Readonly<{
    subject: TriggerSubject;
    deploymentEnvironment?: DeploymentEnvironmentRefV1;
}>;

export type ResourceAutomationsSectionRead = Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null | undefined;
    read: ReturnType<typeof useWorkflowTriggerSets>;
    editor: ReturnType<typeof useAccountWorkflowEditor>;
    rows: readonly AccountTriggerRow[];
    project: Pick<WorkflowProjectTargetV1, 'machineId' | 'directory'>;
}>;

/** Resource section data and mutations, consuming the incumbent read and presentation lifetimes. */
export function useResourceAutomationsSection(props: ResourceAutomationsSectionInput): ResourceAutomationsSectionRead {
    const { binding } = useServerCredentialAccountScopeBinding(props.deploymentEnvironment?.serverId);
    const accountLifetime = props.deploymentEnvironment ? binding : undefined;
    const demanded = useLayoutPresentationActive();
    const read = useWorkflowTriggerSets(ACCOUNT_TRIGGER_QUERY, accountLifetime, { demanded });
    const editor = useAccountWorkflowEditor({ read, accountLifetime });
    const services = useMachineServicesList({ serverId: props.deploymentEnvironment?.serverId ?? '',
        machineId: props.subject.machineId, environmentId: props.deploymentEnvironment?.environmentId,
        active: demanded && props.subject.kind === 'environment' && props.deploymentEnvironment !== undefined });
    const environmentServices = React.useMemo(() => services.rows?.map(service => ({
        machineId: props.subject.machineId, serviceId: service.serviceId,
    })), [services.rows, props.subject.machineId]);
    const rows = React.useMemo(() => projectAccountTriggerRows({
        sets: read.sets, resolveWorkflowTitle: editor.resolveWorkflowTitle,
        subject: props.subject, services: environmentServices,
    }), [read.sets, editor.resolveWorkflowTitle, props.subject, environmentServices]);
    const project = React.useMemo(() => ({ machineId: props.subject.machineId, directory: '~' }), [props.subject.machineId]);
    return { accountLifetime, read, editor, rows, project };
}
