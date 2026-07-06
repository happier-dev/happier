export type { ConnectedServiceId } from '@happier-dev/protocol';
import {
    SESSION_PERMISSION_MODES,
    type ConnectedServiceId,
    type ConnectedServicesProviderConfigSharingModeV1,
    type ConnectedServicesProviderStateSharingModeV1,
} from '@happier-dev/protocol';
import type { AnyAgentRuntimeKindsManifest } from './runtimeKinds.js';

export const AGENT_IDS = ['claude', 'codex', 'opencode', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'kiro', 'customAcp', 'pi', 'copilot', 'cursor', 'agy', 'grok'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const PERMISSION_MODES = SESSION_PERMISSION_MODES;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Provider-agnostic permission intent.
 *
 * This is the canonical concept we want to persist going forward. Provider-specific tokens
 * (e.g. Claude's `acceptEdits`, `bypassPermissions`) are treated as legacy aliases at input
 * boundaries and must not be persisted as the session's selected permission mode.
 */
export const PERMISSION_INTENTS = [
    'default',
    'read-only',
    'safe-yolo',
    'yolo',
    'plan',
] as const;

export type PermissionIntent = (typeof PERMISSION_INTENTS)[number];

export type VendorResumeSupportLevel = 'supported' | 'unsupported' | 'experimental';
export type VendorHandoffSupportLevel = 'supported' | 'unsupported' | 'experimental';
export type AgentToolsDelivery = 'native_mcp' | 'shell_bridge' | 'unsupported';
export type AgentToolsSupportLevel = 'supported' | 'experimental' | 'unsupported';
export type AgentMediaCapabilitySupportLevel = 'supported' | 'unsupported' | 'experimental';
export type AgentMediaCapabilityKey = 'acceptsImageInput' | 'emitsSessionMedia' | 'nativeImageGeneration';
export type AgentLocalControlTopology = 'exclusive' | 'shared';
export type AgentLocalControlAttachStrategy = 'tmux' | 'provider_attach' | 'unsupported';
export type AgentSessionStorage = Readonly<{
    direct: boolean;
    persisted: boolean;
}>;
export type AgentSessionCapabilitySupportLevel = 'supported' | 'unsupported' | 'experimental';
export type AgentSessionAuthSwitchTransition =
    | 'native_to_connected'
    | 'connected_to_native'
    | 'connected_to_connected'
    | 'same_connected_group';
export type AgentSessionCapabilities = Readonly<{
    sessionListing: AgentSessionCapabilitySupportLevel;
    sessionFork: Readonly<{
        conversation: AgentSessionCapabilitySupportLevel;
        fromMessage: AgentSessionCapabilitySupportLevel;
    }>;
    sessionRollback: Readonly<{
        conversation: AgentSessionCapabilitySupportLevel;
    }>;
    usageLimitRecovery?: Readonly<{
        checkNow: AgentSessionCapabilitySupportLevel;
    }>;
}>;

export type VendorResumeIdField =
    | 'claudeSessionId'
    | 'codexSessionId'
    | 'geminiSessionId'
    | 'opencodeSessionId'
    | 'auggieSessionId'
    | 'qwenSessionId'
    | 'kimiSessionId'
    | 'kiloSessionId'
    | 'kiroSessionId'
    | 'piSessionId'
    | 'copilotSessionId'
    | 'cursorSessionId'
    | 'agySessionId'
    | 'grokSessionId';

export type CloudVendorKey = 'openai' | 'anthropic' | 'gemini';
export type CloudConnectTargetStatus = 'wired' | 'experimental';

export type ConnectedServiceKind = 'oauth' | 'token';
export type ConnectedServicesProviderStateSharingUnavailableReason =
    | 'not_implemented'
    | 'dynamic_diagnostics_required';

export type ConnectedServicesProviderStateSharingCapability = Readonly<{
    config: Readonly<{
        supported: boolean;
        modes: ReadonlyArray<ConnectedServicesProviderConfigSharingModeV1>;
        unavailableReason?: ConnectedServicesProviderStateSharingUnavailableReason;
    }>;
    state: Readonly<{
        supported: boolean;
        modes: ReadonlyArray<ConnectedServicesProviderStateSharingModeV1>;
        sharedStatePrivacyRiskAcknowledgementRequired?: boolean;
        unavailableReason?: ConnectedServicesProviderStateSharingUnavailableReason;
    }>;
}>;

export type AgentResumeConfig = Readonly<{
    vendorResume: VendorResumeSupportLevel;
    vendorResumeIdField?: VendorResumeIdField | null;
    experimentalResumePolicy?: 'disabled_by_default' | 'runtime_checked';
}>;

export type AgentHandoffConfig = Readonly<{
    vendorStateTransfer: VendorHandoffSupportLevel;
    requiresExplicitSessionId?: boolean;
}>;

export type AgentLocalControlConfig = Readonly<{
    supported: boolean;
    topology?: AgentLocalControlTopology;
    attachStrategy?: AgentLocalControlAttachStrategy;
}>;

export type AgentRuntimeInputConfig = Readonly<{
    inFlightSteerSupported: boolean;
    terminalPromptInjectionSupported: boolean;
}>;

export type AgentToolsConfig = Readonly<{
    delivery: AgentToolsDelivery;
    support: AgentToolsSupportLevel;
}>;

export type AgentMediaCapabilities = Readonly<Record<AgentMediaCapabilityKey, AgentMediaCapabilitySupportLevel>>;

export type AgentCoreRuntimeControlSurface = Readonly<{
    resume: AgentResumeConfig;
    sessionStorage: AgentSessionStorage;
    sessionCapabilities: AgentSessionCapabilities;
    handoff: AgentHandoffConfig;
    localControl?: AgentLocalControlConfig | null;
    runtimeInput?: AgentRuntimeInputConfig | null;
    tools: AgentToolsConfig;
    media: AgentMediaCapabilities;
}>;

export type AgentCore = Readonly<{
    id: AgentId;
    /**
     * CLI subcommand used to spawn/select the agent.
     * For now this matches the canonical id.
     */
    cliSubcommand: AgentId;
    /**
     * CLI binary name used for local detection (e.g. `command -v <detectKey>`).
     * For now this matches the canonical id.
     */
    detectKey: string;
    /**
     * Optional alternative flavors that should resolve to this agent id.
     *
     * This is intended for internal variants (e.g. `codex-acp`) and UI legacy
     * strings; the canonical id should remain the primary persisted value.
     */
    flavorAliases?: ReadonlyArray<string>;
    /**
     * Optional cloud-connect config for this agent.
     *
     * When present, the CLI/app may offer a `happier connect <agentId>` flow.
     */
    cloudConnect?: Readonly<{ vendorKey: CloudVendorKey; status: CloudConnectTargetStatus }> | null;
    /**
     * Optional Happier Connected Services compatibility for this agent.
     *
     * This is used by UI + daemon to offer "connect once, reuse everywhere" auth routing.
     */
    connectedServices?: Readonly<{
      supportedServiceIds: ReadonlyArray<ConnectedServiceId>;
      providerStateSharing?: ConnectedServicesProviderStateSharingCapability;
      sessionAuthSwitch?: Readonly<{
        continuityMode: 'hot_apply' | 'restart_same_home' | 'restart_shared_state_required';
        supportedTransitions?: ReadonlyArray<AgentSessionAuthSwitchTransition>;
        providerStateSharingRequired?: Readonly<{
          serviceIds?: ReadonlyArray<ConnectedServiceId>;
          supportedTransitions: ReadonlyArray<AgentSessionAuthSwitchTransition>;
        }>;
      }>;
      /**
       * Optional credential-kind compatibility per connected service id.
       *
       * When provided, consumers should only offer connected-service profiles whose `kind`
       * is in the allowed list for the target agent/backend.
       */
      supportedKindsByServiceId?: Readonly<Partial<Record<ConnectedServiceId, ReadonlyArray<ConnectedServiceKind>>>>;
    }> | null;
    runtimeKinds?: AnyAgentRuntimeKindsManifest | null;
}> & AgentCoreRuntimeControlSurface;
