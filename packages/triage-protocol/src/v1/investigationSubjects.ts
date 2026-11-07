import { INTERNAL_TASK_SOURCE_V1, type TriageActionSubjectV1, type TriageEntryRefV1, type TriageEntryLocatorV1 } from './identity.js';
import type { TriageFailureSubjectV1, TriageSessionHandoffInputV1 } from './sessionHandoff.js';

const kinds = {
    deploymentReceipt: { id: 'deployment-receipt', workflowSubject: 'other', displayName: 'Deployment' },
    managedMachineOperation: { id: 'managed-machine-operation', workflowSubject: 'other', displayName: 'Machine operation' },
    backupRun: { id: 'backup-run', workflowSubject: 'other', displayName: 'Backup' },
    service: { id: 'native-service', workflowSubject: 'other', displayName: 'Service' },
    domain: { id: 'native-domain', workflowSubject: 'other', displayName: 'Domain' },
    deploymentEnvironment: { id: 'deployment-environment', workflowSubject: 'other', displayName: 'Environment' },
    healthNotice: { id: 'health-notice', workflowSubject: 'other', displayName: 'Health notice' },
} as const;

/** Native records join the incumbent internal source without entering its Task inventory. */
export const TRIAGE_NATIVE_INVESTIGATION_KINDS_V1 = Object.freeze(Object.values(kinds));
export type TriageInvestigationSubjectEntryV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    display: Readonly<{ locator: TriageEntryLocatorV1; scopeLabel: string }>;
}>;

function entry(kind: (typeof kinds)[keyof typeof kinds], scope: readonly string[], entryId: string): TriageInvestigationSubjectEntryV1 {
    return { entryRef: { source: INTERNAL_TASK_SOURCE_V1, kindId: kind.id, collisionScope: JSON.stringify(scope), entryId },
        display: { locator: { v: 1, displayPath: `${kind.displayName} ${entryId}` }, scopeLabel: kind.displayName } };
}

/** Exact native identity, independent of Session placement, outcome or current deployment. */
export function triageFailureSubjectEntryV1(subject: TriageFailureSubjectV1): TriageInvestigationSubjectEntryV1 {
    switch (subject.kind) {
        case 'deploymentReceipt':
            return entry(kinds.deploymentReceipt, [subject.serverId, subject.environmentId], subject.deploymentId);
        case 'managedMachineOperation': case 'backupRun':
            return entry(kinds[subject.kind], [subject.operation.serverId, subject.operation.machineId], subject.operation.operationId);
        case 'domain':
            return entry(kinds.domain, [subject.serverId, subject.environmentId], subject.domainId);
        case 'deploymentEnvironment':
            return entry(kinds.deploymentEnvironment, [subject.serverId], subject.environmentId);
        case 'service': {
            const target = subject.target;
            return target.page === 'machine_service'
                ? entry(kinds.service, [target.machine.serverId, target.machine.machineId], target.service.serviceId)
                : entry(kinds.service, [target.environment.serverId, target.environment.environmentId], target.targetLinkId ?? target.environment.environmentId);
        }
    }
}

/** The action subject a native record's own configured records name; other native records have only `other`. */
export function triageFailureSubjectActionSubjectV1(subject: TriageFailureSubjectV1): TriageActionSubjectV1 | undefined {
    return subject.kind === 'deploymentReceipt' || subject.kind === 'deploymentEnvironment' ? subject.kind : undefined;
}

/** Notice identity stays with its retained Artifact; a current binding cannot identify its old receipt. */
export function triageHealthAlertEntryV1(context: Extract<TriageSessionHandoffInputV1['context'], { kind: 'healthAlert' }>): TriageInvestigationSubjectEntryV1 {
    const serverId = context.target.kind === 'machine' || context.target.page === 'machine_service'
        ? context.target.machine.serverId : context.target.environment.serverId;
    return entry(kinds.healthNotice, [serverId], context.notice.artifactId);
}
