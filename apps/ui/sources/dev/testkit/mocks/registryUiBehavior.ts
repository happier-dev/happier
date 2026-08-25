import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';

type RegistryUiBehaviorModule = typeof import('@/agents/registry/registryUiBehavior');

export type RegistryUiBehaviorModuleMock = RegistryUiBehaviorModule;
export type RegistryUiBehaviorModuleMockOverrides = Partial<RegistryUiBehaviorModule>;

const EMPTY_AGENT_UI_BEHAVIOR_BY_ID = Object.freeze(Object.fromEntries(
    CANONICAL_AGENT_IDS.map((agentId) => [agentId, Object.freeze({})]),
)) as RegistryUiBehaviorModule['CANONICAL_AGENTS_UI_BEHAVIOR'];

export function createRegistryUiBehaviorModuleMock(
    overrides: RegistryUiBehaviorModuleMockOverrides = {},
): RegistryUiBehaviorModuleMock {
    const defaults = {
        CANONICAL_AGENTS_UI_BEHAVIOR: EMPTY_AGENT_UI_BEHAVIOR_BY_ID,
        AGENTS_UI_BEHAVIOR: EMPTY_AGENT_UI_BEHAVIOR_BY_ID,
        buildBackendTransportFieldsFromUiState: () => ({}),
        buildResumeCapabilityOptionsFromUiState: () => ({}),
        buildNewSessionOptionsFromUiState: () => ({}),
        canSelectAgentWithoutDetectedCli: () => false,
        getNewSessionAgentInputExtraActionChips: () => [],
        buildSpawnEnvironmentVariablesFromUiState: () => ({}),
        buildResumeSessionExtrasFromUiState: () => ({}),
        buildSpawnSessionExtrasFromUiState: () => ({}),
        buildWakeResumeExtras: () => ({}),
        buildSessionHandoffSourceRecoveryResumePatch: () => ({}),
        getAgentResumeExperimentsFromSettings: () => ({ enabled: true, switches: {} }),
        getNewSessionPreflightIssues: () => [],
        getNewSessionRelevantInstallableDepKeys: () => [],
        resolveAgentUiBehavior: () => ({}),
        resolveAgentUiBehaviorFromFlavor: () => ({}),
        resolveAgentUiBehaviorFromSessionMetadata: () => ({}),
        resolveBundledAgentUiBehaviorProjection: () => null,
        resolveOwningMachineIdForSession: () => null,
        resolvePendingDeliveryLabelKeyForSession: () => null,
        resolvePendingDeliveryTransientActionForSession: () => null,
        resolveSessionGoalActionCapabilityProfile: () => null,
        classifyAgentSessionComposerNonSteerablePayload: () => null,
        isAttachedSessionTerminalAvailableForSession: () => false,
        supportsEditableSessionGoals: () => false,
    } satisfies RegistryUiBehaviorModuleMock;

    return {
        ...defaults,
        ...overrides,
    };
}
