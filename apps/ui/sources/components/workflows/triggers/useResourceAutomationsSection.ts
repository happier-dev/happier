import * as React from 'react';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { useAccountWorkflowEditor } from './AccountTriggersSection';
import { projectAccountTriggerRows, type AccountTriggerRow, type TriggerSubject } from './accountTriggerRows';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';

const EMPTY_ROWS: readonly AccountTriggerRow[] = [];

export type ResourceAutomationsSectionInput = Readonly<{
    subject: AutomationSubjectV1;
    contextSubjects?: readonly AutomationSubjectV1[];
    /** Execution placement is independent of the selected resource's identity. */
    executionContext?: Pick<WorkflowProjectTargetV1, 'machineId' | 'directory'>;
    serverId?: string;
    subjectName?: string;
    deploymentEnvironment?: DeploymentEnvironmentRefV1;
    /** Recipient intent admitted by the accepted Source's grant owner. */
    sourceAudience?: readonly PrincipalRefV1[];
}>;
type LegacyResourceAutomationsSectionInput = Omit<ResourceAutomationsSectionInput, 'subject'> & Readonly<{ subject: TriggerSubject }>;

export type ResourceAutomationsSectionRead = Readonly<{
    accountLifetime: ServerAccountScopeLifetime | null | undefined;
    read: ReturnType<typeof useWorkflowTriggerSets>;
    editor: ReturnType<typeof useAccountWorkflowEditor>;
    rows: readonly AccountTriggerRow[];
    also: readonly AccountTriggerRow[];
    skippedNotSharedCount: number;
    project: Pick<WorkflowProjectTargetV1, 'machineId' | 'directory'> | undefined;

}>;

/** Resource section data and mutations, consuming the incumbent read and presentation lifetimes. */
export function useResourceAutomationsSection(props: LegacyResourceAutomationsSectionInput): ResourceAutomationsSectionRead & { project: Pick<WorkflowProjectTargetV1, 'machineId' | 'directory'> };
export function useResourceAutomationsSection(props: ResourceAutomationsSectionInput): ResourceAutomationsSectionRead;
export function useResourceAutomationsSection(props: ResourceAutomationsSectionInput | LegacyResourceAutomationsSectionInput): ResourceAutomationsSectionRead {
    const activeScope = useActiveServerAccountScope();
    const legacySubject = 'serverId' in props.subject ? null : props.subject;
    const serverId = 'serverId' in props.subject ? props.subject.serverId
        : props.serverId ?? props.deploymentEnvironment?.serverId ?? activeScope?.serverId;
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const accountLifetime = serverId ? binding : undefined;
    const demanded = useLayoutPresentationActive();
    // The retained service page is explicitly its Machine's view; service is not a canonical subject.
    const subject: AutomationSubjectV1 | null = 'serverId' in props.subject ? props.subject : !serverId ? null
        : props.subject.kind === 'environment' ? { kind: 'environment', serverId, environmentId: props.subject.environmentId }
            : { kind: 'machine', serverId, machineId: props.subject.machineId };
    const read = useWorkflowTriggerSets(subject ? { subject, ...(props.contextSubjects ? { contextSubjects: [...props.contextSubjects] } : {}) } : null,
        accountLifetime, { demanded });
    const editor = useAccountWorkflowEditor({ read, accountLifetime });
    const projected = React.useMemo(() => read.attachedPage ? projectAccountTriggerRows({
        sets: read.sets, attachedPage: read.attachedPage, accountId: accountLifetime?.scope.accountId,
        resolveWorkflowTitle: editor.resolveWorkflowTitle,
    }) : EMPTY_ROWS, [read.sets, read.attachedPage, accountLifetime?.scope.accountId, editor.resolveWorkflowTitle]);
    const rows = React.useMemo(() => projected.filter(row => row.attachment?.relation === 'direct'), [projected]);
    const also = React.useMemo(() => projected.filter(row => row.attachment?.relation === 'context'), [projected]);
    const legacyMachineId = legacySubject?.machineId;
    const project = React.useMemo(() => props.executionContext ?? (legacyMachineId ? { machineId: legacyMachineId, directory: '~' } : undefined),
        [props.executionContext, legacyMachineId]);
    return { accountLifetime, read, editor, rows, also, skippedNotSharedCount: read.attachedPage?.skippedNotSharedCount ?? 0, project };
}
