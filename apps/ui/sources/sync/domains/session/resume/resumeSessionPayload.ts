import { z } from 'zod';
import { buildCodexAgentRuntimeDescriptor, type CodexBackendMode } from '@happier-dev/agents';
import {
    AgentRuntimeDescriptorV1Schema,
    BackendTargetRefSchema,
    SessionAttachMetadataIdentityPolicySchema,
    SessionAuthoringValueV1Schema,
    type SessionAttachMetadataIdentityPolicy,
    type AgentRuntimeDescriptorV1,
    type BackendTargetRefV1,
    type SessionAuthoringValueV1,
} from '@happier-dev/protocol';
import { isPermissionMode, type PermissionMode } from '../../permissions/permissionTypes';

import { buildCodexBackendTransportFields, type CodexBackendTransportFields } from '../codexBackendTransport';

export type ResumeHappySessionRpcParams = CodexBackendTransportFields & {
    type: 'resume-session';
    sessionId: string;
    directory: string;
    backendTarget: BackendTargetRefV1;
    resume?: string;
    agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
    environmentVariables?: Record<string, string>;
    connectedServices?: SessionAuthoringValueV1['connectedServices'];
    transcriptStorage?: 'direct' | 'persisted';
    attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy;
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    modelId?: string;
    modelUpdatedAt?: number;
};

type BuildResumeHappySessionRpcInput = Omit<ResumeHappySessionRpcParams, 'type' | keyof CodexBackendTransportFields> & {
    codexBackendMode?: CodexBackendMode;
    experimentalCodexAcp?: boolean;
};

const ResumeHappySessionRpcParamsSchema = z.object({
    type: z.literal('resume-session'),
    sessionId: z.string().min(1),
    directory: z.string().min(1),
    backendTarget: BackendTargetRefSchema,
    resume: z.string().min(1).optional(),
    agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
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
        agentRuntimeDescriptorV1,
        connectedServices,
        ...rest
    } = input;
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    const includeModelOverride =
        normalizedModelId.length > 0 &&
        normalizedModelId !== 'default' &&
        typeof modelUpdatedAt === 'number' &&
        Number.isFinite(modelUpdatedAt);
    const codexTransportFields = buildCodexBackendTransportFields({ codexBackendMode, experimentalCodexAcp, agentRuntimeDescriptorV1 });
    const canonicalCodexBackendMode = codexTransportFields.codexBackendMode;

    const params: ResumeHappySessionRpcParams = {
        type: 'resume-session',
        ...rest,
        ...codexTransportFields,
        ...(connectedServices === undefined || connectedServices === null ? {} : { connectedServices }),
        ...(() => {
            if (agentRuntimeDescriptorV1) {
                return { agentRuntimeDescriptorV1 };
            }

            if (rest.backendTarget.kind === 'builtInAgent' && rest.backendTarget.agentId === 'codex' && canonicalCodexBackendMode) {
                return {
                    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
                        backendMode: canonicalCodexBackendMode,
                        vendorSessionId: rest.resume,
                    }),
                };
            }

            return {};
        })(),
        ...(includeModelOverride ? { modelId: normalizedModelId, modelUpdatedAt } : {}),
    };
    // Validate shape early to avoid accidentally sending secrets in wrong fields.
    ResumeHappySessionRpcParamsSchema.parse(params);
    return params;
}
