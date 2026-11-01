import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import {
    ED25519_PUBLIC_KEY_BYTES,
    ED25519_SECRET_KEY_BYTES,
    ED25519_SIGNATURE_BYTES,
    signEd25519Message,
    verifyEd25519Signature,
} from '../../crypto/ed25519.js';
import { MachineReplacementReasonSchema } from './machineReplacement.js';
import { MachineInstallationPublicKeySchema, MachineInstallationPrivateKeySchema, MachineInstallationProofSignatureSchema,
    validateBase64UrlEncodedBytes } from './installationKeySchemas.js';
export { MachineInstallationPublicKeySchema, MachineInstallationPrivateKeySchema, MachineInstallationProofSignatureSchema,
    MachineInstallationPublicIdentityV1Schema, type MachineInstallationPublicIdentityV1 } from './installationKeySchemas.js';
import { SocketRpcMachineAdmissionContextV1Schema } from '../machineAccessV1.js';
import { ManagedActivityReadRequestV1Schema } from '../managed/managedIntentV1.js';
import { SessionActionRpcOriginV1Schema, SessionPermissionDecisionAuthenticationV1Schema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncSourceExecutionV1Schema, WorkspaceSyncSeedRoutingV1Schema } from '../../rpc/socket.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { SessionPermissionAccountUserDecisionActorV1Schema } from '../../sessions/permissions/v1.js';
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

/** Existing Session decision actor, rechecked by the original installed executor. */
export const SessionApprovalDecisionCurrentnessV1Schema = lazyZodSchema(() => z.strictObject({
    sessionId: z.string().check(z.minLength(1)),
    actor: SessionPermissionAccountUserDecisionActorV1Schema,
    authentication: SessionPermissionDecisionAuthenticationV1Schema,
}));
export type SessionApprovalDecisionCurrentnessV1 = z.infer<typeof SessionApprovalDecisionCurrentnessV1Schema>;

