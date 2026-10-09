import type { DaemonMergedProjectionPhase } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import { type CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import {
    PluginChangePendingReviewResultSchema,
    type PluginChangePendingReviewResult,
    type PluginDevelopmentProjectTrustReview,
    type PluginInstallationReview,
} from '@happier-dev/protocol/marketplace/internal';
import {
    MarketplaceRegistryProfileRequiredResultV1Schema,
    type MarketplaceRegistryProfileRequirementV1,
    type PluginUpdatePolicyV1,
} from '@happier-dev/protocol/marketplace';
import {
    ManagedResourceDependencyV1Schema,
    type ManagedResourceDependencyV1,
} from '@happier-dev/protocol/machines/managed/managedDependencyV1';

import type { PluginMarketplaceCatalogEntry } from '../readPluginMarketplaceCatalog';

export const MARKETPLACE_CAPABILITY_ID = 'tool.plugins' as CapabilityId;

/** Installed inventory and enriched detail share the selected target's read lifecycle. */
export function resolvePluginTruthReadState(params: Readonly<{
    targetOnline: boolean;
    hasExecutionTarget: boolean;
    capabilitiesLoaded: boolean;
    daemonAdministrationAvailable: boolean;
    projectionPhase: DaemonMergedProjectionPhase;
}>): Readonly<{ targetResolving: boolean; installedPluginsRead: boolean; pluginTruthSettled: boolean }> {
    const targetResolving = params.targetOnline && !params.hasExecutionTarget;
    const installedPluginsRead = (!params.hasExecutionTarget && !targetResolving)
        || (params.capabilitiesLoaded && params.daemonAdministrationAvailable);
    const pluginTruthSettled = (!params.hasExecutionTarget && !targetResolving) || (
        params.capabilitiesLoaded && params.daemonAdministrationAvailable && params.projectionPhase === 'ready'
    );
    return { targetResolving, installedPluginsRead, pluginTruthSettled };
}

/**
 * The two primary product tasks the Plugins home answers in place.
 *
 * Development and Diagnostics are deliberately NOT arms of this union: they are
 * addressable routes under the Developer group, so this screen has exactly one
 * navigation owner. When both halves lived in this union each of the two
 * segmented controls rendered with nothing selected whenever the other one held
 * the active value.
 */
export type PluginSettingsViewId = 'installed' | 'discover';

type PluginSettingsViewTranslationKey =
    | 'settingsPlugins.views.installed'
    | 'settingsPlugins.catalog.browse';

export function createPluginSettingsViews(
    translate: (key: PluginSettingsViewTranslationKey) => string,
): readonly Readonly<{ id: PluginSettingsViewId; label: string }>[] {
    return [
        { id: 'installed', label: translate('settingsPlugins.views.installed') },
        { id: 'discover', label: translate('settingsPlugins.catalog.browse') },
    ];
}

export type InstalledPluginDiagnostic = Readonly<{
    code: string;
    message: string;
    details?: unknown;
}>;

export type InstalledPluginDistribution =
    | Readonly<{ kind: 'npm'; registryOrigin: string; registryProfileId?: string; packageName: string }>
    | Readonly<{ kind: 'localPath'; canonicalPath: string }>
    | Readonly<{
        kind: 'archive';
        source: Readonly<{ kind: 'localFile'; canonicalPath: string }>
            | Readonly<{ kind: 'remoteUrl'; canonicalUrl: string }>;
        integrity: string;
    }>;

export type InstalledPluginEntry = Readonly<{
    pluginId: string;
    desiredGeneration?: string | null;
    appliedGeneration?: string | null;
    /** Verified NPM/archive acquisition SRI; local paths use generation custody. */
    admittedIntegrity?: string | null;
    title: string;
    description: string | null;
    version: string;
    enabled: boolean;
    rollbackAvailability?: 'available' | 'unavailable';
    source: Readonly<{
        kind: string;
        locator: string;
        devWatch?: boolean;
        trustPolicy?: string;
        installPolicy?: string;
        resolvedPath?: string;
    }>;
    install: Readonly<{
        mode: string;
        manifestVersion: string;
        installedPath?: string | null;
        updatePolicy?: PluginUpdatePolicyV1;
        trust?: Readonly<{
            pluginId: string;
            distribution: InstalledPluginDistribution;
            state: 'trusted';
            approvedAtMs: number;
        }>;
    }>;
    compatibility: Readonly<{
        status: string;
        diagnostics: readonly InstalledPluginDiagnostic[];
    }>;
    diagnostics: readonly InstalledPluginDiagnostic[];
}>;

export type InstalledPluginLifecycleCapabilities = Readonly<{
    canEnable: boolean;
    canDisable: boolean;
    canRollback: boolean;
    canUninstall: boolean;
    canForgetTrust: boolean;
    /**
     * Whether the canonical daemon update action can be offered from the
     * installed record alone.
     *
     * The daemon update owner reads the installed record's trusted update
     * channel; a record with no host trust left has no channel to advance, and
     * a bundled entry ships with the host. Whether that channel is *pinned* is
     * not part of the installed capability projection, so a pinned record still
     * reaches the daemon and is refused there with its own explanation rather
     * than being silently hidden here.
     */
    canUpdate: boolean;
}>;

/**
 * Projects only lifecycle operations the canonical catalog can perform for
 * this exact installed source. Bundled entries are host-derived, always-on
 * inventory: presenting ordinary install mutations for them would promise a
 * lifecycle the daemon deliberately rejects.
 */
export function projectInstalledPluginLifecycleCapabilities(
    installed: InstalledPluginEntry,
): InstalledPluginLifecycleCapabilities {
    const userManaged = installed.source.kind !== 'bundled';
    const trusted = installed.source.trustPolicy !== 'untrusted';
    return Object.freeze({
        canEnable: userManaged && !installed.enabled,
        canDisable: userManaged && installed.enabled,
        canRollback: userManaged && installed.rollbackAvailability === 'available',
        canUninstall: userManaged,
        canForgetTrust: userManaged && trusted,
        canUpdate: userManaged && trusted,
    });
}

export type DevelopmentPluginEntry = Readonly<{
    installed: InstalledPluginEntry;
    sourceRootPath: string;
    phase: 'observing' | 'preparing_dependencies' | 'compiling' | 'validating' | 'active' | 'retained_incumbent' | 'unavailable';
    occurrenceId?: string;
    uiArtifactDigest?: string;
    diagnostic?: Readonly<{ code: string; message?: string }>;
    actions: Readonly<{
        test: boolean;
        pack: boolean;
        unregister: boolean;
    }>;
}>;

export type PluginMarketplaceActionRequest = Readonly<{
    method: 'install' | 'update' | 'setUpdatePolicy' | 'rollback' | 'uninstall' | 'forgetTrust' | 'enable' | 'disable';
    pluginId: string;
    sourceId?: string;
    policy?: PluginUpdatePolicyV1;
}>;

/**
 * Why the plugin surfaces fell back to cached, read-only truth.
 *
 * `disconnected` is the machine being unreachable. `projectionUnavailable` is a
 * reachable machine whose contribution-registry projection failed or is not
 * served — a recoverable condition the user can retry, and one that must never
 * be reported as a disconnect. `accountRecovery` is Account-only truth with no
 * claim about a reachable machine or a retryable machine registry.
 */
export type PluginReadOnlySnapshotReason = 'disconnected' | 'projectionUnavailable' | 'installationUnavailable' | 'refreshing' | 'accountRecovery';

export type PluginReadOnlySnapshotNoticeState = Readonly<{
    reason: PluginReadOnlySnapshotReason;
}>;

export function resolvePluginReadOnlySnapshotNotice(params: Readonly<{
    daemonOperationsAvailable: boolean;
    daemonTransportOnline: boolean;
    projectionPhase: DaemonMergedProjectionPhase;
    hasCapabilitySnapshot: boolean;
    installedPluginCount: number;
    developmentPluginCount: number;
    hasCatalog: boolean;
    hasMarketplaceSourceRegistry: boolean;
    hasProjectionInputs: boolean;
    capabilityReadFailed?: boolean;
    /**
     * The selected machine reads online, but its live connection cannot be resolved yet (the
     * Account's data is still loading). That is "checking", never "disconnected": only a resolved
     * machine that is away reads offline.
     */
    targetResolving?: boolean;
}>): PluginReadOnlySnapshotNoticeState | null {
    if (params.targetResolving && !params.daemonTransportOnline) {
        return params.hasCapabilitySnapshot || params.installedPluginCount > 0 || params.developmentPluginCount > 0
            ? { reason: 'refreshing' }
            : null;
    }
    if (params.capabilityReadFailed) {
        return { reason: params.daemonTransportOnline ? 'installationUnavailable' : 'disconnected' };
    }
    if (params.daemonOperationsAvailable) {
        return null;
    }
    const projectionAnswered = params.projectionPhase === 'error' || params.projectionPhase === 'unsupported';
    if (params.daemonTransportOnline && !projectionAnswered) {
        return params.hasCapabilitySnapshot || params.installedPluginCount > 0 || params.developmentPluginCount > 0
            ? { reason: 'refreshing' }
            : null;
    }
    return {
        reason: params.daemonTransportOnline && projectionAnswered
            ? 'projectionUnavailable'
            : 'disconnected',
    };
}

export function isPluginMutationVisibleAfterRefresh(params: Readonly<{
    method: 'install' | 'update' | 'rollback' | 'uninstall' | 'forgetTrust' | 'disable';
    pluginId: string;
    before: InstalledPluginEntry | null;
    after: InstalledPluginEntry | null;
    targetVersion: string | null;
}>): boolean {
    if (params.method === 'uninstall') {
        return params.after === null;
    }
    if (params.method === 'disable') {
        return params.after?.pluginId === params.pluginId && params.after.enabled === false;
    }
    if (params.method === 'forgetTrust') {
        return params.after?.source.trustPolicy === 'untrusted' && params.after.enabled === false;
    }
    if (params.method === 'install') {
        return params.before === null
            && params.after?.pluginId === params.pluginId
            && (params.targetVersion === null || params.after.version === params.targetVersion);
    }
    if (!params.before || !params.after || params.after.pluginId !== params.pluginId) {
        return false;
    }
    if (params.method === 'update' && params.targetVersion !== null) {
        return params.after.version === params.targetVersion
            && params.after.version !== params.before.version;
    }
    // An update the user never reviewed a candidate for has no caller-known
    // target: the canonical update owner reads the installed record, enforces its
    // policy and selects the newest compatible version, which is not the version
    // any catalog listing happens to advertise. The installed record advancing is
    // therefore the only honest evidence the change landed.
    return params.after.version !== params.before.version
        || params.after.admittedIntegrity !== params.before.admittedIntegrity
        || params.after.desiredGeneration !== params.before.desiredGeneration
        || params.after.appliedGeneration !== params.before.appliedGeneration;
}

/**
 * UI-local decision projection over the protocol-owned serialized review.
 *
 * The wire schema for the review facts themselves is
 * `PluginInstallationReviewSchema` in `@happier-dev/protocol/marketplace/internal`:
 * the daemon projects it, the CLI control client parses it, and this model
 * parses the exact same schema. Only the daemon-issued pending id beside the
 * parsed review is a UI-local carrier.
 */
export type PendingPluginChangeReview = Readonly<{
    pendingChangeId: string;
    reason: 'firstInstall' | 'authorityExpansion';
    currentVersion: string | null;
    authorityExpansion: Extract<PluginChangePendingReviewResult, Readonly<{
        kind: 'reviewRequired';
        reviewKind: 'installation';
    }>>['authorityExpansion'];
    review: PluginInstallationReview;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 32_768 ? trimmed : null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Authorization to evaluate executable code from a local development source
 * root, before any package is reviewed or committed.
 *
 * This is deliberately a separate decision from `PendingPluginChangeReview`:
 * the user is being asked about a **filesystem location**, not about a package
 * identity, digests or host access — none of which exist yet, because the
 * daemon has not been allowed to read that root. The locator is the whole
 * security payload, so it is carried verbatim and shown verbatim.
 */
export type PendingPluginDevelopmentProjectTrustReview = Readonly<{
    pendingChangeId: string;
    review: PluginDevelopmentProjectTrustReview;
}>;

export function readPluginDevelopmentProjectTrustReviewChange(
    change: unknown,
): PendingPluginDevelopmentProjectTrustReview | null {
    if (!isRecord(change) || change.kind !== 'reviewRequired') return null;
    const parsed = PluginChangePendingReviewResultSchema.safeParse(change);
    if (!parsed.success || parsed.data.reviewKind !== 'projectTrust') return null;
    return {
        pendingChangeId: parsed.data.pendingChangeId,
        review: parsed.data.review,
    };
}

/**
 * A daemon-issued change that is waiting on a present user, in the exactly two
 * shapes a present user can be asked about: trust this folder, or install and
 * trust this package.
 *
 * This is the one reader for that pair. Every place a pending change reaches
 * the app — the result of a change this app started, the enumeration of changes
 * some other client prepared, and the by-id status rejoin — parses it here, so
 * the decision a screen offers can never disagree with the stage the daemon is
 * actually at.
 */
export type PendingPluginChangeDecision =
    | Readonly<{ kind: 'projectTrust'; projectTrustReview: PendingPluginDevelopmentProjectTrustReview }>
    | Readonly<{ kind: 'installation'; installationReview: PendingPluginChangeReview }>;

export function readPendingPluginChangeDecision(change: unknown): PendingPluginChangeDecision | null {
    if (!isRecord(change)) return null;
    const parsed = PluginChangePendingReviewResultSchema.safeParse(change);
    if (!parsed.success) return null;
    return parsed.data.reviewKind === 'projectTrust'
        ? {
            kind: 'projectTrust',
            projectTrustReview: {
                pendingChangeId: parsed.data.pendingChangeId,
                review: parsed.data.review,
            },
        }
        : {
            kind: 'installation',
            installationReview: {
                pendingChangeId: parsed.data.pendingChangeId,
                reason: parsed.data.reason,
                currentVersion: parsed.data.currentVersion,
                authorityExpansion: parsed.data.authorityExpansion,
                review: parsed.data.review,
            },
        };
}

/** The daemon-issued id of whichever decision this change is currently at. */
export function readPendingPluginChangeDecisionId(decision: PendingPluginChangeDecision): string {
    return decision.kind === 'projectTrust'
        ? decision.projectTrustReview.pendingChangeId
        : decision.installationReview.pendingChangeId;
}

/**
 * The three outcomes `tool.plugins#develop` can hand back for a present user to
 * decide. `develop` has no caller-known plugin id — the daemon derives it from
 * the source root only after the root is trusted — so this reader keys on the
 * action and never on an expected identity.
 */
export type PluginDevelopChange =
    | PendingPluginChangeDecision
    | Readonly<{ kind: 'committed' }>;

export function readPluginDevelopChange(value: unknown): PluginDevelopChange | null {
    if (!isRecord(value) || value.action !== 'develop' || !isRecord(value.change)) return null;
    const decision = readPendingPluginChangeDecision(value.change);
    if (decision) return decision;
    return value.change.kind === 'committed' ? { kind: 'committed' } : null;
}

/**
 * One entry of the daemon's outstanding-decision enumeration.
 *
 * `applying` is listed rather than hidden: a change that is mid-apply is still
 * this user's change, and silently omitting it would make a decision they just
 * made look like it vanished.
 */
export type PendingPluginChangeListing =
    | PendingPluginChangeDecision
    | Readonly<{ kind: 'applying'; pendingChangeId: string }>;

export function readPendingPluginChangeListing(value: unknown): PendingPluginChangeListing | null {
    if (!isRecord(value)) return null;
    if (value.kind === 'applying') {
        const pendingChangeId = readNonEmptyString(value.pendingChangeId);
        return pendingChangeId && hasOnlyKeys(value, ['kind', 'pendingChangeId'])
            ? { kind: 'applying', pendingChangeId }
            : null;
    }
    return readPendingPluginChangeDecision(value);
}

export function readPendingPluginChangeListingId(entry: PendingPluginChangeListing): string {
    return entry.kind === 'applying' ? entry.pendingChangeId : readPendingPluginChangeDecisionId(entry);
}

/**
 * The by-id rejoin, projected verbatim from the daemon change owner.
 *
 * A listing snapshot is a projection that can be minutes old. Before a user is
 * asked to approve anything, the change is re-read at its owner, which is the
 * only place that can say the honest arms: still applying, already expired, or
 * the daemon that held it is gone.
 */
export type PendingPluginChangeStatus =
    | PendingPluginChangeDecision
    | Readonly<{ kind: 'applying'; pendingChangeId: string }>
    | Readonly<{ kind: 'terminal'; pendingChangeId: string; outcome: string; pluginId: string | null }>
    | Readonly<{ kind: 'expired' }>
    | Readonly<{ kind: 'daemonUnavailable' }>;

export function readPendingPluginChangeStatus(result: unknown): PendingPluginChangeStatus | null {
    if (!isRecord(result) || result.action !== 'changeStatus' || !isRecord(result.status)) return null;
    const status = result.status;
    const decision = readPendingPluginChangeDecision(status);
    if (decision) return decision;
    if (status.kind === 'expired' || status.kind === 'daemonUnavailable') return { kind: status.kind };
    const pendingChangeId = readNonEmptyString(status.pendingChangeId);
    if (!pendingChangeId) return null;
    if (status.kind === 'applying') return { kind: 'applying', pendingChangeId };
    if (status.kind !== 'terminal' || !isRecord(status.result)) return null;
    const outcome = readNonEmptyString(status.result.kind);
    if (!outcome) return null;
    // The terminal result names the affected plugin when the daemon knows it,
    // so a terminal `committed`/`outcomeUnknown` answer can be reconciled
    // against that exact installed record instead of shown as a bare failure.
    return {
        kind: 'terminal',
        pendingChangeId,
        outcome,
        pluginId: readNonEmptyString(status.result.pluginId),
    };
}

/**
 * Reads the daemon's bare `reviewRequired` change through the one cross-process
 * review schema owned by `@happier-dev/protocol/marketplace/internal` — the
 * same schema the daemon projects and the CLI control client parses. Both the
 * capability-invoke envelope and an authority-expansion follow-up carry the
 * identical change shape, so they share this one reader.
 */
export function readPluginInstallationReviewChange(
    change: unknown,
    expectedPluginId: string | null,
): PendingPluginChangeReview | null {
    if (!isRecord(change) || change.kind !== 'reviewRequired') return null;
    const parsed = PluginChangePendingReviewResultSchema.safeParse(change);
    if (!parsed.success || parsed.data.reviewKind !== 'installation') return null;
    if (expectedPluginId !== null && parsed.data.review.pluginId !== expectedPluginId) return null;
    return {
        pendingChangeId: parsed.data.pendingChangeId,
        reason: parsed.data.reason,
        currentVersion: parsed.data.currentVersion,
        authorityExpansion: parsed.data.authorityExpansion,
        review: parsed.data.review,
    };
}

export function readPendingPluginChangeReview(
    value: unknown,
    action: 'install' | 'update',
    expectedPluginId: string,
): PendingPluginChangeReview | null {
    if (
        !isRecord(value)
        || value.action !== action
        || value.pluginId !== expectedPluginId
        || !isRecord(value.change)
    ) return null;
    return readPluginInstallationReviewChange(value.change, expectedPluginId);
}

/**
 * The registry selection a marketplace install or update owes before the
 * daemon will fetch anything, read from the change owner's typed result.
 */
export function readPluginRegistryProfileRequirement(
    value: unknown,
    action: 'install' | 'update',
    expectedPluginId: string,
): MarketplaceRegistryProfileRequirementV1 | null {
    if (
        !isRecord(value)
        || value.action !== action
        || value.pluginId !== expectedPluginId
    ) return null;
    const parsed = MarketplaceRegistryProfileRequiredResultV1Schema.safeParse(value.change);
    if (!parsed.success) return null;
    const { kind: _kind, ...requirement } = parsed.data;
    return requirement;
}

export function readPluginChangeKind(
    value: unknown,
    action: PluginMarketplaceActionRequest['method'],
    expectedPluginId: string,
): string | null {
    if (
        !isRecord(value)
        || value.action !== action
        || value.pluginId !== expectedPluginId
        || !isRecord(value.change)
        || ('pluginId' in value.change && value.change.pluginId !== expectedPluginId)
    ) return null;
    return readNonEmptyString(value.change.kind);
}

/** Only the daemon's exact, strict recovery census can become a removal acknowledgment. */
export function readPluginManagedResourceRemovalReview(
    value: unknown,
    action: 'disable' | 'uninstall',
    expectedPluginId: string,
): readonly ManagedResourceDependencyV1[] | null {
    if (readPluginChangeKind(value, action, expectedPluginId) !== 'managedResourcesReviewRequired'
        || !isRecord(value) || !isRecord(value.change)
        || value.change.pluginId !== expectedPluginId
        || !hasOnlyKeys(value.change, ['kind', 'pluginId', 'resources'])) return null;
    const parsed = ManagedResourceDependencyV1Schema.array().safeParse(value.change.resources);
    return parsed.success ? parsed.data : null;
}

/** The canonical capability owner returns its current disabled entry when no change was needed. */
export function isPluginDisableNoopResult(value: unknown, expectedPluginId: string): boolean {
    return isRecord(value) && value.action === 'disable' && value.pluginId === expectedPluginId
        && value.change === null && isRecord(value.entry)
        && value.entry.pluginId === expectedPluginId && value.entry.enabled === false;
}

type MarketplaceCapabilitySnapshot = Readonly<{
    response: {
        protocolVersion: 1;
        results: Partial<Record<CapabilityId, Readonly<{
            ok: true;
            checkedAt: number;
            data?: {
                installedPlugins?: readonly InstalledPluginEntry[];
                developmentActions?: Readonly<{ create: boolean; develop?: boolean; unregister?: boolean }>;
                developmentStatus?: Readonly<{
                    roots: readonly Readonly<{
                        kind: 'home' | 'workspace' | 'explicit';
                        rootPath: string;
                        trusted: boolean;
                        persisted: boolean;
                    }>[];
                    plugins: readonly Readonly<{
                        pluginId?: string;
                        sourceRootPath: string;
                        phase: DevelopmentPluginEntry['phase'];
                        occurrenceId?: string;
                        uiArtifactDigest?: string;
                        diagnostic?: Readonly<{ code: string; message?: string }>;
                    }>[];
                }>;
                /**
                 * Daemon-owned outstanding decisions, projected verbatim. A
                 * machine whose snapshot predates the enumeration reports
                 * nothing, so the section stays absent instead of claiming
                 * there is nothing to decide.
                 */
                pendingChanges?: readonly unknown[];
            } | null;
        }>>>;
    };
}>;

/**
 * The two operation ceilings derived from one current daemon capability fact.
 *
 * Source and npm-registry administration call their exact daemon RPCs and do
 * not consume the contribution-registry projection. Plugin lifecycle and
 * discovery do consume that projection, so they retain the stronger ceiling.
 * Keeping both answers here prevents individual screens from independently
 * deciding what a loading or failed projection means.
 */
export function resolvePluginDaemonOperationsAvailability(params: Readonly<{
    hasExactExecutionTarget: boolean;
    daemonTransportOnline: boolean;
    capabilityStateIsCurrent: boolean;
    capabilityState: ReturnType<typeof useMachineCapabilitiesCache>['state'];
    projectionPhase: DaemonMergedProjectionPhase;
}>): Readonly<{
    administration: boolean;
    projection: boolean;
}> {
    const snapshot = params.capabilityState.status === 'loaded'
        ? params.capabilityState.snapshot
        : null;
    const toolPlugins = snapshot
        ? (snapshot as MarketplaceCapabilitySnapshot).response.results[MARKETPLACE_CAPABILITY_ID]
        : null;
    const administration = params.hasExactExecutionTarget
        && params.daemonTransportOnline
        && params.capabilityStateIsCurrent
        && toolPlugins?.ok === true;
    return {
        administration,
        projection: administration && params.projectionPhase === 'ready',
    };
}

export function readInstalledPlugins(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
): readonly InstalledPluginEntry[] {
    const snapshot = state.status === 'loaded' || state.status === 'loading' || state.status === 'error'
        ? state.snapshot
        : null;
    if (!snapshot) return [];

    const toolPlugins = (snapshot as MarketplaceCapabilitySnapshot).response.results[MARKETPLACE_CAPABILITY_ID];
    if (!toolPlugins?.ok || !toolPlugins.data || typeof toolPlugins.data !== 'object') return [];

    const installedPlugins = toolPlugins.data.installedPlugins;
    return Array.isArray(installedPlugins) ? installedPlugins : [];
}

export function readDevelopmentPlugins(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
    installedPlugins: readonly InstalledPluginEntry[],
): readonly DevelopmentPluginEntry[] {
    const snapshot = state.status === 'loaded' || state.status === 'loading' || state.status === 'error'
        ? state.snapshot
        : null;
    if (!snapshot) return [];
    const toolPlugins = (snapshot as MarketplaceCapabilitySnapshot).response.results[MARKETPLACE_CAPABILITY_ID];
    const developmentStatus = toolPlugins?.ok && toolPlugins.data && typeof toolPlugins.data === 'object'
        ? toolPlugins.data.developmentStatus
        : null;
    if (!developmentStatus || !Array.isArray(developmentStatus.plugins)) return [];

    const installedById = new Map(installedPlugins.map((entry) => [entry.pluginId, entry] as const));
    const unregisterAvailable = toolPlugins?.ok === true
        && toolPlugins.data !== null
        && typeof toolPlugins.data === 'object'
        && toolPlugins.data.developmentActions?.unregister === true;
    const explicitRoots = new Set(developmentStatus.roots
        .filter((root) => root.kind === 'explicit')
        .map((root) => root.rootPath));
    return developmentStatus.plugins.flatMap((source) => {
        if (!source.pluginId) return [];
        const installed = installedById.get(source.pluginId);
        return installed ? [{
            ...source,
            installed,
            actions: Object.freeze({
                test: true,
                pack: true,
                unregister: unregisterAvailable && explicitRoots.has(source.sourceRootPath),
            }),
        }] : [];
    });
}

/**
 * The changes this machine's daemon is still waiting on a present user for.
 *
 * A change an Agent prepared has no caller left to hand its issued id to, so
 * this read is the only way it becomes visible in the app at all. Entries the
 * app cannot fully type are dropped rather than shown: a user must never be
 * asked to approve a payload their client could not read.
 */
export function readPendingPluginChanges(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
): readonly PendingPluginChangeListing[] {
    const snapshot = state.status === 'loaded' || state.status === 'loading' || state.status === 'error'
        ? state.snapshot
        : null;
    if (!snapshot) return [];
    const toolPlugins = (snapshot as MarketplaceCapabilitySnapshot).response.results[MARKETPLACE_CAPABILITY_ID];
    const pendingChanges = toolPlugins?.ok && toolPlugins.data && typeof toolPlugins.data === 'object'
        ? toolPlugins.data.pendingChanges
        : null;
    if (!Array.isArray(pendingChanges)) return [];
    return pendingChanges.flatMap((entry) => {
        const listing = readPendingPluginChangeListing(entry);
        return listing ? [listing] : [];
    });
}

export function readDevelopmentCreateAvailable(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
): boolean {
    const snapshot = state.status === 'loaded' || state.status === 'loading' || state.status === 'error'
        ? state.snapshot
        : null;
    if (!snapshot) return false;
    const toolPlugins = (snapshot as MarketplaceCapabilitySnapshot).response.results[MARKETPLACE_CAPABILITY_ID];
    return toolPlugins?.ok === true
        && toolPlugins.data !== null
        && typeof toolPlugins.data === 'object'
        && toolPlugins.data.developmentActions?.create === true;
}

/**
 * Whether this machine's daemon can adopt a local folder as a development
 * source. It fails closed: a machine whose capability snapshot predates the
 * `develop` action advertises nothing, and the affordance stays disabled rather
 * than sending a method the daemon would reject.
 */
export function readDevelopmentSourceInstallAvailable(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
): boolean {
    const snapshot = state.status === 'loaded' || state.status === 'loading' || state.status === 'error'
        ? state.snapshot
        : null;
    if (!snapshot) return false;
    const toolPlugins = (snapshot as MarketplaceCapabilitySnapshot).response.results[MARKETPLACE_CAPABILITY_ID];
    return toolPlugins?.ok === true
        && toolPlugins.data !== null
        && typeof toolPlugins.data === 'object'
        && toolPlugins.data.developmentActions?.develop === true;
}

/**
 * Reads the deterministic scaffold result the canonical `create` action
 * returns. The returned source root is the only authoritative answer for
 * where the scaffolded plugin now lives; a caller that re-derived the folder
 * it typed into a prompt could disagree with what the daemon actually created.
 */
export function readPluginCreateResult(value: unknown): Readonly<{ pluginId: string; sourceRootPath: string }> | null {
    if (!isRecord(value) || value.action !== 'create') return null;
    const pluginId = readNonEmptyString(value.pluginId);
    const sourceRootPath = readNonEmptyString(value.sourceRootPath);
    return pluginId !== null && sourceRootPath !== null
        ? { pluginId, sourceRootPath }
        : null;
}

/**
 * Reads the selected daemon's current Edit-with-Agent target.
 *
 * `sourceRootPath` is the exact admitted subject (a directory or a single
 * source file). `sessionDirectory` is the daemon-canonicalized directory the
 * ordinary New Session composer may use as its cwd.
 */
export function readPluginEditTargetResult(
    value: unknown,
    expectedPluginId: string,
): Readonly<{ pluginId: string; sourceRootPath: string; sessionDirectory: string }> | null {
    if (!isRecord(value) || value.action !== 'edit' || !hasOnlyKeys(
        value,
        ['action', 'pluginId', 'sourceRootPath', 'sessionDirectory'],
    )) return null;
    const pluginId = readNonEmptyString(value.pluginId);
    const sourceRootPath = readNonEmptyString(value.sourceRootPath);
    const sessionDirectory = readNonEmptyString(value.sessionDirectory);
    return pluginId === expectedPluginId && sourceRootPath !== null && sessionDirectory !== null
        ? { pluginId, sourceRootPath, sessionDirectory }
        : null;
}

/**
 * What a listed pending change is asking for, in the user's own terms. The
 * locator and the package identity are the whole security payload of the two
 * decisions, so both are shown verbatim rather than summarised away.
 */
export function formatPendingPluginChangeTitle(entry: PendingPluginChangeListing): string {
    if (entry.kind === 'applying') return t('settingsPlugins.pendingChangeApplying');
    return entry.kind === 'projectTrust'
        ? t('settingsPlugins.developmentTrustProjectSourceTitle')
        : t('settingsPlugins.marketplaceInstallReviewTitle', {
            name: entry.installationReview.review.displayName,
            version: entry.installationReview.review.version,
        });
}

export function formatPendingPluginChangeSubtitle(entry: PendingPluginChangeListing): string {
    if (entry.kind === 'applying') return entry.pendingChangeId;
    return entry.kind === 'projectTrust'
        ? t('settingsPlugins.pendingChangeSourceRootSubtitle', {
            path: entry.projectTrustReview.review.source.locator,
        })
        : t('settingsPlugins.pendingChangeInstallSubtitle', {
            pluginId: entry.installationReview.review.pluginId,
            source: entry.installationReview.review.source.locator,
        });
}

export function formatCatalogEntryVersion(version: string | null): string | undefined {
    return version ?? undefined;
}

/** One listing's review state, as a reader names it. */
export function catalogReviewStatusLabel(entry: PluginMarketplaceCatalogEntry): string {
    if (entry.warning === 'withdrawn') return t('settingsPlugins.discover.reviewStatus.withdrawn');
    if (entry.sourceKind === 'curated' && entry.reviewStatus === 'approved') return t('settingsPlugins.discover.reviewStatus.curated');
    return t('settingsPlugins.discover.reviewStatus.unreviewed');
}

/** A Browse shelf: the results of one provenance, which carries real trust meaning. */
export type DiscoverShelf = Readonly<{
    id: PluginMarketplaceCatalogEntry['sourceKind'];
    entries: readonly PluginMarketplaceCatalogEntry[];
}>;

/**
 * Reviewed listings lead, the user's own sources follow, and unreviewed community packages come
 * last; inside a shelf the query's own order is kept, and a provenance with no results has no shelf.
 */
const DISCOVER_SHELF_ORDER = ['curated', 'user', 'community-npm'] as const satisfies readonly DiscoverShelf['id'][];

export function groupDiscoverEntriesByShelf(entries: readonly PluginMarketplaceCatalogEntry[]): readonly DiscoverShelf[] {
    return DISCOVER_SHELF_ORDER
        .map((id) => ({ id, entries: entries.filter((entry) => entry.sourceKind === id) }))
        .filter((shelf) => shelf.entries.length > 0);
}

/** A compact shelf shows one row of cards; "See all" focuses the shelf and shows every card. */
export const BROWSE_SHELF_PREVIEW_COUNT = 3;

export type BrowseShelfView = DiscoverShelf & Readonly<{ hiddenCount: number }>;

/**
 * What Browse shows for the loaded results: the categories they carry (the chips, first-seen
 * order; none when the catalog has none), and the shelves narrowed to the chosen category — each
 * compact unless it is the focused one, which shows all of its cards alone.
 */
export function projectBrowseShelves(
    entries: readonly PluginMarketplaceCatalogEntry[],
    params: Readonly<{ category: string | null; focusedShelfId: DiscoverShelf['id'] | null }>,
): Readonly<{
    categories: readonly string[];
    shelves: readonly BrowseShelfView[];
    /** The chosen category if the results still carry it, else `null` (All). */
    category: string | null;
    /** The focused shelf if it still has results in `category`, else `null` (every shelf, compact). */
    focusedShelfId: DiscoverShelf['id'] | null;
}> {
    const categories: string[] = [];
    for (const entry of entries) {
        for (const category of entry.categories) {
            if (!categories.includes(category)) categories.push(category);
        }
    }
    // A chip or a focus the current results cannot honour would render no cards at all, so both
    // fall back to the whole result set rather than an empty grid.
    const category = params.category !== null && categories.includes(params.category) ? params.category : null;
    const matching = category === null ? entries : entries.filter((entry) => entry.categories.includes(category));
    const grouped = groupDiscoverEntriesByShelf(matching);
    const focusedShelfId = params.focusedShelfId !== null && grouped.some((shelf) => shelf.id === params.focusedShelfId)
        ? params.focusedShelfId
        : null;
    const shelves = grouped
        .filter((shelf) => focusedShelfId === null || shelf.id === focusedShelfId)
        .map((shelf): BrowseShelfView => {
            if (focusedShelfId !== null) return { ...shelf, hiddenCount: 0 };
            return {
                id: shelf.id,
                entries: shelf.entries.slice(0, BROWSE_SHELF_PREVIEW_COUNT),
                hiddenCount: Math.max(0, shelf.entries.length - BROWSE_SHELF_PREVIEW_COUNT),
            };
        });
    return { categories, shelves, category, focusedShelfId };
}

/**
 * The one Discover query's filters: All sends no source filter (the daemon aggregates every
 * enabled source), a source narrows it, and a listing page resolves one exact source-qualified
 * listing through the same query.
 */
export function buildDiscoverQueryFilters(params: Readonly<{ sourceId: string | null; pluginId?: string | null }>) {
    return {
        ...(params.sourceId === null ? {} : { sourceIds: [params.sourceId] }),
        ...(params.pluginId ? { pluginIds: [params.pluginId] } : {}),
        includeUnavailable: true as const,
    };
}

/**
 * One row's state vocabulary, shared by the Installed and Development lists.
 *
 * A row states ONE status and, when something needs a decision, ONE actionable
 * consequence. Raw compatibility codes, source kinds and diagnostic codes are
 * technical evidence: they belong under Details and Diagnostics, never
 * concatenated into a subtitle a reader has to parse.
 */
export type PluginRowStatusId =
    | 'enabled'
    | 'disabled'
    | 'incompatible'
    | 'trustRemoved'
    | 'needsAttention';

export type PluginRowStatus = Readonly<{
    id: PluginRowStatusId;
    label: string;
    variant: StatusPillVariant;
}>;

const PLUGIN_ROW_STATUS_VARIANTS = {
    enabled: 'success',
    disabled: 'neutral',
    incompatible: 'warning',
    trustRemoved: 'danger',
    needsAttention: 'warning',
} as const satisfies Readonly<Record<PluginRowStatusId, StatusPillVariant>>;

function createPluginRowStatus(id: PluginRowStatusId): PluginRowStatus {
    return Object.freeze({
        id,
        label: t(`settingsPlugins.rowStatus.${id}` as 'settingsPlugins.rowStatus.enabled'),
        variant: PLUGIN_ROW_STATUS_VARIANTS[id],
    });
}

/**
 * Ordered by authority, then admissibility, then health, then user intent:
 * trust the user withdrew outranks a compatibility refusal, which outranks a
 * reported defect, which outranks a plugin the user simply turned off.
 */
function resolveInstalledRowStatusId(entry: InstalledPluginEntry): PluginRowStatusId {
    if (entry.source.trustPolicy === 'untrusted') return 'trustRemoved';
    if (entry.compatibility.status !== 'compatible') return 'incompatible';
    if (entry.diagnostics.length > 0 || entry.compatibility.diagnostics.length > 0) return 'needsAttention';
    return entry.enabled ? 'enabled' : 'disabled';
}

/** A concise origin label. The exact locator stays on the plugin detail route. */
function resolveInstalledSourceLabel(entry: InstalledPluginEntry): string {
    switch (entry.source.kind) {
        case 'bundled':
            return t('settingsPlugins.rowSource.bundled');
        case 'npm':
            return t('settingsPlugins.rowSource.npm');
        case 'archive':
            return t('settingsPlugins.rowSource.archive');
        case 'path':
        case 'localPath':
            return t('settingsPlugins.rowSource.localPath');
        default:
            return t('settingsPlugins.rowSource.other');
    }
}

export type InstalledPluginPresentation = Readonly<{
    status: PluginRowStatus;
    sourceLabel: string;
    /** One human consequence when the row needs a decision, else `null`. */
    attentionLabel: string | null;
}>;

export function projectInstalledPluginPresentation(
    entry: InstalledPluginEntry,
): InstalledPluginPresentation {
    const statusId = resolveInstalledRowStatusId(entry);
    // The canonical diagnostic message is already written for a reader; its
    // `code` is not, so only the message reaches the row.
    const diagnostic = entry.diagnostics[0] ?? entry.compatibility.diagnostics[0] ?? null;
    const attentionLabel = statusId === 'trustRemoved'
        ? t('settingsPlugins.rowAttention.trustRemoved')
        : statusId === 'incompatible'
            ? diagnostic?.message ?? t('settingsPlugins.rowAttention.incompatible')
            : statusId === 'needsAttention'
                ? diagnostic?.message ?? null
                : null;
    return Object.freeze({
        status: createPluginRowStatus(statusId),
        sourceLabel: resolveInstalledSourceLabel(entry),
        attentionLabel,
    });
}

/**
 * The version a reader is shown for an installed plugin, or none: a plugin that ships with Happier
 * has no version of its own to speak of, and "0.0.0" is a raw placeholder, never a version.
 */
export function installedPluginVersionLabel(entry: InstalledPluginEntry): string | null {
    if (entry.source.kind === 'bundled') return null;
    const version = entry.version.trim();
    return version.length > 0 && version !== '0.0.0' ? version : null;
}

/** The plugins the user added (the Installed collection) and the ones that ship with Happier. */
/**
 * Whether a plugin ships inside Happier (bundled first-party): the installed record's source when the
 * machine listed it, else the contribution projection's provenance.
 */
export function isPluginIncludedWithHappier(params: Readonly<{
    installed?: Readonly<{ source: Readonly<{ kind: string }> }> | null;
    projection?: Readonly<{ provenance: Readonly<{ sourceKind: string | null }> | null }> | null;
}>): boolean {
    if (params.installed) return params.installed.source.kind === 'bundled';
    return params.projection?.provenance?.sourceKind === 'bundled';
}

export function partitionInstalledPlugins(entries: readonly InstalledPluginEntry[]): Readonly<{
    added: readonly InstalledPluginEntry[];
    included: readonly InstalledPluginEntry[];
}> {
    const added: InstalledPluginEntry[] = [];
    const included: InstalledPluginEntry[] = [];
    for (const entry of entries) (isPluginIncludedWithHappier({ installed: entry }) ? included : added).push(entry);
    return { added, included };
}

export type InstalledPluginStatusFilter = 'all' | 'enabled' | 'disabled' | 'attention';

/**
 * The Installed view's search and status filter over the machine's installed plugins. Status
 * follows the one the row shows (`projectInstalledPluginPresentation`): "attention" is every row
 * that needs a decision. An empty query with no status filter returns the list itself.
 */
export function filterInstalledPlugins(
    entries: readonly InstalledPluginEntry[],
    params: Readonly<{ query: string; status: InstalledPluginStatusFilter }>,
): readonly InstalledPluginEntry[] {
    const query = params.query.trim().toLocaleLowerCase();
    if (!query && params.status === 'all') return entries;
    return entries.filter((entry) => {
        if (params.status !== 'all') {
            const statusId = resolveInstalledRowStatusId(entry);
            const matchesStatus = params.status === 'attention'
                ? statusId !== 'enabled' && statusId !== 'disabled'
                : statusId === params.status;
            if (!matchesStatus) return false;
        }
        if (!query) return true;
        return [entry.title, entry.description ?? '', entry.pluginId]
            .some((text) => text.toLocaleLowerCase().includes(query));
    });
}

export type DevelopmentPluginPresentation = Readonly<{
    status: PluginRowStatus;
    /**
     * The daemon-canonical development root for the exact selected machine,
     * shown through the one repository home-relative formatter so it reads the
     * same way an ordinary Session working directory does.
     */
    sourcePathLabel: string;
    attentionLabel: string | null;
}>;

export function projectDevelopmentPluginPresentation(
    entry: DevelopmentPluginEntry,
    homeDir?: string,
): DevelopmentPluginPresentation {
    const statusId: PluginRowStatusId = entry.installed.compatibility.status !== 'compatible'
        ? 'incompatible'
        : entry.phase === 'retained_incumbent' || entry.phase === 'unavailable'
            ? 'needsAttention'
            : entry.installed.enabled
                ? 'enabled'
                : 'disabled';
    const diagnostic = entry.diagnostic ?? entry.installed.compatibility.diagnostics[0] ?? null;
    const phaseKey = {
        observing: 'observing',
        preparing_dependencies: 'preparingDependencies',
        compiling: 'compiling',
        validating: 'validating',
        active: 'active',
        retained_incumbent: 'retainedIncumbent',
        unavailable: 'unavailable',
    } as const;
    const phaseVariant: StatusPillVariant = entry.phase === 'active'
        ? 'success'
        : entry.phase === 'retained_incumbent'
            ? 'warning'
            : entry.phase === 'unavailable'
                ? 'danger'
                : 'neutral';
    const daemonPhaseStatus = Object.freeze({
        id: statusId,
        label: t(`settingsPlugins.developmentPhase.${phaseKey[entry.phase]}`),
        variant: phaseVariant,
    });
    return Object.freeze({
        status: statusId === 'incompatible' || statusId === 'disabled'
            ? createPluginRowStatus(statusId)
            : daemonPhaseStatus,
        sourcePathLabel: formatPathRelativeToHome(entry.sourceRootPath, homeDir),
        attentionLabel: statusId === 'incompatible'
            ? diagnostic?.message ?? t('settingsPlugins.rowAttention.incompatible')
            : statusId === 'needsAttention'
                ? diagnostic?.message ?? null
                : null,
    });
}
