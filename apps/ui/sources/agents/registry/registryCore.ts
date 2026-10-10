import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { TranslationKey, TranslationKeyNoParams } from '@/text';
import type { Href } from 'expo-router';
import type { ConnectedServiceId } from '@happier-dev/protocol';

import {
    AGENT_IDS as SHARED_AGENT_IDS,
    DEFAULT_AGENT_ID,
    isBundledAgentId,
    resolveAgentIdFromFlavor,
    resolveAgentIdFromSessionMetadata,
    type AgentCore as SharedAgentCore,
    type AgentId,
    type AgentModelConfig,
    type PermissionIntent,
    type AgentSessionStorage,
    type AgentToolsDelivery,
    type AgentToolsSupportLevel,
    type BundledAgentId,
    type SessionMetadataAgentId,
    type VendorResumeIdField,
} from '@happier-dev/agents';

import { BUNDLED_CANONICAL_AGENTS_CORE } from './generatedBundledPluginEntries';

export type { AgentId, BundledAgentId, SessionMetadataAgentId };

/**
 * Historical UI spelling of the bundled-Agent key.
 *
 * `@happier-dev/agents` owns the split: `BundledAgentId` is the closed set of
 * Agents whose facts ship inside this build, while `AgentId` accepts any
 * installed contribution id. Every UI record that is exhaustive over the
 * bundled Agents keys on this alias; prefer `BundledAgentId` in new code.
 */
export type CanonicalAgentId = BundledAgentId;

export type PermissionModeGroupId = 'claude' | 'codexLike';
export type PermissionPromptProtocol = 'claude' | 'codexDecision';

export type MachineLoginKey = string;