export const MachineInstallationProofPayloadV1Schema = lazyZodSchema(() => z.strictObject({
    version: z.literal(1),
    installationId: z.string().check(z.trim(), z.minLength(1)),
    machineId: z.string().check(z.trim(), z.minLength(1)),
    replacesMachineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    replacementReason: z.optional(MachineReplacementReasonSchema),
    contentPublicKeyFingerprint: z.optional(ContentPublicKeyFingerprintSchema),
    accountId: z.optional(z.string().check(z.trim(), z.minLength(1))),
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
        sessionDecision: z.optional(SessionApprovalDecisionCurrentnessV1Schema),
        workspaceSyncSourceRouting: z.optional(WorkspaceSyncSourceRoutingV1Schema),
        workspaceSyncTargetRouting: z.optional(WorkspaceSyncTargetRoutingV1Schema),
        workspaceSyncSourceWriterTargetRouting: z.optional(WorkspaceSyncSourceWriterTargetRoutingV1Schema),
        workspaceSyncSourceExecution: z.optional(WorkspaceSyncSourceExecutionV1Schema),
        workspaceSyncSeedRouting: z.optional(WorkspaceSyncSeedRoutingV1Schema),
        callerInputAuthorization: z.optional(ExternalActionExecutionAuthorizationV1Schema),
        custodySubjectAccountId: z.optional(z.string().check(z.minLength(1))),
        managedTarget: z.optional(z.lazy(() => ManagedActivityReadRequestV1Schema)),
        managedIdleDecision: z.optional(z.strictObject({ kind: z.literal('idle'), since: z.number().check(z.nonnegative()), confirmedAt: z.number().check(z.nonnegative()) })),
    }).check(z.superRefine((admission, ctx) => {
        if (admission.sessionDecision && (admission.method !== `${admission.sessionDecision.sessionId}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`
            || admission.purpose || admission.custodySubjectAccountId || admission.workspaceSyncSourceRouting
            || admission.workspaceSyncTargetRouting || admission.workspaceSyncSourceWriterTargetRouting || admission.workspaceSyncSourceExecution
            || admission.workspaceSyncSeedRouting || admission.callerInputAuthorization || admission.managedTarget || admission.managedIdleDecision)) {
            ctx.addIssue({ code: 'custom', message: 'Session approval currentness must bind only the exact decision' });
        }
        if ((admission.method === undefined) === (admission.purpose === undefined)) {
            ctx.addIssue({ code: 'custom', message: 'Machine admission must bind exactly one method or currentness purpose' });
        }
        if (admission.purpose && (admission.workspaceSyncSourceRouting || admission.workspaceSyncTargetRouting
            || admission.workspaceSyncSourceWriterTargetRouting || admission.workspaceSyncSourceExecution || admission.workspaceSyncSeedRouting || admission.callerInputAuthorization
            || admission.custodySubjectAccountId || admission.managedTarget || admission.managedIdleDecision)) {
            ctx.addIssue({ code: 'custom', message: 'Requester Session currentness cannot authorize another Machine purpose' });
        }
        const moveChild = (admission.callerInputAuthorization?.binding.actionId === 'projects.service.relocate'
            || admission.callerInputAuthorization?.binding.actionId === 'discussion.second_opinion.start'
                && admission.workspaceSyncSourceExecution?.externalActionExecution.effectActionId === 'session.spawn_new'
                && (admission.method?.endsWith(`:${RPC_METHODS.SESSION_SPAWN_NEW}`)
                    || admission.method?.endsWith(`:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`)))
            && admission.workspaceSyncSourceExecution?.originalActionEnvelope !== undefined;
        if (admission.callerInputAuthorization && !moveChild && !admission.workspaceSyncSourceRouting
            && !admission.workspaceSyncTargetRouting && !admission.workspaceSyncSourceWriterTargetRouting && !admission.workspaceSyncSeedRouting) {
            ctx.addIssue({ code: 'custom', message: 'Retained handoff authorization requires an exact workspace purpose' });
        }
        if (admission.workspaceSyncSourceExecution && !moveChild && !admission.workspaceSyncSourceRouting
            && !admission.workspaceSyncSourceWriterTargetRouting && !admission.workspaceSyncSeedRouting) {
            ctx.addIssue({ code: 'custom', message: 'Retained source execution requires an exact source workspace purpose' });
        }
        if (admission.workspaceSyncSeedRouting && (!admission.method?.endsWith(`:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`)
            || !admission.callerInputAuthorization || !admission.workspaceSyncSourceExecution
            || admission.workspaceSyncSourceRouting || admission.workspaceSyncTargetRouting || admission.workspaceSyncSourceWriterTargetRouting
            || admission.custodySubjectAccountId || admission.managedTarget || admission.managedIdleDecision)) {
            ctx.addIssue({ code: 'custom', message: 'Seed preparation requires only its exact retained Project proof' });
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
    if (value.sessionCreation && (!value.accountId || value.externalActionOrigin || value.rpcAdmission
        || value.managedPolicy || value.managedPolicyCensus || value.replacesMachineId || value.replacementReason
        || value.contentPublicKeyFingerprint)) {
        ctx.addIssue({ code: 'custom', message: 'Session birth proof must bind only its exact native body and source' });
    }
    if (!value.externalActionOrigin) return;
    if (!value.accountId) ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'Session Action origin requires the authenticated requester' });
    if (value.externalActionOrigin.requestId !== value.externalActionOrigin.origin.requestId) {
        ctx.addIssue({ code: 'custom', path: ['externalActionOrigin', 'requestId'], message: 'Session Action origin must match the admitted request' });
    }
})));

export type MachineInstallationProofPayloadV1 = z.infer<typeof MachineInstallationProofPayloadV1Schema>;

export const MachineInstallationProofV1Schema = lazyZodSchema(() => z.object({
    version: z.literal(1),
    algorithm: z.literal('ed25519'),
    signature: MachineInstallationProofSignatureSchema,
}));

export type MachineInstallationProofV1 = z.infer<typeof MachineInstallationProofV1Schema>;

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
                ...(normalized.rpcAdmission.sessionDecision ? { sessionDecision: normalized.rpcAdmission.sessionDecision } : {}),
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
