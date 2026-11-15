import { lazyZodSchema } from '../../lazyZodSchema.js';
import { isWorkspaceSyncRelationshipWriteActionId } from '../../actions/actionIds.js';
import { ActionOperationIdentifierV1Schema } from '../../actions/operations/identifierV1.js';
import { z } from '../../zodRuntimePolicy.js';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import {
    ED25519_PUBLIC_KEY_BYTES,
    ED25519_SECRET_KEY_BYTES,
    ED25519_SIGNATURE_BYTES,
    signEd25519Message,
    verifyEd25519Signature,
} from '../../crypto/ed25519.js';
import { MachineReplacementReasonSchema } from './machineReplacement.js';
import { MachineLiveStreamSourceAdmissionBindingV1Schema, type MachineLiveStreamSourceAdmissionBindingV1 } from '../peer/mediation/stream/sourceAdmissionV1.js';
import { MachineInstallationPublicKeySchema, MachineInstallationPrivateKeySchema,
    MachineInstallationProofV1Schema, type MachineInstallationProofV1, validateBase64UrlEncodedBytes } from './installationKeySchemas.js';
export { MachineInstallationPublicKeySchema, MachineInstallationPrivateKeySchema, MachineInstallationProofSignatureSchema,
    MachineInstallationProofV1Schema, type MachineInstallationProofV1,
    MachineInstallationPublicIdentityV1Schema, type MachineInstallationPublicIdentityV1 } from './installationKeySchemas.js';
import { SocketRpcMachineAdmissionContextV1Schema } from '../machineAccessV1.js';
import { ManagedActivityRpcRequestV1Schema } from '../managed/managedIntentV1.js';
import { SessionActionRpcOriginV1Schema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncSourceExecutionV1Schema, WorkspaceSyncSeedRoutingV1Schema } from '../../rpc/socket.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { readDeploymentArchiveRpcEffectV1 } from '../../deployments/deploymentArchiveRpcV1.js';
import { deploymentOperationForRootActionV1, deploymentChildEffectActionIdForRootV1 } from '../../deployments/deploymentActionIdsV1.js';
import { isSessionStopChildRootV1, isSessionStopChildV1 } from '../../actions/sessionSectionArchive.js';
import { isMachineSetupPlanRpcChildV1 } from '../managed/actionsV1.js';
import { readSessionAgentReadinessChildActionV1 } from '../managed/actionIdsV1.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { ExternalActionActionIdV1Schema, ExternalActionRequestIdV1Schema, ExternalActionWorkflowOriginV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '../../actions/externalActionApi.js';
import {
    ContentPublicKeyFingerprintSchema,
    computeContentPublicKeyFingerprint,
} from './contentPublicKeyFingerprint.js';
export {
    ContentPublicKeyFingerprintSchema,
    computeContentPublicKeyFingerprint,
    type ContentPublicKeyFingerprint,
} from './contentPublicKeyFingerprint.js';
export const MachineInstallationIdentityV1Schema = lazyZodSchema(() => z.object({
    version: z.literal(1),
    installationId: z.string().check(z.trim(), z.minLength(1)),
    createdAt: z.number().check(z.int(), z.nonnegative()),
    publicKey: MachineInstallationPublicKeySchema,
    privateKey: z.string().check(z.trim(), z.minLength(1)),
}).check(z.superRefine((identity, ctx) => {
    validateBase64UrlEncodedBytes(identity.privateKey, 'privateKey', ED25519_SECRET_KEY_BYTES, ctx, ['privateKey']);
})));

export type MachineInstallationIdentityV1 = z.infer<typeof MachineInstallationIdentityV1Schema>;

export const RequesterSessionCurrentnessPurposeV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('requester_session_currentness'),
    sessionId: z.string().check(z.minLength(1)),
}));
export type RequesterSessionCurrentnessPurposeV1 = z.infer<typeof RequesterSessionCurrentnessPurposeV1Schema>;

