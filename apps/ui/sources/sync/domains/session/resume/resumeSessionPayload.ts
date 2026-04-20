import { z } from 'zod';
import type { CodexBackendMode } from '@happier-dev/agents';
import {
    BackendTargetRefV2Schema,
    normalizeBackendTargetRefV2InputToV2,
    readBackendTargetRefV2,
    RuntimeDescriptorV1Schema,
    SessionAttachMetadataIdentityPolicySchema,
    SessionAuthoringValueV1Schema,
    type SessionAttachMetadataIdentityPolicy,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    type RuntimeDescriptorV1,
    type SessionAuthoringValueV1,
} from '@happier-dev/protocol';
import { isPermissionMode, type PermissionMode } from '../../permissions/permissionTypes';

import { buildCodexBackendTransportFields, type CodexBackendTransportFields } from '../codexBackendTransport';

export type ResumeHappySessionRpcParams = CodexBackendTransportFields & {
    type: 'resume-session';
    sessionId: string;
    directory: string;
    backendTarget: BackendTargetRefV2;
    resume?: string;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    environmentVariables?: Record<string, string>;
    connectedServices?: SessionAuthoringValueV1['connectedServices'];
    transcriptStorage?: 'direct' | 'persisted';
    attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy;
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    modelId?: string;
    modelUpdatedAt?: number;
};

type BuildResumeHappySessionRpcInput = Omit<ResumeHappySessionRpcParams, 'type' | 'backendTarget' | keyof CodexBackendTransportFields> & {
    backendTarget: BackendTargetRefV2Input;
    codexBackendMode?: CodexBackendMode;
    experimentalCodexAcp?: boolean;
};

const ResumeHappySessionRpcParamsSchema = z.object({
    type: z.literal('resume-session'),
    sessionId: z.string().min(1),
    directory: z.string().min(1),
    backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema),
    resume: z.string().min(1).optional(),
    runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    connectedServices: SessionAuthoringValueV1Schema.shape.connectedServices.optional(),
    transcriptStorage: z.enum(['direct', 'persisted']).optional(),
    attachMetadataIdentityPolicy: SessionAttachMetadataIdentityPolicySchema.optional(),
    permissionMode: z.string().refine((value) => isPermissionMode(value)).optional(),
    permissionModeUpdatedAt: z.number().optional(),
    modelId: z.string().min(1).optional(),
    modelUpdatedAt: z.number().optional(),
    experimentalCodexAcp: z.literal(true).optional(),
    codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
});

export function buildResumeHappySessionRpcParams(input: BuildResumeHappySessionRpcInput): ResumeHappySessionRpcParams {
    const {
        modelId,
        modelUpdatedAt,
        codexBackendMode,
        experimentalCodexAcp,
        runtimeDescriptorV1,
        connectedServices,
        ...rest
    } = input;
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    const includeModelOverride =
        normalizedModelId.length > 0 &&
        normalizedModelId !== 'default' &&
        typeof modelUpdatedAt === 'number' &&
        Number.isFinite(modelUpdatedAt);
    const codexTransportFields = buildCodexBackendTransportFields({
        backendTarget: rest.backendTarget,
        codexBackendMode,
        experimentalCodexAcp,
        runtimeDescriptorV1,
        resume: rest.resume,
    });
    const canonicalBackendTarget = readBackendTargetRefV2(rest.backendTarget);

    const params: ResumeHappySessionRpcParams = {
        type: 'resume-session',
        ...rest,
        backendTarget: canonicalBackendTarget,
        ...(codexTransportFields.codexBackendMode ? { codexBackendMode: codexTransportFields.codexBackendMode } : {}),
        ...(connectedServices === undefined || connectedServices === null ? {} : { connectedServices }),
        ...(runtimeDescriptorV1
            ? { runtimeDescriptorV1 }
            : codexTransportFields.runtimeDescriptorV1
                ? { runtimeDescriptorV1: codexTransportFields.runtimeDescriptorV1 }
                : {}),
        ...(includeModelOverride ? { modelId: normalizedModelId, modelUpdatedAt } : {}),
    };
    // Validate shape early to avoid accidentally sending secrets in wrong fields.
    return ResumeHappySessionRpcParamsSchema.parse(params);
}
