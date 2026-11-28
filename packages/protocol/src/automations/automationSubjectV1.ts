import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../sessions/idsV1.js';
import { MachineTargetV1Schema } from '../machines/machineAccessV1.js';
import { QualifiedProjectKeyV1Schema } from '../workspaces/workspaceRefV1.js';
import { DeploymentEnvironmentRefV1Schema } from '../deployments/deploymentEnvironmentRefV1.js';
import { DeploymentBackupRestoreDatabaseDestinationV1Schema } from '../deployments/deploymentBackupRestoreV1.js';
import { environmentSecretBindingIdentityV1, type EnvironmentDataRoleAddressV1 } from '../deployments/storedAppInputV1.js';
import { DatabaseManualTargetV1Schema, DatabaseWorktreeTargetV1Schema, DatabaseManagedDeploymentTargetV1Schema, type DatabaseTargetV1 } from '../databases/databaseTargetIdentityV1.js';
import { SavedHealthCheckSelectorV1Schema } from '../deployments/healthCheckSourceV1.js';
import { ApprovalProfileIdV1Schema } from '../actions/approvalProfileIdV1.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';

const automationDatabaseFindingBindingTarget = lazyZodSchema(() => z.strictObject({
    kind: z.literal('binding'),
    bindingId: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)),
}));

/** An Event can match the binding without receiving its locally resolved database endpoint. */
export const AutomationDatabaseFindingSubjectV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('database'),
    serverId: MachineTargetV1Schema.shape.serverId,
    target: automationDatabaseFindingBindingTarget,
}));
export type AutomationDatabaseFindingSubjectV1 = z.infer<typeof AutomationDatabaseFindingSubjectV1Schema>;

/** C1 identity epoch V1: all identity envelopes are closed. No visibility is implied. */
export const AutomationDatabaseSubjectV1Schema = lazyZodSchema(() => {
    const destination = DeploymentBackupRestoreDatabaseDestinationV1Schema.shape;
    const managed = DatabaseManagedDeploymentTargetV1Schema.shape;
    return z.strictObject({
        kind: z.literal('database'),
        serverId: MachineTargetV1Schema.shape.serverId,
        target: z.discriminatedUnion('kind', [z.strictObject({
            kind: z.literal('environment'),
            environmentId: DeploymentEnvironmentRefV1Schema.shape.environmentId,
            service: destination.service,
            database: destination.database,
        }), DatabaseWorktreeTargetV1Schema, DatabaseManualTargetV1Schema, z.strictObject({
            kind: managed.kind,
            environmentId: DeploymentEnvironmentRefV1Schema.shape.environmentId,
            targetLinkId: managed.targetLinkId,
            databaseName: managed.database,
        }), automationDatabaseFindingBindingTarget]),
    });
});
export type AutomationDatabaseSubjectV1 = z.infer<typeof AutomationDatabaseSubjectV1Schema>;

type DatabaseFindingBinding = Readonly<{ kind: 'environment_binding'; environmentId: string; address: EnvironmentDataRoleAddressV1 }>;

/** Match the existing write-role binding, independent of its endpoint or credential revision. */
export function projectAutomationDatabaseFindingSubjectV1(serverId: string,
    target: DatabaseTargetV1 | DatabaseFindingBinding): AutomationDatabaseFindingSubjectV1 {
    const binding = target.kind === 'managed_deployment'
        ? { environmentId: target.environment.environmentId, address: { targetLinkId: target.targetLinkId } }
        : target.kind === 'deployment_service'
            ? { environmentId: target.environment.environmentId, address: { service: target.serviceId } }
            : target.kind === 'environment_binding' ? target : null;
    const identity = binding
        ? [binding.environmentId, environmentSecretBindingIdentityV1({ purpose: 'dataRole', role: 'write', ...binding.address })]
        : [createCanonicalJsonSigningInput(target)];
    return AutomationDatabaseFindingSubjectV1Schema.parse({ kind: 'database', serverId, target: {
        kind: 'binding', bindingId: computeCanonicalDomainSeparatedDigest('happier.database.finding-binding.v1', identity),
    } });
}

/** Accept only a sanitized, structured selector; never an endpoint or execution value. */
export function projectAutomationDatabaseSubjectV1(subject: AutomationDatabaseSubjectV1): AutomationDatabaseSubjectV1 {
    return AutomationDatabaseSubjectV1Schema.parse(subject);
}

export const AutomationDatabaseSubjectReadV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), subject: AutomationDatabaseSubjectV1Schema }),
    z.strictObject({ ok: z.literal(false), code: z.literal('subject_kind_unavailable') }),
]));
export type AutomationDatabaseSubjectReadV1 = z.infer<typeof AutomationDatabaseSubjectReadV1Schema>;

/** Resolve an admitted Database binding once, before a read consumer receives it. */
export function readAutomationDatabaseSubjectV1(serverId: string, target: DatabaseTargetV1): AutomationDatabaseSubjectReadV1 {
    return { ok: true, subject: projectAutomationDatabaseSubjectV1({ kind: 'database', serverId,
        target: target.kind === 'managed_deployment' ? { kind: 'managed_deployment',
            environmentId: target.environment.environmentId, targetLinkId: target.targetLinkId, databaseName: target.database }
            : target.kind === 'deployment_service' ? { kind: 'environment',
            environmentId: target.environment.environmentId, service: target.serviceId, database: target.database } : target }) };
}