/** Named declaration boundary; runtime validation below remains the complete strict proof grammar. */
export interface MachineInstallationProofPayloadV1 {
    version: 1;
    installationId: string;
    machineId: string;
    replacesMachineId?: string;
    replacementReason?: z.infer<typeof MachineReplacementReasonSchema>;
    contentPublicKeyFingerprint?: z.infer<typeof ContentPublicKeyFingerprintSchema>;
    accountId?: string;
    liveStreamSourceAdmission?: MachineLiveStreamSourceAdmissionBindingV1;
    nativeCredentialBindingRead?: { requestBodyDigest: string };
    deploymentSecretLaunch?: { requestBodyDigest: string };
    deploymentTransition?: {
        serverId: string; environmentId: string; deploymentId: string; actionOperationId: string;
        expectedRevision: number; requestBodyDigest: string;
    };
    deploymentDomainTransition?: {
        serverId: string; environmentId: string; domainId: string; actionOperationId: string;
        expectedRevision: number; requestBodyDigest: string;
    };
    sessionCreation?: { sourceExecutionDigest: string; requestBodyDigest: string };
    externalActionOrigin?: {
        homeId: string; actionId: z.infer<typeof ExternalActionActionIdV1Schema>; requestId: string;
        requestEnvelopeDigest: string;
        origin: z.infer<typeof SessionActionRpcOriginV1Schema> | z.infer<typeof ExternalActionWorkflowOriginV1Schema>;
    };
    rpcAdmission?: {
        context: z.infer<typeof SocketRpcMachineAdmissionContextV1Schema>;
        method?: string;
        purpose?: RequesterSessionCurrentnessPurposeV1;
        workspaceSyncSourceRouting?: z.infer<typeof WorkspaceSyncSourceRoutingV1Schema>;
        workspaceSyncTargetRouting?: z.infer<typeof WorkspaceSyncTargetRoutingV1Schema>;
        workspaceSyncSourceWriterTargetRouting?: z.infer<typeof WorkspaceSyncSourceWriterTargetRoutingV1Schema>;
        workspaceSyncSourceExecution?: z.infer<typeof WorkspaceSyncSourceExecutionV1Schema>;
        workspaceSyncSeedRouting?: z.infer<typeof WorkspaceSyncSeedRoutingV1Schema>;
        callerInputAuthorization?: z.infer<typeof ExternalActionExecutionAuthorizationV1Schema>;
        custodySubjectAccountId?: string;
        managedTarget?: z.infer<typeof ManagedActivityRpcRequestV1Schema>;
        managedIdleDecision?: { kind: 'idle'; since: number; confirmedAt: number };
    };
    managedPolicy?: {
        homeId: string; managedId: string; expectedIntentRevision: number;
        controller: { machineId: string; installationId: string };
        requestId: string; purpose: 'retention' | 'accepted-input-start' | 'creation-cleanup';
        resourceDigest: string; purposeDigest: string; method: 'POST'; path: string; bodyDigest: string;
    };
    managedPolicyCensus?: { homeId: string };
}

