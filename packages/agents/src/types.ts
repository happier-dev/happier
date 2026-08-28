export type { ConnectedServiceId } from '@happier-dev/protocol';
import {
    SESSION_PERMISSION_MODES,
} from '@happier-dev/protocol/sessions/metadata/permission-modes';
import {
    type ConnectedServiceId,
    type ConnectedServicesProviderConfigSharingModeV1,
    type ConnectedServicesProviderStateSharingModeV1,
} from '@happier-dev/protocol';
import {
    AGENT_IDS,
    isBundledAgentId,
    type AgentId,
    type BundledAgentId,
} from './generated/agentIds.js';
import type { AnyAgentRuntimeKindsManifest } from './runtimeKinds.js';

export {
    AGENT_IDS,
    isBundledAgentId,
    type AgentId,
    type BundledAgentId,
};
export const CANONICAL_AGENT_IDS = AGENT_IDS;
/**
 * Historical name for {@link BundledAgentId}.
 *
 * Kept because the canonical-fact records and their `CANONICAL_*` aggregates
 * read in that vocabulary; both names denote the same closed bundled set.
 */
export type CanonicalAgentId = BundledAgentId;

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
export type AgentToolsDelivery = 'native_mcp' | 'native_extension' | 'shell_bridge' | 'unsupported';
export type AgentToolsSupportLevel = 'supported' | 'experimental' | 'unsupported';
export type AgentLocalControlTopology = 'exclusive' | 'shared';
export type AgentLocalControlAttachStrategy = 'terminal_host' | 'provider_attach' | 'unsupported';
export type AgentSessionStorage = Readonly<{
    direct: boolean;
    persisted: boolean;
}>;
export type AgentSessionCapabilitySupportLevel = 'supported' | 'unsupported' | 'experimental';
export type AgentSessionCapabilities = Readonly<{
    sessionListing: AgentSessionCapabilitySupportLevel;
    sessionFork: Readonly<{
        conversation: AgentSessionCapabilitySupportLevel;
        fromMessage: AgentSessionCapabilitySupportLevel;
        /** Exact protocol strategy for the materialized runtime when one is required. */
        protocol?: 'acp';
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
    | 'grokSessionId'
    | 'opencodeSessionId'
    | 'auggieSessionId'
    | 'qwenSessionId'
    | 'kimiSessionId'
    | 'kiloSessionId'
    | 'kiroSessionId'
    | 'cursorSessionId'
    | 'ohMyPiSessionId'
    | 'piSessionId'
    | 'antigravitySessionId'
    | 'copilotSessionId';

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

export type ExperimentalVendorResumePolicy = 'disabled_by_default' | 'runtime_checked';

export type AgentResumeConfig = Readonly<{
    vendorResume: VendorResumeSupportLevel;
    vendorResumeIdField?: VendorResumeIdField | null;
    /**
     * Session-metadata key where this Agent publishes its OWN session-log path
     * for the current vendor resume id, when it keeps one on this machine.
     *
     * A POINTER, never a gate (`AM-24`): its only consumer is the Agent-transition
     * brief, which offers the successor the predecessor's log. An Agent that
     * persists nothing can still declare `resolveAgentNativeSessionLogPath` in the
     * catalog and have the path derived instead.
     *
     * The NAME is predecessor vocabulary and is scheduled to become
     * `agentNativeSessionLogPathField`. It is one key in a GENERATED projection
     * (`packages/agents/src/generated/bundledAgentDefinitions.ts`) whose single
     * producer is `scripts/migrations/extensions/generateBundledPluginEntries.ts`,
     * so the rename lands with that producer's next successful run — never by
     * hand, because a source-only rename would leave the runtime reading an
     * absent key and silently drop the pointer.
     */
    vendorResumeContinuityProofField?: string | null;
    experimentalResumePolicy?: ExperimentalVendorResumePolicy;
}>;

export type AgentHandoffConfig = Readonly<{
    vendorStateTransfer: VendorHandoffSupportLevel;
    requiresExplicitSessionId?: boolean;
}>;

export type AgentLocalControlConfig = Readonly<{
    supported: boolean;
    topology?: AgentLocalControlTopology;
    attachStrategy?: AgentLocalControlAttachStrategy;
    remoteWritable?: boolean;
}>;

export type AgentRuntimeInputConfig = Readonly<{
    inFlightSteerSupported: boolean;
    terminalPromptInjectionSupported: boolean;
}>;

export type AgentToolsConfig = Readonly<{
    delivery: AgentToolsDelivery;
    support: AgentToolsSupportLevel;
}>;

export type AgentCoreRuntimeControlSurface = Readonly<{
    resume: AgentResumeConfig;
    sessionStorage: AgentSessionStorage;
    sessionCapabilities: AgentSessionCapabilities;
    handoff: AgentHandoffConfig;
    localControl?: AgentLocalControlConfig | null;
    runtimeInput?: AgentRuntimeInputConfig | null;
    tools: AgentToolsConfig;
}>;

export type AgentCore = Readonly<{
    id: BundledAgentId;
    /**
     * Whether this agent contributes a concrete backend definition.
     *
     * Compatibility-only agent ids keep this false so backend definition assembly
     * can derive its concrete id set from canonical metadata instead of a
     * hard-coded denylist.
     */
    backendDefinition?: boolean;
    /**
     * CLI subcommand used to spawn/select the agent.
     * For now this matches the canonical id.
     */
    cliSubcommand: BundledAgentId;
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