export const AutomationSessionSubjectV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('session'), serverId: MachineTargetV1Schema.shape.serverId,
    sessionId: asProtocolZod(SessionIdSchema),
}));
export const AutomationProjectSubjectV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('project'), ...QualifiedProjectKeyV1Schema.shape,
}));
export const AutomationMachineSubjectV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('machine'), ...MachineTargetV1Schema.shape,
}));
export const AutomationHealthCheckSubjectV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('healthCheck'), serverId: MachineTargetV1Schema.shape.serverId,
    ...SavedHealthCheckSelectorV1Schema.shape,
}));
export type AutomationHealthCheckSubjectV1 = z.infer<typeof AutomationHealthCheckSubjectV1Schema>;

export const AutomationSubjectV1Schema = lazyZodSchema(() => {
    const serverId = MachineTargetV1Schema.shape.serverId;
    const environment = DeploymentEnvironmentRefV1Schema.shape;
    return z.discriminatedUnion('kind', [
        AutomationSessionSubjectV1Schema,
        AutomationProjectSubjectV1Schema,
        z.strictObject({ kind: z.literal('environment'), serverId, environmentId: environment.environmentId }),
        z.strictObject({ kind: z.literal('app'), serverId, projectSourceId: environment.projectSourceId }),
        AutomationMachineSubjectV1Schema,
        AutomationDatabaseSubjectV1Schema,
        AutomationHealthCheckSubjectV1Schema,
        z.strictObject({ kind: z.literal('backup'), serverId, environmentId: environment.environmentId }),
        z.strictObject({ kind: z.literal('plugin'), serverId,
            pluginId: asProtocolZod(PluginIdSchema), subjectKindId: asProtocolZod(PluginContributionLocalIdSchema),
            // The contribution owner validates its declared schema at ingress.
            identity: StrictJsonValueSchema }),
        z.strictObject({ kind: z.literal('approvalProfile'), serverId,
            profileId: ApprovalProfileIdV1Schema }),
    ]);
});
export type AutomationSubjectV1 = z.infer<typeof AutomationSubjectV1Schema>;
/** Action and Event headers share this projection of protected authored intent. */
export function checkAutomationSubjectStructuralV1(
    subject: Readonly<{ subjectKind?: string; subjectKey?: string }>,
    context: { addIssue: (issue: { code: 'custom'; path: string[]; message: string }) => void },
): void {
    if ((subject.subjectKind === undefined) !== (subject.subjectKey === undefined)) {
        context.addIssue({ code: 'custom', path: ['subjectKey'], message: 'Subject kind and key belong together' });
    }
}
export const AutomationSubjectStructuralV1Schema = lazyZodSchema(() => z.strictObject({
    subjectKind: z.optional(z.string().check(z.minLength(1))),
    subjectKey: z.optional(z.string().check(z.minLength(1))),
}).check(z.superRefine(checkAutomationSubjectStructuralV1)));
export type AutomationSubjectStructuralV1 = z.infer<typeof AutomationSubjectStructuralV1Schema>;
export function projectAutomationSubjectStructuralV1(
    subject: AutomationSubjectV1 | undefined,
): AutomationSubjectStructuralV1 {
    return subject === undefined ? {} : {
        subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject),
    };
}
/** Declarations consume the union's discriminants rather than keeping another kind catalog. */
export const AutomationSubjectKindV1Schema = lazyZodSchema(() => z.union(
    AutomationSubjectV1Schema._zod.def.options.map(subject => subject.shape.kind),
));
export type AutomationSubjectKindV1 = z.infer<typeof AutomationSubjectKindV1Schema>;
export const AutomationSubjectContextV1Schema = lazyZodSchema(() => z.strictObject({
    role: z.enum(['operand', 'context']), subject: AutomationSubjectV1Schema,
}));
export type AutomationSubjectContextV1 = z.infer<typeof AutomationSubjectContextV1Schema>;
/** Safe invocation evidence retains only the canonical identity digest. */
export type AutomationSubjectKeyContextV1 = Readonly<{
    role: AutomationSubjectContextV1['role'];
    kind: string;
    key: string;
}>;

/** Shared tuples can be projected without reopening an encrypted authored subject. */
export function automationSubjectSharedKeyV1(subjectKey: string, workflowId: string): string {
    return computeCanonicalDomainSeparatedDigest('happier.automation.subject.workflow.v1', [workflowId, subjectKey]);
}

/** Workflow-keyed projection for shared tuples; omit workflowId for the local index. */
export function automationSubjectKeyV1(subject: AutomationSubjectV1, workflowId?: string): string {
    const key = computeCanonicalDomainSeparatedDigest('happier.automation.subject.v1', [createCanonicalJsonSigningInput(subject)]);
    return workflowId === undefined ? key : automationSubjectSharedKeyV1(key, workflowId);
}

/** Membership/visibility is decided by admission; this compares already admitted identities. */
export function automationSubjectMatchesV1(
    subject: AutomationSubjectV1 | undefined,
    contexts: readonly AutomationSubjectContextV1[],
): boolean {
    if (subject === undefined) return true;
    return automationSubjectKeyMatchesV1(automationSubjectKeyV1(subject), contexts, undefined, subject.kind);
}

/** Structural trigger projections compare the same identity without disclosing its private leaves. */
export function automationSubjectKeyMatchesV1(
    key: string,
    contexts: readonly (AutomationSubjectContextV1 | AutomationSubjectKeyContextV1)[],
    workflowId?: string,
    kind?: string,
): boolean {
    return contexts.some(context => {
        const contextKind = 'subject' in context ? context.subject.kind : context.kind;
        const contextKey = 'subject' in context ? automationSubjectKeyV1(context.subject, workflowId)
            : workflowId === undefined ? context.key : automationSubjectSharedKeyV1(context.key, workflowId);
        return (kind === undefined || contextKind === kind)
            && (contextKind !== 'approvalProfile' || context.role === 'context') && contextKey === key;
    });
}