export const MachineInstallationProofPayloadV1Schema: z.ZodMiniType<MachineInstallationProofPayloadV1> = lazyZodSchema(() => z.strictObject({
    version: z.literal(1),
    installationId: z.string().check(z.trim(), z.minLength(1)),
    machineId: z.string().check(z.trim(), z.minLength(1)),
    replacesMachineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    replacementReason: z.optional(MachineReplacementReasonSchema),
    contentPublicKeyFingerprint: z.optional(ContentPublicKeyFingerprintSchema),
    accountId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    liveStreamSourceAdmission: z.optional(MachineLiveStreamSourceAdmissionBindingV1Schema),
    nativeCredentialBindingRead: z.optional(z.strictObject({
        requestBodyDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    })),
    deploymentSecretLaunch: z.optional(z.strictObject({
        requestBodyDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    })),
    deploymentTransition: z.optional(z.strictObject({
        serverId: ActionOperationIdentifierV1Schema,
        environmentId: ActionOperationIdentifierV1Schema,
        deploymentId: ActionOperationIdentifierV1Schema,
        actionOperationId: ActionOperationIdentifierV1Schema,
        expectedRevision: z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)),
        requestBodyDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    })),
    deploymentDomainTransition: z.optional(z.strictObject({
        serverId: ActionOperationIdentifierV1Schema, environmentId: ActionOperationIdentifierV1Schema,
        domainId: ActionOperationIdentifierV1Schema, actionOperationId: ActionOperationIdentifierV1Schema,
        expectedRevision: z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)),
        requestBodyDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    })),
    sessionCreation: z.optional(z.strictObject({
        sourceExecutionDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
        requestBodyDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    })),
    externalActionOrigin: z.optional(z.strictObject({
        homeId: z.string().check(z.trim(), z.minLength(1)),
        actionId: ExternalActionActionIdV1Schema,
        requestId: ExternalActionRequestIdV1Schema,
        requestEnvelopeDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
        origin: z.union([SessionActionRpcOriginV1Schema, ExternalActionWorkflowOriginV1Schema]),
    })),
    rpcAdmission: z.optional(z.strictObject({
        context: SocketRpcMachineAdmissionContextV1Schema,
        method: z.optional(z.string().check(z.minLength(1))),
        purpose: z.optional(RequesterSessionCurrentnessPurposeV1Schema),
        workspaceSyncSourceRouting: z.optional(WorkspaceSyncSourceRoutingV1Schema),
        workspaceSyncTargetRouting: z.optional(WorkspaceSyncTargetRoutingV1Schema),
        workspaceSyncSourceWriterTargetRouting: z.optional(WorkspaceSyncSourceWriterTargetRoutingV1Schema),
        workspaceSyncSourceExecution: z.optional(WorkspaceSyncSourceExecutionV1Schema),
        workspaceSyncSeedRouting: z.optional(WorkspaceSyncSeedRoutingV1Schema),
        callerInputAuthorization: z.optional(ExternalActionExecutionAuthorizationV1Schema),
        custodySubjectAccountId: z.optional(z.string().check(z.minLength(1))),
        managedTarget: z.optional(z.lazy(() => ManagedActivityRpcRequestV1Schema)),
        managedIdleDecision: z.optional(z.strictObject({ kind: z.literal('idle'), since: z.number().check(z.nonnegative()), confirmedAt: z.number().check(z.nonnegative()) })),
    }).check(z.superRefine((admission, ctx) => {
        if ((admission.method === undefined) === (admission.purpose === undefined)) {
            ctx.addIssue({ code: 'custom', message: 'Machine admission must bind exactly one method or currentness purpose' });
        }
        if (admission.purpose && (admission.workspaceSyncSourceRouting || admission.workspaceSyncTargetRouting
            || admission.workspaceSyncSourceWriterTargetRouting || admission.workspaceSyncSourceExecution || admission.workspaceSyncSeedRouting || admission.callerInputAuthorization
            || admission.custodySubjectAccountId || admission.managedTarget || admission.managedIdleDecision)) {
            ctx.addIssue({ code: 'custom', message: 'Requester Session currentness cannot authorize another Machine purpose' });
        }
        const deployment = admission.workspaceSyncSourceExecution?.externalActionExecution.deploymentChildRouting;
        const archiveExecution = admission.workspaceSyncSourceExecution?.externalActionExecution;
        const archiveProof = archiveExecution?.deploymentChildExecution;
        const archiveRouting = archiveProof?.externalActionExecution.deploymentChildRouting;
        const deploymentArchive = archiveExecution !== undefined && archiveProof?.archiveOrigin !== undefined && archiveRouting !== undefined
            && (archiveRouting.kind === 'build' || archiveRouting.kind === 'member' && archiveRouting.phase !== 'cleanup')
            && admission.callerInputAuthorization !== undefined && admission.method !== undefined
            && admission.method.startsWith(`${admission.context.machineId}:`)
            && admission.workspaceSyncSourceExecution?.method === admission.method
            && readDeploymentArchiveRpcEffectV1(admission.method.slice(admission.method.indexOf(':') + 1)) === archiveExecution.effectActionId
            && archiveExecution.installationId === archiveRouting.installationId
            && archiveRouting.actionId === `deployments.${deploymentOperationForRootActionV1(admission.callerInputAuthorization.binding.actionId,
                admission.callerInputAuthorization.binding.deploymentPreparationAdmission)}`
            && archiveExecution.authorization.token === admission.callerInputAuthorization.token
            && archiveProof.externalActionExecution.authorization.token === admission.callerInputAuthorization.token
            && createCanonicalJsonSigningInput(archiveExecution.authorization.binding) === createCanonicalJsonSigningInput(admission.callerInputAuthorization.binding)
            && createCanonicalJsonSigningInput(archiveProof.externalActionExecution.authorization.binding) === createCanonicalJsonSigningInput(admission.callerInputAuthorization.binding);
        const deploymentChild = deployment !== undefined && admission.callerInputAuthorization !== undefined
            && admission.method === `${admission.context.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`
            && admission.workspaceSyncSourceExecution?.method === admission.method
            && deployment.machineId === admission.context.machineId && deployment.installationId === admission.context.installationId
            && deployment.actionId === deploymentChildEffectActionIdForRootV1(admission.callerInputAuthorization.binding.actionId,
                admission.callerInputAuthorization.binding.deploymentPreparationAdmission, deployment.actionId)
            && admission.workspaceSyncSourceExecution.externalActionExecution.effectActionId === deployment.actionId
            && admission.workspaceSyncSourceExecution.externalActionExecution.authorization.token === admission.callerInputAuthorization.token
            && createCanonicalJsonSigningInput(admission.workspaceSyncSourceExecution.externalActionExecution.authorization.binding)
                === createCanonicalJsonSigningInput(admission.callerInputAuthorization.binding);
        const readinessExecution = admission.workspaceSyncSourceExecution?.externalActionExecution;
        const readinessChild = readinessExecution !== undefined && admission.callerInputAuthorization !== undefined
            && admission.method === admission.workspaceSyncSourceExecution?.method
            && admission.method?.startsWith(`${admission.context.machineId}:`)
            && readSessionAgentReadinessChildActionV1(admission.callerInputAuthorization.binding,
                readinessExecution.reviewedChild, admission.context) === readinessExecution.effectActionId
            && readinessExecution.authorization.token === admission.callerInputAuthorization.token
            && createCanonicalJsonSigningInput(readinessExecution.authorization.binding)
                === createCanonicalJsonSigningInput(admission.callerInputAuthorization.binding);
        const moveChild = (deploymentChild || readinessChild || admission.callerInputAuthorization?.binding.actionId === 'projects.service.relocate'
            || admission.context.role === 'manage' && admission.workspaceSyncSourceExecution
                && admission.method === `${admission.context.machineId}:${RPC_METHODS.MACHINE_SETUP_PLAN}`
                && isMachineSetupPlanRpcChildV1({ rootActionId: admission.callerInputAuthorization?.binding.actionId,
                    effectActionId: admission.workspaceSyncSourceExecution.externalActionExecution.effectActionId,
                    method: RPC_METHODS.MACHINE_SETUP_PLAN })
            || admission.callerInputAuthorization?.binding.actionId === 'discussion.second_opinion.start'
                && admission.workspaceSyncSourceExecution?.externalActionExecution.effectActionId === 'session.spawn_new'
                && (admission.method?.endsWith(`:${RPC_METHODS.SESSION_SPAWN_NEW}`)
                    || admission.method?.endsWith(`:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`))
            || isSessionStopChildRootV1(admission.callerInputAuthorization?.binding.actionId)
                && admission.workspaceSyncSourceExecution
                && admission.method === `${admission.context.machineId}:${RPC_METHODS.STOP_SESSION}`
                && admission.workspaceSyncSourceExecution.method === admission.method
                && isSessionStopChildV1({ rootActionId: admission.callerInputAuthorization.binding.actionId,
                    effectActionId: admission.workspaceSyncSourceExecution.externalActionExecution.effectActionId,
                    method: RPC_METHODS.STOP_SESSION, target: admission.workspaceSyncSourceExecution.externalActionExecution.target,
                    params: admission.workspaceSyncSourceExecution.params,
                    ...(admission.workspaceSyncSourceExecution.originalActionEnvelope?.v === 1
                        ? { rootInput: admission.workspaceSyncSourceExecution.originalActionEnvelope.input } : {}),
                }))
            && admission.workspaceSyncSourceExecution?.originalActionEnvelope !== undefined;
        if (admission.callerInputAuthorization && !moveChild && !deploymentArchive && !admission.workspaceSyncSourceRouting
            && !admission.workspaceSyncTargetRouting && !admission.workspaceSyncSourceWriterTargetRouting && !admission.workspaceSyncSeedRouting) {
            ctx.addIssue({ code: 'custom', message: 'Retained handoff authorization requires an exact workspace purpose' });
        }
        if (admission.workspaceSyncSourceExecution && !moveChild && !deploymentArchive && !admission.workspaceSyncSourceRouting
            && !admission.workspaceSyncSourceWriterTargetRouting && !admission.workspaceSyncSeedRouting) {
            ctx.addIssue({ code: 'custom', message: 'Retained source execution requires an exact source workspace purpose' });
        }
        if (admission.workspaceSyncSeedRouting && (!admission.method?.endsWith(`:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`)
            || !admission.callerInputAuthorization
            || (isWorkspaceSyncRelationshipWriteActionId(admission.callerInputAuthorization.binding.actionId)
                ? admission.workspaceSyncSourceExecution !== undefined : !admission.workspaceSyncSourceExecution)
            || admission.workspaceSyncSourceRouting || admission.workspaceSyncTargetRouting || admission.workspaceSyncSourceWriterTargetRouting
            || admission.custodySubjectAccountId || admission.managedTarget || admission.managedIdleDecision)) {
            ctx.addIssue({ code: 'custom', message: 'Seed preparation requires only its exact admitted workspace proof' });
        }
    }))),
    managedPolicy: z.optional(z.strictObject({
        homeId: z.string().check(z.minLength(1)), managedId: z.string().check(z.minLength(1)), expectedIntentRevision: z.number().check(z.int(), z.nonnegative()),
        controller: z.strictObject({ machineId: z.string().check(z.minLength(1)), installationId: z.string().check(z.minLength(1)) }),
        requestId: z.string().check(z.minLength(1)), purpose: z.enum(['retention', 'accepted-input-start', 'creation-cleanup']),
        resourceDigest: z.string().check(z.minLength(1)), purposeDigest: z.string().check(z.minLength(1)),
        method: z.literal('POST'), path: z.string().check(z.minLength(1)), bodyDigest: z.string().check(z.minLength(1)),
    })),
    managedPolicyCensus: z.optional(z.strictObject({ homeId: z.string().check(z.minLength(1)) })),
}).check(z.superRefine((value, ctx) => {
    if (value.liveStreamSourceAdmission && (!value.accountId || value.nativeCredentialBindingRead || value.deploymentSecretLaunch
        || value.deploymentTransition || value.deploymentDomainTransition || value.sessionCreation || value.externalActionOrigin
        || value.rpcAdmission || value.managedPolicy || value.managedPolicyCensus || value.replacesMachineId
        || value.replacementReason || value.contentPublicKeyFingerprint)) {
        ctx.addIssue({ code: 'custom', message: 'Personal source admission binds only its exact installed Computer source' });
    }
    if (value.deploymentDomainTransition && (!value.accountId || value.nativeCredentialBindingRead || value.deploymentSecretLaunch
        || value.deploymentTransition || value.sessionCreation || value.externalActionOrigin || value.rpcAdmission
        || value.managedPolicy || value.managedPolicyCensus || value.replacesMachineId || value.replacementReason
        || value.contentPublicKeyFingerprint)) {
        ctx.addIssue({ code: 'custom', message: 'Domain transition proof binds only its exact installed operation and material' });
    }
    if (value.nativeCredentialBindingRead && (!value.accountId || value.deploymentSecretLaunch
        || value.deploymentTransition || value.sessionCreation || value.externalActionOrigin || value.rpcAdmission
        || value.managedPolicy || value.managedPolicyCensus
        || value.replacesMachineId || value.replacementReason || value.contentPublicKeyFingerprint)) {
        ctx.addIssue({ code: 'custom', message: 'Native credential binding read must bind only its exact installed requester and body' });
    }
    if (value.deploymentSecretLaunch && (!value.accountId || value.deploymentTransition || value.sessionCreation
        || value.externalActionOrigin || value.rpcAdmission || value.managedPolicy || value.managedPolicyCensus
        || value.replacesMachineId || value.replacementReason || value.contentPublicKeyFingerprint)) {
        ctx.addIssue({ code: 'custom', message: 'Environment grant read proof must bind only its exact installed receiver and body' });
    }
    if (value.sessionCreation && (!value.accountId || value.deploymentSecretLaunch || value.deploymentTransition || value.externalActionOrigin || value.rpcAdmission
        || value.managedPolicy || value.managedPolicyCensus || value.replacesMachineId || value.replacementReason
        || value.contentPublicKeyFingerprint)) {
        ctx.addIssue({ code: 'custom', message: 'Session birth proof must bind only its exact native body and source' });
    }
    if (value.deploymentTransition && (!value.accountId || value.deploymentSecretLaunch || value.sessionCreation || value.externalActionOrigin || value.rpcAdmission
        || value.managedPolicy || value.managedPolicyCensus || value.replacesMachineId || value.replacementReason
        || value.contentPublicKeyFingerprint)) {
        ctx.addIssue({ code: 'custom', message: 'Deployment transition proof must bind only its exact installed operation and body' });
    }
    if (!value.externalActionOrigin) return;
    if (!value.accountId) ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'Session Action origin requires the authenticated requester' });
    if (value.externalActionOrigin.requestId !== value.externalActionOrigin.origin.requestId) {
        ctx.addIssue({ code: 'custom', path: ['externalActionOrigin', 'requestId'], message: 'Session Action origin must match the admitted request' });
    }
})));

