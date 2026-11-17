import { AgentExecutionTargetV1Schema, type AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';
import { SessionResumeRequestV1Schema, type SessionResumeRequestV1 } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/resolveBundledAgentIdFromContributionIdentity';

export type ResumeHappySessionRpcParams = SessionResumeRequestV1;

export class ResumeSessionInputValidationError extends Error {
    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : 'Invalid Resume input', { cause });
        this.name = 'ResumeSessionInputValidationError';
    }
}

type BuildResumeHappySessionRpcInput = Omit<ResumeHappySessionRpcParams, 'type' | 'agentTarget' | 'backendTarget'> & {
    /** Builder-only target identity; daemon wire payloads never carry it. */
    machineId: string;
    agentTarget?: AgentExecutionTargetV1;
    backendTarget?: BackendTargetRefV2Input;
};

export function buildResumeHappySessionRpcParams(input: BuildResumeHappySessionRpcInput): ResumeHappySessionRpcParams {
    try {
        return buildValidatedResumeHappySessionRpcParams(input);
    } catch (cause) {
        throw new ResumeSessionInputValidationError(cause);
    }
}

function buildValidatedResumeHappySessionRpcParams(input: BuildResumeHappySessionRpcInput): ResumeHappySessionRpcParams {
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
    const predecessorBackendTarget = predecessorBundledAgentId && agentTarget
        ? readBackendTargetRefV2(agentTarget)
        : undefined;
    const canonicalBackendTarget = explicitBackendTarget ?? predecessorBackendTarget;
    const canonicalModelSelection = modelSelection
        ? SessionModelSelectionSchema.parse(modelSelection)
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
        ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
        ...(canonicalModelSelection ? { modelSelection: canonicalModelSelection } : {}),
    };
    // Validate shape early to avoid accidentally sending secrets in wrong fields.
    return SessionResumeRequestV1Schema.parse(params);
}
