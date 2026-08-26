import type {
    AgentExternalSessionTakeoverLaunchPlan,
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';

import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { isSessionControlEnvKey } from '@/session/runtime/control/sessionControlEnvironment';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

type ExternalTakeoverTargetAgent = Pick<
    ResolvedAgentContribution,
    'id' | 'provenance' | 'source' | 'hostAccess'
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

function resolveTargetBackend(
    targetAgent: ExternalTakeoverTargetAgent,
): NonNullable<SpawnSessionOptions['backendTarget']> {
    if (
        targetAgent.provenance === 'first_party'
        && targetAgent.source.kind === 'bundled'
    ) {
        return {
            kind: 'backend',
            backendId: targetAgent.id,
            sourceKind: 'built_in',
        };
    }
    return {
        kind: 'backend',
        backendId: targetAgent.id,
        configuredBackendId: targetAgent.id,
        sourceKind: 'configured',
    };
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

    return {
        directory: params.targetDirectory,
        backendTarget: resolveTargetBackend(params.targetAgent),
        existingSessionId: params.linkedSessionId,
        resume: params.resolvedIdentity.remoteSessionId,
        approvedNewDirectoryCreation: true,
        ...(params.plan.backendModeHint
            ? { backendMode: params.plan.backendModeHint }
            : {}),
        ...(params.plan.runtimeDescriptorV1
            ? { runtimeDescriptorV1: params.plan.runtimeDescriptorV1 }
            : {}),
        ...(environmentVariables
            ? { environmentVariables: { ...environmentVariables } }
            : {}),
    };
}