function encodeUtf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function normalizeProofPayload(
    payload: MachineInstallationProofPayloadV1,
): MachineInstallationProofPayloadV1 {
    return MachineInstallationProofPayloadV1Schema.parse(payload);
}

export function buildMachineInstallationProofPayloadBytes(
    payload: MachineInstallationProofPayloadV1,
): Uint8Array {
    const normalized = normalizeProofPayload(payload);
    return encodeUtf8(JSON.stringify({
        version: normalized.version,
        installationId: normalized.installationId,
        machineId: normalized.machineId,
        ...(normalized.replacesMachineId ? { replacesMachineId: normalized.replacesMachineId } : null),
        ...(normalized.replacementReason ? { replacementReason: normalized.replacementReason } : null),
        ...(normalized.contentPublicKeyFingerprint
            ? { contentPublicKeyFingerprint: normalized.contentPublicKeyFingerprint }
            : null),
        ...(normalized.accountId ? { accountId: normalized.accountId } : null),
        ...(normalized.liveStreamSourceAdmission ? { liveStreamSourceAdmission: normalized.liveStreamSourceAdmission } : {}),
        ...(normalized.nativeCredentialBindingRead ? { nativeCredentialBindingRead: {
            requestBodyDigest: normalized.nativeCredentialBindingRead.requestBodyDigest,
        } } : {}),
        ...(normalized.deploymentSecretLaunch ? { deploymentSecretLaunch: {
            requestBodyDigest: normalized.deploymentSecretLaunch.requestBodyDigest,
        } } : {}),
        ...(normalized.deploymentTransition ? { deploymentTransition: {
            serverId: normalized.deploymentTransition.serverId,
            environmentId: normalized.deploymentTransition.environmentId,
            deploymentId: normalized.deploymentTransition.deploymentId,
            actionOperationId: normalized.deploymentTransition.actionOperationId,
            expectedRevision: normalized.deploymentTransition.expectedRevision,
            requestBodyDigest: normalized.deploymentTransition.requestBodyDigest,
        } } : {}),
        ...(normalized.deploymentDomainTransition ? { deploymentDomainTransition: {
            serverId: normalized.deploymentDomainTransition.serverId,
            environmentId: normalized.deploymentDomainTransition.environmentId,
            domainId: normalized.deploymentDomainTransition.domainId,
            actionOperationId: normalized.deploymentDomainTransition.actionOperationId,
            expectedRevision: normalized.deploymentDomainTransition.expectedRevision,
            requestBodyDigest: normalized.deploymentDomainTransition.requestBodyDigest,
        } } : {}),
        ...(normalized.sessionCreation ? { sessionCreation: {
            sourceExecutionDigest: normalized.sessionCreation.sourceExecutionDigest,
            requestBodyDigest: normalized.sessionCreation.requestBodyDigest,
        } } : {}),
        ...(normalized.externalActionOrigin ? { externalActionOrigin: {
            homeId: normalized.externalActionOrigin.homeId,
            actionId: normalized.externalActionOrigin.actionId,
            requestId: normalized.externalActionOrigin.requestId,
            requestEnvelopeDigest: normalized.externalActionOrigin.requestEnvelopeDigest,
            origin: normalized.externalActionOrigin.origin,
        } } : {}),
        ...(normalized.rpcAdmission ? {
            rpcAdmission: {
                context: {
                    actorAccountId: normalized.rpcAdmission.context.actorAccountId,
                    custodianAccountId: normalized.rpcAdmission.context.custodianAccountId,
                    machineId: normalized.rpcAdmission.context.machineId,
                    installationId: normalized.rpcAdmission.context.installationId,
                    role: normalized.rpcAdmission.context.role,
                    encryptionMode: normalized.rpcAdmission.context.encryptionMode,
                },
                method: normalized.rpcAdmission.method,
                ...(normalized.rpcAdmission.purpose ? { purpose: normalized.rpcAdmission.purpose } : {}),
                ...(normalized.rpcAdmission.workspaceSyncSourceRouting ? {
                    workspaceSyncSourceRouting: normalized.rpcAdmission.workspaceSyncSourceRouting,
                } : {}),
                ...(normalized.rpcAdmission.workspaceSyncTargetRouting ? {
                    workspaceSyncTargetRouting: normalized.rpcAdmission.workspaceSyncTargetRouting,
                } : {}),
                ...(normalized.rpcAdmission.workspaceSyncSourceWriterTargetRouting ? {
                    workspaceSyncSourceWriterTargetRouting: normalized.rpcAdmission.workspaceSyncSourceWriterTargetRouting,
                } : {}),
                ...(normalized.rpcAdmission.workspaceSyncSourceExecution ? {
                    workspaceSyncSourceExecution: normalized.rpcAdmission.workspaceSyncSourceExecution,
                } : {}),
                ...(normalized.rpcAdmission.workspaceSyncSeedRouting ? {
                    workspaceSyncSeedRouting: normalized.rpcAdmission.workspaceSyncSeedRouting,
                } : {}),
                ...(normalized.rpcAdmission.callerInputAuthorization ? {
                    callerInputAuthorization: normalized.rpcAdmission.callerInputAuthorization,
                } : {}),
                ...(normalized.rpcAdmission.custodySubjectAccountId ? {
                    custodySubjectAccountId: normalized.rpcAdmission.custodySubjectAccountId,
                } : {}),
                ...(normalized.rpcAdmission.managedTarget ? {
                    managedTarget: {
                        homeId: normalized.rpcAdmission.managedTarget.homeId,
                        managedId: normalized.rpcAdmission.managedTarget.managedId,
                        expectedRevision: normalized.rpcAdmission.managedTarget.expectedRevision,
                        ...(normalized.rpcAdmission.managedTarget.controller ? { controller: {
                            machineId: normalized.rpcAdmission.managedTarget.controller.machineId,
                            installationId: normalized.rpcAdmission.managedTarget.controller.installationId,
                        } } : {}),
                        ...('action' in normalized.rpcAdmission.managedTarget ? { action: normalized.rpcAdmission.managedTarget.action } : {}),
                    },
                } : {}),
                ...(normalized.rpcAdmission.managedIdleDecision ? {
                    managedIdleDecision: { kind: normalized.rpcAdmission.managedIdleDecision.kind,
                        since: normalized.rpcAdmission.managedIdleDecision.since, confirmedAt: normalized.rpcAdmission.managedIdleDecision.confirmedAt },
                } : {}),
            },
        } : null),
        ...(normalized.managedPolicy ? { managedPolicy: {
            homeId: normalized.managedPolicy.homeId, managedId: normalized.managedPolicy.managedId,
            expectedIntentRevision: normalized.managedPolicy.expectedIntentRevision,
            controller: { machineId: normalized.managedPolicy.controller.machineId, installationId: normalized.managedPolicy.controller.installationId },
            requestId: normalized.managedPolicy.requestId, purpose: normalized.managedPolicy.purpose,
            resourceDigest: normalized.managedPolicy.resourceDigest, purposeDigest: normalized.managedPolicy.purposeDigest,
            method: normalized.managedPolicy.method, path: normalized.managedPolicy.path, bodyDigest: normalized.managedPolicy.bodyDigest,
        } } : {}),
        ...(normalized.managedPolicyCensus ? { managedPolicyCensus: { homeId: normalized.managedPolicyCensus.homeId } } : {}),
    }));
}

