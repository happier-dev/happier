export const AGENT_IDS = ['claude', 'codex', 'opencode', 'gemini', 'auggie', 'qwen', 'kimi', 'kilo', 'pi'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const PERMISSION_MODES = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'read-only',
    'safe-yolo',
    'yolo',
] as const;

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
export type ResumeRuntimeGate = 'acpLoadSession' | null;

export type VendorResumeIdField =
    | 'codexSessionId'
    | 'geminiSessionId'
    | 'opencodeSessionId'
    | 'auggieSessionId'
    | 'qwenSessionId'
    | 'kimiSessionId'
    | 'kiloSessionId'
    | 'piSessionId';

export type CloudVendorKey = 'openai' | 'anthropic' | 'gemini';
export type CloudConnectTargetStatus = 'wired' | 'experimental';

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
    detectKey: AgentId;
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
    resume: Readonly<{
        /**
         * Whether vendor-resume is supported in principle.
         *
         * - supported: generally supported and expected to work
         * - experimental: supported but intentionally gated/opt-in
         * - unsupported: not available at all
         */
        vendorResume: VendorResumeSupportLevel;
        /**
         * Optional metadata field name used to persist the vendor resume id.
         *
         * This lets UI + CLI agree on which metadata key to read/write without
         * duplicating strings.
         */
        vendorResumeIdField?: VendorResumeIdField | null;
        /**
         * Optional runtime gate used by apps to enable resume dynamically per machine.
         */
        runtimeGate: ResumeRuntimeGate;
    }>;
}>;