export type AgentCoreConfig = Readonly<{
    /** A UI core exists only for a bundled Agent; external Agents ship their own. */
    id: BundledAgentId;
    /**
     * Translation key for the agent display name in UI.
     * (Resolved via `t(...)` in UI modules.)
     */
    displayNameKey: TranslationKey;
    /**
     * Translation key for the agent subtitle in profile/session pickers.
     */
    subtitleKey: TranslationKey;
    /**
     * Translation key prefix for permission mode labels/badges.
     * Examples:
     * - Claude: `agentInput.permissionMode.*`
     * - Codex: `agentInput.codexPermissionMode.*`
     * - Gemini: `agentInput.geminiPermissionMode.*`
     */
    permissionModeI18nPrefix: string;
    availability: Readonly<{
        /**
         * Whether this backend should be marked as experimental in UI surfaces.
         */
        experimental: boolean;
    }>;
    /**
     * Shared Happier Connected Services compatibility from `@happier-dev/agents`.
     */
    connectedServices: SharedAgentCore['connectedServices'];
    uiConnectedService: Readonly<{
        /**
         * UI presentation metadata for the service backing this agent.
         * When null, the agent has no account-level OAuth connection surface in the UI.
         */
        serviceId: ConnectedServiceId | null;
        /**
         * Canonical translation key for the service label shown in account settings and provider surfaces.
         */
        labelKey: TranslationKey;
        /**
         * Optional app route used to connect the service.
         */
        connectRoute: Href | null;
    }>;
    flavorAliases: readonly string[];
    /** Manifest-owned environment keys reserved for provider routing/auth materialization. */
    providerOwnedEnvironmentKeys?: readonly string[];
    cli: Readonly<{
        /**
         * The shell command name used for CLI detection (and for UX copy).
         * Example: `command -v <detectKey>`.
         */
        detectKey: string;
        /**
         * Profile-level machine-login identifier used when `profile.authMode=machineLogin`.
         * Resolved against `profile.requiresMachineLoginTargetKey` when the profile is saved.
         */
        machineLoginKey: MachineLoginKey;
        /**
         * Optional UX metadata for "CLI not detected" banners.
         */
        installBanner: Readonly<{
            /**
             * When "command", show `newSession.cliBanners.installCommand` with `installCommand`.
             * When "ifAvailable", show `newSession.cliBanners.installCliIfAvailable` with the CLI name.
             */
            installKind: 'command' | 'ifAvailable';
            installCommand?: string;
            guideUrl?: string;
        }>;
        /**
         * Canonical agent id passed to daemon RPCs (spawn/resume).
         * Keep this stable; do not use aliases here.
         */
        spawnAgent: AgentId;
    }> | null;
    permissions: Readonly<{
        modeGroup: PermissionModeGroupId;
        promptProtocol: PermissionPromptProtocol;
        /** Manifest-declared ACP policy mapping; null leaves the provider policy in place. */
        permissionModeMapping?: Readonly<Partial<Record<PermissionIntent, string | null>>>;
    }>;
    runtimeInput?: Readonly<{
        /**
         * Provider-declared support for steering a busy turn before runtime state is published.
         */
        inFlightSteerSupported?: boolean;
    }>;
    sessionModes: Readonly<{
        /**
         * How (if at all) ACP session modes should be treated for this agent.
         *
         * - none: do not surface ACP session modes as a first-class control in UI
         * - acpPolicyPresets: ACP modes exist, but represent approval/sandbox presets (not plan/build)
         * - acpAgentModes: ACP modes represent agent-level modes (e.g. plan/build) and should be user-controllable
         * - staticAgentModes: provider-native modes (e.g. Claude plan/build) that should be user-controllable
         */
        kind: 'none' | 'acpPolicyPresets' | 'acpAgentModes' | 'staticAgentModes';
        /**
         * Static mode options used when kind === 'staticAgentModes'.
         * `id: 'default'` represents "no override" / provider default.
         */
        staticOptions?: ReadonlyArray<Readonly<{
            id: string;
            nameKey: TranslationKeyNoParams;
            descriptionKey?: TranslationKeyNoParams;
        }>>;
    }>;
    /**
     * Model selection capabilities and static suggestions.
     *
     * Source of truth lives in `@happier-dev/agents` so CLI + UI don’t drift.
     * UI may still prefer dynamic ACP lists (`metadata.acpSessionModelsV1`) when present.
     */
    model: AgentModelConfig | null;
    resume: Readonly<{
        /**
         * Field in session metadata containing the vendor resume id, if supported.
         */
        vendorResumeIdField: VendorResumeIdField | null;
        /**
         * Translation keys for showing/copying the vendor resume id in the session info UI.
         * When null, the UI should not render a resume id row for this agent.
         */
        uiVendorResumeIdLabelKey: TranslationKey | null;
        uiVendorResumeIdCopiedKey: TranslationKey | null;
        /**
         * Whether this agent can be resumed from UI in principle.
         * (May still be gated by experiments in higher-level helpers.)
         */
        supportsVendorResume: boolean;
        /**
         * When true, vendor-resume support is considered experimental and must be enabled explicitly
         * by callers (e.g. via feature flags / experiments).
         */
        experimental: boolean;
    }>;
    localControl?: Readonly<{
        /**
         * When true, this agent supports a terminal-driven "local control" mode
         * that can be mirrored in the UI and switched to/from remote mode.
         */
        supported: boolean;
        /**
         * `exclusive`: local terminal owns the turn and remote input should switch or queue.
         * `shared`: local terminal is only an attached client; remote UI remains writable.
         */
        topology?: 'exclusive' | 'shared';
        /**
         * Attachment mechanism used by terminal attach flows.
         */
        attachStrategy?: 'terminal_host' | 'provider_attach' | 'unsupported';
    }>;
    toolRendering: Readonly<{
        /**
         * When true, unknown tools should be hidden/minimal to avoid noisy internal tools.
         */
        hideUnknownToolsByDefault: boolean;
    }>;
    tools: Readonly<{
        delivery: AgentToolsDelivery;
        support: AgentToolsSupportLevel;
    }>;
    sessionStorage: AgentSessionStorage;
    ui: Readonly<{
        /**
         * Icon used in agent picker UIs (Ionicons name).
         * Kept here as a string so it remains Node-safe (tests can import it).
         */
        agentPickerIconName: string;
        /**
         * Optional font size scale used for CLI glyph renderers (dingbat-based).
         */
        cliGlyphScale: number;
        /**
         * Optional font size scale used for profile compatibility glyph renderers.
         */
        profileCompatibilityGlyphScale: number;
    }>;
}>;

export const CANONICAL_AGENTS_CORE: Readonly<Partial<Record<CanonicalAgentId, AgentCoreConfig>>> = BUNDLED_CANONICAL_AGENTS_CORE;

export const AGENTS_CORE = Object.freeze({
    ...CANONICAL_AGENTS_CORE,
}) satisfies Readonly<Partial<Record<CanonicalAgentId, AgentCoreConfig>>>;

