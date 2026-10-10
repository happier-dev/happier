import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

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
import { SessionActionRpcOriginV1Schema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncSourceExecutionV1Schema, WorkspaceSyncSeedRoutingV1Schema } from '../../rpc/socket.js';
import { RPC_METHODS } from '../../rpc/methods.js';
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
    installationId: z.string().trim().min(1),
    createdAt: z.number().int().nonnegative(),
    publicKey: MachineInstallationPublicKeySchema,
    privateKey: z.string().trim().min(1),
}).superRefine((identity, ctx) => {
    validateBase64UrlEncodedBytes(identity.privateKey, 'privateKey', ED25519_SECRET_KEY_BYTES, ctx, ['privateKey']);
}));

export type MachineInstallationIdentityV1 = z.infer<typeof MachineInstallationIdentityV1Schema>;

export const RequesterSessionCurrentnessPurposeV1Schema = lazyZodSchema(() => z.object({
    kind: z.literal('requester_session_currentness'),
    sessionId: z.string().min(1),
}).strict());
export type RequesterSessionCurrentnessPurposeV1 = z.infer<typeof RequesterSessionCurrentnessPurposeV1Schema>;

export const MachineInstallationProofPayloadV1Schema = lazyZodSchema(() => z.object({
    version: z.literal(1),
    installationId: z.string().trim().min(1),
    machineId: z.string().trim().min(1),
    replacesMachineId: z.string().trim().min(1).optional(),
    replacementReason: MachineReplacementReasonSchema.optional(),
    contentPublicKeyFingerprint: ContentPublicKeyFingerprintSchema.optional(),
    accountId: z.string().trim().min(1).optional(),
    externalActionOrigin: z.object({
        homeId: z.string().trim().min(1),
        actionId: ExternalActionActionIdV1Schema,
        requestId: ExternalActionRequestIdV1Schema,
        requestEnvelopeDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        origin: z.union([SessionActionRpcOriginV1Schema, ExternalActionWorkflowOriginV1Schema]),
    }).strict().optional(),
    rpcAdmission: z.object({
        context: SocketRpcMachineAdmissionContextV1Schema,
        method: z.string().min(1).optional(),
        purpose: RequesterSessionCurrentnessPurposeV1Schema.optional(),
        workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.optional(),
        workspaceSyncTargetRouting: WorkspaceSyncTargetRoutingV1Schema.optional(),
        workspaceSyncSourceWriterTargetRouting: WorkspaceSyncSourceWriterTargetRoutingV1Schema.optional(),
        workspaceSyncSourceExecution: WorkspaceSyncSourceExecutionV1Schema.optional(),
        workspaceSyncSeedRouting: WorkspaceSyncSeedRoutingV1Schema.optional(),
        callerInputAuthorization: ExternalActionExecutionAuthorizationV1Schema.optional(),
        custodySubjectAccountId: z.string().min(1).optional(),
        managedTarget: z.lazy(() => ManagedActivityReadRequestV1Schema).optional(),
        managedIdleDecision: z.object({ kind: z.literal('idle'), since: z.number().nonnegative(), confirmedAt: z.number().nonnegative() }).strict().optional(),
    }).strict().superRefine((admission, ctx) => {
        if ((admission.method === undefined) === (admission.purpose === undefined)) {
            ctx.addIssue({ code: 'custom', message: 'Machine admission must bind exactly one method or currentness purpose' });
        }
        if (admission.purpose && (admission.workspaceSyncSourceRouting || admission.workspaceSyncTargetRouting
            || admission.workspaceSyncSourceWriterTargetRouting || admission.workspaceSyncSourceExecution || admission.workspaceSyncSeedRouting || admission.callerInputAuthorization
            || admission.custodySubjectAccountId || admission.managedTarget || admission.managedIdleDecision)) {
            ctx.addIssue({ code: 'custom', message: 'Requester Session currentness cannot authorize another Machine purpose' });
        }
        if (admission.callerInputAuthorization && !admission.workspaceSyncSourceRouting
            && !admission.workspaceSyncTargetRouting && !admission.workspaceSyncSourceWriterTargetRouting && !admission.workspaceSyncSeedRouting) {
            ctx.addIssue({ code: 'custom', message: 'Retained handoff authorization requires an exact workspace purpose' });
        }
        if (admission.workspaceSyncSourceExecution && !admission.workspaceSyncSourceRouting
            && !admission.workspaceSyncSourceWriterTargetRouting && !admission.workspaceSyncSeedRouting) {
            ctx.addIssue({ code: 'custom', message: 'Retained source execution requires an exact source workspace purpose' });
        }
        if (admission.workspaceSyncSeedRouting && (!admission.method?.endsWith(`:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`)
            || !admission.callerInputAuthorization || !admission.workspaceSyncSourceExecution
            || admission.workspaceSyncSourceRouting || admission.workspaceSyncTargetRouting || admission.workspaceSyncSourceWriterTargetRouting
            || admission.custodySubjectAccountId || admission.managedTarget || admission.managedIdleDecision)) {
            ctx.addIssue({ code: 'custom', message: 'Seed preparation requires only its exact retained Project proof' });
        }
    }).optional(),
    managedPolicy: z.object({
        homeId: z.string().min(1), managedId: z.string().min(1), expectedIntentRevision: z.number().int().nonnegative(),
        controller: z.object({ machineId: z.string().min(1), installationId: z.string().min(1) }).strict(),
        requestId: z.string().min(1), purpose: z.enum(['retention', 'accepted-input-start', 'creation-cleanup']),
        resourceDigest: z.string().min(1), purposeDigest: z.string().min(1),
        method: z.literal('POST'), path: z.string().min(1), bodyDigest: z.string().min(1),
    }).strict().optional(),
    managedPolicyCensus: z.object({ homeId: z.string().min(1) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
    if (!value.externalActionOrigin) return;
    if (!value.accountId) ctx.addIssue({ code: 'custom', path: ['accountId'], message: 'Session Action origin requires the authenticated requester' });
    if (value.externalActionOrigin.requestId !== value.externalActionOrigin.origin.requestId) {
        ctx.addIssue({ code: 'custom', path: ['externalActionOrigin', 'requestId'], message: 'Session Action origin must match the admitted request' });
    }
}));

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
                        controller: {
                            machineId: normalized.rpcAdmission.managedTarget.controller.machineId,
                            installationId: normalized.rpcAdmission.managedTarget.controller.installationId,
                        },
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
