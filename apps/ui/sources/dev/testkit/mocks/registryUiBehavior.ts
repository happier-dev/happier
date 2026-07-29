type RegistryUiBehaviorModule = typeof import('@/agents/registry/registryUiBehavior');

export type RegistryUiBehaviorModuleMock = RegistryUiBehaviorModule;
export type RegistryUiBehaviorModuleMockOverrides = Partial<RegistryUiBehaviorModule>;

const EMPTY_AGENT_UI_BEHAVIOR_BY_ID = {
    claude: {},
    codex: {},
    opencode: {},
    antigravity: {},
    gemini: {},
    grok: {},
    auggie: {},
    qwen: {},
    kimi: {},
    kilo: {},
    kiro: {},
    cursor: {},
    ohMyPi: {},
    pi: {},
    copilot: {},
    coderabbit: {},
    deepsec: {},
} satisfies RegistryUiBehaviorModule['CANONICAL_AGENTS_UI_BEHAVIOR'];

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
        resolvePendingDeliveryLabelKeyForSession: () => null,
        resolvePendingDeliveryTransientActionForSession: () => null,
        resolveProviderSessionArtifactPathFromUiBehavior: () => null,
        resolveSessionGoalActionCapabilityProfile: () => null,
        classifyAgentSessionComposerNonSteerablePayload: () => null,
        isAttachedSessionTerminalAvailableForSession: () => false,
        supportsDetectedMcpConfigScan: () => false,
        supportsEditableSessionGoals: () => false,
    } satisfies RegistryUiBehaviorModuleMock;

    return {
        ...defaults,
        ...overrides,
    };
}