export const CANONICAL_AGENT_IDS: readonly CanonicalAgentId[] = Object.freeze(
    // Presentation membership belongs to the same generated map as its cores.
    // Shared Agent ids retain identity/facts for optional plugins whose runtime
    // or UI publication failed, so they are not a UI entry inventory.
    (Object.keys(CANONICAL_AGENTS_CORE) as CanonicalAgentId[])
        .sort((left, right) => SHARED_AGENT_IDS.indexOf(left) - SHARED_AGENT_IDS.indexOf(right)),
);

/** Same list as {@link CANONICAL_AGENT_IDS}; retained for existing UI importers. */
export const AGENT_IDS: readonly CanonicalAgentId[] = CANONICAL_AGENT_IDS;

/** Admitted presentation cores, in the same order as the UI Agent inventory. */
export const AGENT_CORE_CONFIGS: readonly AgentCoreConfig[] = Object.freeze(
    CANONICAL_AGENT_IDS.flatMap((id) => {
        const core = CANONICAL_AGENTS_CORE[id];
        return core ? [core] : [];
    }),
);

export {
    DEFAULT_AGENT_ID,
    // `@happier-dev/agents` is the single owner of Agent identity. The UI reads
    // these through the registry so no second predicate or resolver can drift
    // from the bundled generated list.
    isBundledAgentId,
    resolveAgentIdFromFlavor,
    resolveAgentIdFromSessionMetadata,
};

/**
 * UI presentation core for a bundled Agent.
 *
 * An externally installed or excluded optional Agent has no bundled UI core, so an open `AgentId`
 * resolves to `null` and the caller falls back to its plugin contribution.
 * This must never throw: a crash here takes down every session surface that
 * merely wanted a display name for an external Agent.
 */
export function getAgentCore(id: AgentId): AgentCoreConfig | null {
    return (CANONICAL_AGENTS_CORE as Partial<Record<AgentId, AgentCoreConfig>>)[id] ?? null;
}

export function getAllAgentProviderOwnedEnvironmentKeys(
    projectedAgentsById?: Readonly<Record<string, Readonly<{
        id?: string;
        providerOwnedEnvironmentKeys?: readonly string[];
    }>>> | null,
): ReadonlySet<string> {
    const keys = new Set(AGENT_CORE_CONFIGS.flatMap((core) => core.providerOwnedEnvironmentKeys ?? []));
    for (const agent of Object.values(projectedAgentsById ?? {})) {
        for (const key of agent.providerOwnedEnvironmentKeys ?? []) {
            keys.add(key);
        }
    }
    return keys;
}

export function resolveAgentIdFromCliDetectKey(detectKey: string | null | undefined): AgentId | null {
    if (typeof detectKey !== 'string') return null;
    const normalized = detectKey.trim().toLowerCase();
    if (!normalized) return null;
    for (const core of AGENT_CORE_CONFIGS) {
        if (core.cli?.detectKey === normalized) return core.id;
    }
    return null;
}

export function resolveAgentIdFromConnectedServiceId(serviceId: string | null | undefined): AgentId | null {
    if (typeof serviceId !== 'string') return null;
    const normalized = serviceId.trim().toLowerCase();
    if (!normalized) return null;
    const supportsConnectedService = (core: AgentCoreConfig): boolean => {
        const supportedServiceIds = core.connectedServices?.supportedServiceIds ?? [];
        return supportedServiceIds.some((svc) => typeof svc === 'string' && svc.toLowerCase() === normalized);
    };

    const exactCore = AGENT_CORE_CONFIGS.find((core) => core.id.toLowerCase() === normalized);
    if (exactCore && supportsConnectedService(exactCore)) {
        return exactCore.id;
    }

    for (const core of AGENT_CORE_CONFIGS) {
        if (supportsConnectedService(core)) return core.id;
    }
    return null;
}

export function formatAgentLikeIdForDisplay(id: string | null | undefined): string {
    const trimmed = String(id ?? '').trim();
    if (!trimmed) {
        return 'Unknown Backend';
    }

    const tokenized = trimmed
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[.\-_\\s]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);

    if (tokenized.length === 0) {
        return 'Unknown Backend';
    }

    return tokenized
        .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
        .join(' ');
}
