import { z } from 'zod';
import type { CodexBackendMode } from '@happier-dev/protocol';
import {
    BackendTargetRefV2Schema,
    buildBackendTargetKeyV2,
    normalizeBackendTargetRefV2InputToV2,
    readBackendTargetRefV2,
    RuntimeDescriptorV1Schema,
    SessionModelSelectionV1Schema,
    SessionAttachMetadataIdentityPolicySchema,
    SessionAuthoringValueV1Schema,
    SessionInitialGoalRequestV1Schema,
    SpawnSessionExecutionAuthorizationSchema,
    type SessionAttachMetadataIdentityPolicy,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    type RuntimeDescriptorV1,
    type SessionAuthoringValueV1,
    type SessionInitialGoalRequestV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import {
    buildBackendTransportFieldsFromUiState,
    type AgentBackendTransportFields,
} from '@/agents/registry/registryUiBehavior';
import { isPermissionMode, type PermissionMode } from '../../permissions/permissionTypes';

export type ResumeHappySessionRpcParams = AgentBackendTransportFields & {
    type: 'resume-session';
    sessionId: string;
    directory: string;
    backendTarget: BackendTargetRefV2;
    resume?: string;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    environmentVariables?: Record<string, string>;
    connectedServices?: SessionAuthoringValueV1['connectedServices'];
    connectedServicesUpdatedAt?: number;
    transcriptStorage?: 'direct' | 'persisted';
    attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy;
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    modelSelection?: SessionModelSelectionV1;
    accountSettingsVersionHint?: number;
    initialTranscriptAfterSeq?: number;
    executionAuthorization?: Readonly<{
        provenance: 'user_request';
        requestId: string;
    }>;
    initialGoal?: SessionInitialGoalRequestV1;
};

type BuildResumeHappySessionRpcInput = Omit<ResumeHappySessionRpcParams, 'type' | 'backendTarget' | 'codexBackendMode'> & {
    /** Builder-only target identity; daemon wire payloads never carry it. */
    machineId: string;
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
    connectedServicesUpdatedAt: z.number().optional(),
    transcriptStorage: z.enum(['direct', 'persisted']).optional(),
    attachMetadataIdentityPolicy: SessionAttachMetadataIdentityPolicySchema.optional(),
    permissionMode: z.string().refine((value) => isPermissionMode(value)).optional(),
    permissionModeUpdatedAt: z.number().optional(),
    modelSelection: SessionModelSelectionV1Schema.optional(),
    accountSettingsVersionHint: z.number().int().nonnegative().optional(),
    initialTranscriptAfterSeq: z.number().int().nonnegative().optional(),
    executionAuthorization: SpawnSessionExecutionAuthorizationSchema.optional(),
    initialGoal: SessionInitialGoalRequestV1Schema.optional(),
    experimentalCodexAcp: z.literal(true).optional(),
    codexBackendMode: z.enum(['acp', 'appServer']).optional(),
});

export function buildResumeHappySessionRpcParams(input: BuildResumeHappySessionRpcInput): ResumeHappySessionRpcParams {
    const {
        machineId,
        modelSelection,
        modelId: _legacyModelId,
        modelUpdatedAt: _legacyModelUpdatedAt,
        codexBackendMode,
        experimentalCodexAcp,
        runtimeDescriptorV1,
        connectedServices,
        connectedServicesUpdatedAt,
        ...rest
    } = input as BuildResumeHappySessionRpcInput & { modelId?: unknown; modelUpdatedAt?: unknown };
    const backendTransportFields = buildBackendTransportFieldsFromUiState({
        machineId,
        backendTarget: rest.backendTarget,
        providerMode: codexBackendMode,
        legacyExperimentalMode: experimentalCodexAcp,
        runtimeDescriptorV1,
        providerSessionId: rest.resume,
    });
    const canonicalBackendTarget = readBackendTargetRefV2(rest.backendTarget);
    const canonicalModelSelection = modelSelection
        ? SessionModelSelectionV1Schema.parse(modelSelection)
        : null;
    if (canonicalModelSelection
        && canonicalModelSelection.ref.agentTargetKey !== buildBackendTargetKeyV2(canonicalBackendTarget)) {
        throw new Error('Resume model selection target mismatch');
    }

    const params: ResumeHappySessionRpcParams = {
        type: 'resume-session',
        ...rest,
        backendTarget: canonicalBackendTarget,
        ...(backendTransportFields.codexBackendMode ? { codexBackendMode: backendTransportFields.codexBackendMode } : {}),
        ...(connectedServices === undefined || connectedServices === null ? {} : { connectedServices }),
        ...(connectedServices === undefined || connectedServices === null ? {} : (
            typeof connectedServicesUpdatedAt === 'number' && Number.isFinite(connectedServicesUpdatedAt)
                ? { connectedServicesUpdatedAt }
                : {}
        )),
        ...(runtimeDescriptorV1
            ? { runtimeDescriptorV1 }
            : backendTransportFields.runtimeDescriptorV1
                ? { runtimeDescriptorV1: backendTransportFields.runtimeDescriptorV1 }
                : {}),
        ...(canonicalModelSelection ? { modelSelection: canonicalModelSelection } : {}),
    };
    // Validate shape early to avoid accidentally sending secrets in wrong fields.
    return ResumeHappySessionRpcParamsSchema.parse(params);
}
