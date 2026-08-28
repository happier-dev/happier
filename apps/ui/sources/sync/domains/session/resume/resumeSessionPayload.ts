import { z } from 'zod';
import {
    AgentExecutionTargetV1Schema,
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
    type AgentExecutionTargetV1,
    type RuntimeDescriptorV1,
    type SessionAuthoringValueV1,
    type SessionInitialGoalRequestV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import {
    buildBackendTransportFieldsFromUiState,
} from '@/agents/registry/registryUiBehavior';
import { isPermissionMode, type PermissionMode } from '../../permissions/permissionTypes';

export type ResumeHappySessionRpcParams = {
    type: 'resume-session';
    sessionId: string;
    directory: string;
    agentTarget?: AgentExecutionTargetV1;
    backendTarget?: BackendTargetRefV2;
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

type BuildResumeHappySessionRpcInput = Omit<ResumeHappySessionRpcParams, 'type' | 'agentTarget' | 'backendTarget'> & {
    /** Builder-only target identity; daemon wire payloads never carry it. */
    machineId: string;
    agentTarget?: AgentExecutionTargetV1;
    backendTarget?: BackendTargetRefV2Input;
};

const ResumeHappySessionRpcParamsSchema = z.object({
    type: z.literal('resume-session'),
    sessionId: z.string().min(1),
    directory: z.string().min(1),
    agentTarget: AgentExecutionTargetV1Schema.optional(),
    backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema.optional()),
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
}).superRefine((value, context) => {
    if (!value.agentTarget && !value.backendTarget) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['agentTarget'],
            message: 'agentTarget or configured backendTarget is required',
        });
    }
});

export function buildResumeHappySessionRpcParams(input: BuildResumeHappySessionRpcInput): ResumeHappySessionRpcParams {
    const {
        machineId,
        modelSelection,
        modelId: _legacyModelId,
        modelUpdatedAt: _legacyModelUpdatedAt,
        runtimeDescriptorV1,
        connectedServices,
        connectedServicesUpdatedAt,
        agentTarget: agentTargetInput,
        backendTarget: backendTargetInput,
        ...rest
    } = input as BuildResumeHappySessionRpcInput & { modelId?: unknown; modelUpdatedAt?: unknown };
    const agentTarget = agentTargetInput
        ? AgentExecutionTargetV1Schema.parse(agentTargetInput)
        : undefined;
    const explicitBackendTarget = backendTargetInput !== undefined
        ? readBackendTargetRefV2(backendTargetInput)
        : undefined;
    const predecessorBundledAgentId = agentTarget
        ? resolveBundledAgentIdFromContributionIdentity(agentTarget.identity)
        : null;
    // Exact `cli-v0.2.1` egress: old daemons strip `agentTarget`, so bundled
    // resumes also carry the released backend target. External Agents have no
    // predecessor representation and remain canonical-only. Remove with that
    // daemon compatibility floor.
    const predecessorBackendTarget = predecessorBundledAgentId
        ? readBackendTargetRefV2({
            kind: 'backend',
            backendId: predecessorBundledAgentId,
            sourceKind: 'built_in',
        })
        : undefined;
    const canonicalBackendTarget = explicitBackendTarget ?? predecessorBackendTarget;
    const backendTransportFields = canonicalBackendTarget
        ? buildBackendTransportFieldsFromUiState({
            machineId,
            backendTarget: canonicalBackendTarget,
            runtimeDescriptorV1,
            providerSessionId: rest.resume,
        })
        : {};
    const canonicalModelSelection = modelSelection
        ? SessionModelSelectionV1Schema.parse(modelSelection)
        : null;
    const canonicalTargetKey = agentTarget
        ? buildBackendTargetKeyV2(agentTarget)
        : canonicalBackendTarget
            ? buildBackendTargetKeyV2(canonicalBackendTarget)
            : null;
    const predecessorTargetKey = predecessorBackendTarget
        ? buildBackendTargetKeyV2(predecessorBackendTarget)
        : null;
    if (canonicalModelSelection
        && canonicalModelSelection.ref.agentTargetKey !== canonicalTargetKey
        && canonicalModelSelection.ref.agentTargetKey !== predecessorTargetKey) {
        throw new Error('Resume model selection target mismatch');
    }

    const params: ResumeHappySessionRpcParams = {
        type: 'resume-session',
        ...rest,
        ...(agentTarget ? { agentTarget } : {}),
        ...(canonicalBackendTarget ? { backendTarget: canonicalBackendTarget } : {}),
        ...(connectedServices === undefined || connectedServices === null ? {} : { connectedServices }),
        ...(connectedServices === undefined || connectedServices === null ? {} : (
            typeof connectedServicesUpdatedAt === 'number' && Number.isFinite(connectedServicesUpdatedAt)
                ? { connectedServicesUpdatedAt }
                : {}
        )),
        ...(runtimeDescriptorV1
            ? { runtimeDescriptorV1 }
            : 'runtimeDescriptorV1' in backendTransportFields && backendTransportFields.runtimeDescriptorV1
                ? { runtimeDescriptorV1: backendTransportFields.runtimeDescriptorV1 }
                : {}),
        ...(canonicalModelSelection ? { modelSelection: canonicalModelSelection } : {}),
    };
    // Validate shape early to avoid accidentally sending secrets in wrong fields.
    return ResumeHappySessionRpcParamsSchema.parse(params);
}
