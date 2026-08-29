import type {
    AgentExternalSessionTakeoverLaunchPlan,
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol';

import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { isSessionControlEnvKey } from '@/session/runtime/control/sessionControlEnvironment';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

type ExternalTakeoverTargetAgent = Pick<
    ResolvedAgentContribution,
    'id' | 'identity' | 'hostAccess'
>;

function readDeclaredProcessEnvironmentKeys(
    targetAgent: ExternalTakeoverTargetAgent,
): ReadonlySet<string> {
    return new Set(
        (targetAgent.hostAccess?.required ?? []).flatMap((request) => (
            request.capability === 'process'
                ? request.scope.envKeys ?? []
                : []
        )),
    );
}

export function mapExternalTakeoverLaunchPlanToSpawnOptions(params: Readonly<{
    plan: AgentExternalSessionTakeoverLaunchPlan;
    /**
     * Host-authoritative local target selected before the durable takeover
     * request is admitted. Plugin launch plans may describe provider context,
     * but never choose the process working directory.
     */
    targetDirectory: string;
    resolvedIdentity: AgentExternalSessionsResolvedIdentity;
    linkedSessionId: string;
    targetAgent: ExternalTakeoverTargetAgent;
}>): SpawnSessionOptions | null {
    const environmentVariables = params.plan.environmentVariables;
    if (environmentVariables) {
        const declaredKeys = readDeclaredProcessEnvironmentKeys(
            params.targetAgent,
        );
        if (Object.keys(environmentVariables).some((key) => (
            !declaredKeys.has(key)
            || isSessionControlEnvKey(key)
        ))) {
            return null;
        }
    }

    const agentTarget = AgentExecutionTargetV1Schema.safeParse({
        kind: 'agent',
        identity: params.targetAgent.identity,
    });
    if (!agentTarget.success) return null;

    /**
     * Backend-mode selection travels only through the Agent-owned runtime
     * descriptor — the same carrier the canonical spawn-new selection owner
     * uses. A launch hint never fabricates a generic spawn field, and the
     * Agent's own descriptor payload stays authoritative when it already
     * selects a backend mode.
     */
    const backendModeHint = params.plan.backendModeHint;
    const descriptorFromPlan = params.plan.runtimeDescriptorV1;
    let runtimeDescriptorV1 = descriptorFromPlan;
    if (backendModeHint !== undefined) {
        if (descriptorFromPlan) {
            const descriptorAgent = descriptorFromPlan.agent as Record<string, unknown>;
            if (!descriptorAgent.backendMode) {
                runtimeDescriptorV1 = {
                    ...descriptorFromPlan,
                    agent: {
                        backendMode: backendModeHint,
                        ...descriptorAgent,
                    },
                };
            }
        } else {
            runtimeDescriptorV1 = {
                v: 1,
                agentId: params.targetAgent.id,
                agent: { backendMode: backendModeHint },
            };
        }
    }

    return {
        directory: params.targetDirectory,
        agentTarget: agentTarget.data,
        existingSessionId: params.linkedSessionId,
        resume: params.resolvedIdentity.remoteSessionId,
        approvedNewDirectoryCreation: true,
        ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
        ...(environmentVariables
            ? { environmentVariables: { ...environmentVariables } }
            : {}),
    };
}