export function signMachineInstallationProof(params: Readonly<{
    payload: MachineInstallationProofPayloadV1;
    privateKey: string | Uint8Array;
}>): MachineInstallationProofV1 {
    const privateKeyBytes = typeof params.privateKey === 'string'
        ? decodeBase64(MachineInstallationPrivateKeySchema.parse(params.privateKey), 'base64url')
        : params.privateKey;
    if (privateKeyBytes.length !== ED25519_SECRET_KEY_BYTES) {
        throw new Error(`Invalid installation private key length: expected ${ED25519_SECRET_KEY_BYTES} bytes`);
    }
    const signature = signEd25519Message(
        buildMachineInstallationProofPayloadBytes(params.payload),
        privateKeyBytes,
    );
    return {
        version: 1,
        algorithm: 'ed25519',
        signature: encodeBase64(signature, 'base64url'),
    };
}

export function verifyMachineInstallationProof(params: Readonly<{
    payload: MachineInstallationProofPayloadV1;
    proof: MachineInstallationProofV1;
    publicKey: string | Uint8Array;
}>): boolean {
    const proof = MachineInstallationProofV1Schema.safeParse(params.proof);
    if (!proof.success) return false;

    let publicKeyBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    try {
        publicKeyBytes = typeof params.publicKey === 'string'
            ? decodeBase64(MachineInstallationPublicKeySchema.parse(params.publicKey), 'base64url')
            : params.publicKey;
        signatureBytes = decodeBase64(proof.data.signature, 'base64url');
    } catch {
        return false;
    }

    if (publicKeyBytes.length !== ED25519_PUBLIC_KEY_BYTES) return false;
    if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) return false;

    try {
        return verifyEd25519Signature(
            buildMachineInstallationProofPayloadBytes(params.payload),
            signatureBytes,
            publicKeyBytes,
        );
    } catch {
        return false;
    }
}
