import { z } from 'zod/mini';
import type { MachineAuthorityPresentationV1 } from '@happier-dev/protocol';
import { presentPluginInstallationReviewAuthority } from './pluginInstallationReviewFacts';
import type { DaemonMergedProjectionPhase } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import { type CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import type {
    InstalledPluginCapabilityDiagnosticV1,
    InstalledPluginCapabilityDistributionV1,
    InstalledPluginCapabilityEntryV1,
    PluginDevelopmentStatusV1,
} from '@happier-dev/protocol/capabilities';
import { InstalledPluginCapabilityEntryV1Schema, PluginDevelopmentStatusV1Schema } from '@happier-dev/protocol/capabilities';
import { PluginAccountPluginIntentV1Schema } from '@happier-dev/protocol/plugins/availability';
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
import type { PluginAccountInstalledPluginsAdmission, PluginAccountInstalledPluginInstallation } from '@/sync/domains/plugins/availability/reader';
import { resolvePluginLocalizedText } from '@/sync/domains/plugins/ui/i18n';
import { BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION } from '@/agents/registry/generatedBundledPluginEntries';

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

export type InstalledPluginDiagnostic = InstalledPluginCapabilityDiagnosticV1;
export type InstalledPluginDistribution = InstalledPluginCapabilityDistributionV1;

export type InstalledPluginEntry = InstalledPluginCapabilityEntryV1 & Readonly<{
    /** Descriptive Account installation evidence; never a daemon lifecycle record. */
    accountInstallations?: readonly PluginAccountInstalledPluginInstallation[];
}>;

/** An Account installation's source class, in the installed record's source vocabulary (its locator stays on its machine). */
const ACCOUNT_INSTALLATION_SOURCE_KIND = {
    registryPackage: 'npm',
    versionedArchive: 'archive',
    gitRepository: 'git',
    localPath: 'localPath',
    bundledFirstParty: 'bundled',
} as const satisfies Record<PluginAccountInstalledPluginInstallation['materialization']['sourceClass'], string>;

/** Account discovery extends the display; the administered daemon's records stay exact. */
export function projectAccountInstalledPlugins(
    administered: readonly InstalledPluginEntry[],
    admission: PluginAccountInstalledPluginsAdmission | null,
): readonly InstalledPluginEntry[] {
    if (admission?.kind !== 'available') return administered;
    const administeredIds = new Set(administered.map((entry) => entry.pluginId));
    const observed: InstalledPluginEntry[] = [];
    for (const plugin of admission.plugins) {
        if (administeredIds.has(plugin.pluginId) || plugin.installations.length === 0) continue;
        observed.push(projectAccountInstalledPlugin(plugin));
    }
    return observed.length === 0 ? administered : Object.freeze([...administered, ...observed]);
}

/** The same recorded installation presentation for cross-kind inventory and Plugins management. */
export function projectAccountInstalledPlugin(plugin: Extract<PluginAccountInstalledPluginsAdmission, { kind: 'available' }>['plugins'][number]): InstalledPluginEntry {
        const first = plugin.installations[0]!;
        const declaration = plugin.installations.find((installation) => installation.declaration)?.declaration;
        const presentation = declaration ?? BUNDLED_FIRST_PARTY_PLUGIN_PRESENTATION[plugin.pluginId];
        const versions = [...new Set(plugin.installations.map((installation) => installation.materialization.version))];
        const trustStates = new Set(plugin.installations.map((installation) => installation.materialization.trustState));
        const trustPolicy = trustStates.size === 1
            ? first.materialization.trustState === 'trusted' ? 'trusted' : 'untrusted'
            : undefined;
        return Object.freeze({
            pluginId: plugin.pluginId,
            title: resolvePluginLocalizedText({ projection: null, pluginId: plugin.pluginId, value: presentation?.displayName })
                || plugin.pluginId,
            description: resolvePluginLocalizedText({ projection: null, pluginId: plugin.pluginId, value: presentation?.description }) || null,
            version: versions.length === 1 ? versions[0]! : '',
            enabled: plugin.installations.some((installation) => installation.materialization.enabled),
            source: { kind: ACCOUNT_INSTALLATION_SOURCE_KIND[first.materialization.sourceClass], locator: '',
                ...(trustPolicy ? { trustPolicy } : {}) },
            install: { mode: 'observed', manifestVersion: '' },
            compatibility: { status: 'unknown', diagnostics: [] },
            diagnostics: [],
            accountInstallations: plugin.installations,
        });
}

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
 * this exact installed source. Bundled package custody stays with the host;
 * desired enablement remains an ordinary lifecycle operation.
 */
export function projectInstalledPluginLifecycleCapabilities(
    installed: InstalledPluginEntry,
    scope: 'account' | 'machine' = 'machine',
): InstalledPluginLifecycleCapabilities {
    const userManaged = installed.accountInstallations === undefined && installed.source.kind !== 'bundled';
    const trusted = installed.source.trustPolicy !== 'untrusted';
    const canChangeEnablement = installed.accountInstallations === undefined;
    const enabled = scope === 'account' ? installed.accountEnabled : installed.machineEnabled ?? installed.enabled;
    return Object.freeze({
        canEnable: canChangeEnablement && enabled === false,
        canDisable: canChangeEnablement && enabled === true,
        canRollback: userManaged && installed.rollbackAvailability === 'available',
        canUninstall: userManaged,
        canForgetTrust: userManaged && trusted,
        canUpdate: userManaged && trusted,
    });
}

export type DevelopmentPluginEntry = PluginDevelopmentStatusV1['plugins'][number] & Readonly<{
    /**
     * The installed plugin this source produced. Null while the daemon has not
     * loaded it (unavailable, still preparing, no readable manifest): that source
     * still belongs on the page, since it is exactly the one its author must fix.
     */
    installed: InstalledPluginEntry | null;
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
    scope?: 'account' | 'machine';
}>;

/**
 * Why the plugin surfaces fell back to cached, read-only truth.
 *
 * `noTarget` asks for a Machine without claiming an outage. `disconnected` is the
 * selected machine being unreachable. `projectionUnavailable` is a
 * reachable machine whose contribution-registry projection failed or is not
 * served — a recoverable condition the user can retry, and one that must never
 * be reported as a disconnect. `accountRecovery` is Account-only truth with no
 * claim about a reachable machine or a retryable machine registry.
 */
export type PluginReadOnlySnapshotReason = 'noTarget' | 'disconnected' | 'projectionUnavailable' | 'installationUnavailable' | 'refreshing' | 'accountRecovery';

export type PluginReadOnlySnapshotNoticeState = Readonly<{
    reason: PluginReadOnlySnapshotReason;
}>;

export function resolvePluginReadOnlySnapshotNotice(params: Readonly<{
    hasSelectedTarget: boolean;
    daemonOperationsAvailable: boolean;
    daemonTransportOnline: boolean;
    projectionPhase: DaemonMergedProjectionPhase;
    hasCapabilitySnapshot: boolean;
    installedPluginCount: number;
    developmentPluginCount: number;
    capabilityReadFailed?: boolean;
    /**
     * The selected machine reads online, but its live connection cannot be resolved yet (the
     * Account's data is still loading). That is "checking", never "disconnected": only a resolved
     * machine that is away reads offline.
     */
    targetResolving?: boolean;
}>): PluginReadOnlySnapshotNoticeState | null {
    if (!params.hasSelectedTarget) return { reason: 'noTarget' };
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
    authority: MachineAuthorityPresentationV1;
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
    return trimmed.length > 0 ? trimmed : null;
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

function projectPendingInstallationReview(change: Extract<PluginChangePendingReviewResult, { reviewKind: 'installation' }>): PendingPluginChangeReview {
    return {
        pendingChangeId: change.pendingChangeId,
        reason: change.reason,
        currentVersion: change.currentVersion,
        authorityExpansion: change.authorityExpansion,
        review: change.review,
        authority: presentPluginInstallationReviewAuthority(change.review),
    };
}

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
            installationReview: projectPendingInstallationReview(parsed.data),
        };
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
    return projectPendingInstallationReview(parsed.data);
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

export type PluginMutationResult = Readonly<{
    kind: string | null;
    failureReason: string | null;
    managedResources: readonly ManagedResourceDependencyV1[] | null;
    registryRequirement: MarketplaceRegistryProfileRequirementV1 | null;
    disabledNoop: boolean;
}>;

/** Interpret one native response once, retaining its exact requested Action and Plugin identity. */
export function projectPluginMutationResult(
    value: unknown,
    action: PluginMarketplaceActionRequest['method'],
    expectedPluginId: string,
): PluginMutationResult {
    const empty: PluginMutationResult = { kind: null, failureReason: null, managedResources: null,
        registryRequirement: null, disabledNoop: false };
    if (!isRecord(value)) return empty;
    if ((action === 'enable' || action === 'disable') && value.scope === 'account') {
        const intent = PluginAccountPluginIntentV1Schema.safeParse(value.intent);
        return value.ok === true && value.kind === `plugins_${action}` && value.pluginId === expectedPluginId
            && intent.success && intent.data.pluginId === expectedPluginId
            && intent.data.enabled === (action === 'enable') && value.enabled === intent.data.enabled
            ? { ...empty, kind: 'committed' }
            : empty;
    }
    const nativeInstall = (action === 'install' || action === 'update') && value.kind === 'plugins_install';
    if (!nativeInstall && (value.action !== action || value.pluginId !== expectedPluginId)) return empty;
    if (action === 'disable' && value.change === null && isRecord(value.entry)
        && value.entry.pluginId === expectedPluginId && value.entry.enabled === false) {
        return { ...empty, disabledNoop: true };
    }
    const change = nativeInstall && !isRecord(value.change)
        ? value.outcome === 'applied' ? { kind: 'committed' } : { kind: 'failed' }
        : value.change;
    if (!isRecord(change) || 'pluginId' in change && change.pluginId !== expectedPluginId) return empty;
    const kind = readNonEmptyString(change.kind);
    let managedResources: PluginMutationResult['managedResources'] = null;
    let registryRequirement: PluginMutationResult['registryRequirement'] = null;
    if ((action === 'disable' || action === 'uninstall') && kind === 'managedResourcesReviewRequired'
        && change.pluginId === expectedPluginId && hasOnlyKeys(change, ['kind', 'pluginId', 'resources'])) {
        const parsed = z.array(ManagedResourceDependencyV1Schema).safeParse(change.resources);
        if (parsed.success) managedResources = parsed.data;
    }
    if ((action === 'install' || action === 'update') && kind === 'registryProfileRequired') {
        const parsed = MarketplaceRegistryProfileRequiredResultV1Schema.safeParse(change);
        if (parsed.success) {
            const { kind: _kind, ...requirement } = parsed.data;
            registryRequirement = requirement;
        }
    }
    return { kind, failureReason: kind === 'failed' ? readNonEmptyString(change.message) : null,
        managedResources, registryRequirement, disabledNoop: false };
}

function readMarketplaceCapabilityData(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
): Record<string, unknown> | null {
    const snapshot = state.status === 'loaded' || state.status === 'loading' || state.status === 'error'
        ? state.snapshot
        : null;
    const result = snapshot?.response.results[MARKETPLACE_CAPABILITY_ID];
    return result?.ok && isRecord(result.data) ? result.data : null;
}

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
        ? snapshot.response.results[MARKETPLACE_CAPABILITY_ID]
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
    const installedPlugins = readMarketplaceCapabilityData(state)?.installedPlugins;
    if (!Array.isArray(installedPlugins)) return [];
    return installedPlugins.flatMap((entry: unknown) => {
        const parsed = InstalledPluginCapabilityEntryV1Schema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

export function readDevelopmentPlugins(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
    installedPlugins: readonly InstalledPluginEntry[],
): readonly DevelopmentPluginEntry[] {
    const parsed = PluginDevelopmentStatusV1Schema.safeParse(readMarketplaceCapabilityData(state)?.developmentStatus);
    if (!parsed.success) return [];
    const developmentStatus = parsed.data;

    const installedById = new Map(installedPlugins.map((entry) => [entry.pluginId, entry] as const));
    const explicitRoots = new Set(developmentStatus.roots
        .filter((root) => root.kind === 'explicit')
        .map((root) => root.rootPath));
    // Every reported source is listed; its root, not an installation, is its identity.
    return developmentStatus.plugins.map((source) => ({
        ...source,
        installed: source.pluginId ? installedById.get(source.pluginId) ?? null : null,
        actions: Object.freeze({
            test: true,
            pack: true,
            unregister: explicitRoots.has(source.sourceRootPath),
        }),
    }));
}

/**
 * The daemon-owned changes that are already applying. Install/trust questions
 * are ordinary approval Artifacts and belong in the Inbox; projecting a raw
 * daemon review here would recreate the retired second decision owner.
 */
export function readPendingPluginChanges(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
): readonly PendingPluginChangeListing[] {
    const pendingChanges = readMarketplaceCapabilityData(state)?.pendingChanges;
    if (!Array.isArray(pendingChanges)) return [];
    return pendingChanges.flatMap((entry) => {
        const listing = readPendingPluginChangeListing(entry);
        return listing?.kind === 'applying' ? [listing] : [];
    });
}

export function readDevelopmentCreateAvailable(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
): boolean {
    const actions = readMarketplaceCapabilityData(state)?.developmentActions;
    return isRecord(actions) && actions.create === true;
}

/**
 * Whether this machine's daemon can adopt a local folder as a development
 * source. The daemon's admitted development status establishes the available
 * lifecycle; invocation and approval are owned by the development Actions.
 */
export function readDevelopmentSourceInstallAvailable(
    state: ReturnType<typeof useMachineCapabilitiesCache>['state'],
): boolean {
    return PluginDevelopmentStatusV1Schema.safeParse(readMarketplaceCapabilityData(state)?.developmentStatus).success;
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

export function formatCatalogEntryVersion(version: string | null): string | undefined {
    return version ?? undefined;
}

/** One listing's review state, as a reader names it. */
export function catalogReviewStatusLabel(entry: PluginMarketplaceCatalogEntry): string {
    if (entry.reviewStatus === null) return t('common.unknown');
    if (entry.warning === 'withdrawn') return t('settingsPlugins.discover.reviewStatus.withdrawn');
    if (entry.sourceKind === 'curated' && entry.reviewStatus === 'approved') return t('settingsPlugins.discover.reviewStatus.curated');
    return t('settingsPlugins.discover.reviewStatus.unreviewed');
}

/** A compact Browse section shows one row of cards; "All" focuses the section and shows every card. */
export const BROWSE_SECTION_PREVIEW_COUNT = 3;

/**
 * A Browse section (lab ideas-1118-platform scene 1 B): the results of one category, or, for results whose catalog
 * names none, the results of one source. Source stays the toolbar filter and the first word of each card's facts.
 */
export type BrowseSection = Readonly<{
    id: string;
    title: string;
    entries: readonly PluginMarketplaceCatalogEntry[];
    hiddenCount: number;
}>;

/** A catalog category as people read it: the catalog's word, capitalised. Browse sections and listing facts share it. */
export function browseCategoryTitle(category: string): string {
    return category.charAt(0).toLocaleUpperCase() + category.slice(1);
}

/**
 * Browse's sections for the loaded results: one per category in first-seen order (a listing sits in its first
 * category), then one per source for listings without a category. Each is compact unless it is the focused one,
 * which shows all of its cards alone; inside a section the query's own order is kept.
 */
export function projectBrowseSections(
    entries: readonly PluginMarketplaceCatalogEntry[],
    params: Readonly<{ focusedSectionId: string | null }>,
): Readonly<{
    sections: readonly BrowseSection[];
    /** The focused section if the results still carry it, else `null` (every section, compact). */
    focusedSectionId: string | null;
}> {
    const categories = new Map<string, { title: string; entries: PluginMarketplaceCatalogEntry[] }>();
    const sources = new Map<string, { title: string; entries: PluginMarketplaceCatalogEntry[] }>();
    for (const entry of entries) {
        const category = entry.categories[0];
        const [groups, id, title] = category !== undefined
            ? [categories, `category:${category}`, browseCategoryTitle(category)]
            : [sources, `source:${entry.sourceId}`, entry.sourceTitle];
        const group = groups.get(id);
        if (group) group.entries.push(entry);
        else groups.set(id, { title, entries: [entry] });
    }
    const all = [...categories, ...sources].map(([id, group]) => ({ id, ...group }));
    // A focus the current results cannot honour would render no cards, so it falls back to every section.
    const focusedSectionId = params.focusedSectionId !== null && all.some((section) => section.id === params.focusedSectionId)
        ? params.focusedSectionId
        : null;
    const sections = all
        .filter((section) => focusedSectionId === null || section.id === focusedSectionId)
        .map((section): BrowseSection => focusedSectionId !== null
            ? { ...section, hiddenCount: 0 }
            : {
                ...section,
                entries: section.entries.slice(0, BROWSE_SECTION_PREVIEW_COUNT),
                hiddenCount: Math.max(0, section.entries.length - BROWSE_SECTION_PREVIEW_COUNT),
            });
    return { sections, focusedSectionId };
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
export function pluginSourceKindLabel(kind: string): string {
    switch (kind) {
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
        sourceLabel: pluginSourceKindLabel(entry.source.kind),
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

/** The existing Installed status condition, shared by toolbar and scoped filter facts. */
export function installedPluginFilterStatus(entry: InstalledPluginEntry): Exclude<InstalledPluginStatusFilter, 'all'> {
    const statusId = resolveInstalledRowStatusId(entry);
    return statusId === 'enabled' || statusId === 'disabled' ? statusId : 'attention';
}

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
            if (installedPluginFilterStatus(entry) !== params.status) return false;
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
    title: string;
    sourcePathLabel: string;
    attentionLabel: string | null;
}>;

function readPathBaseName(path: string): string {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
}

export function projectDevelopmentPluginPresentation(
    entry: DevelopmentPluginEntry,
    homeDir?: string,
): DevelopmentPluginPresentation {
    const installed = entry.installed;
    const statusId: PluginRowStatusId = installed && installed.compatibility.status !== 'compatible'
        ? 'incompatible'
        : entry.phase === 'retained_incumbent' || entry.phase === 'unavailable'
            ? 'needsAttention'
            : !installed || installed.enabled
                ? 'enabled'
                : 'disabled';
    const diagnostic = entry.diagnostic ?? installed?.compatibility.diagnostics[0] ?? null;
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
        // A source the daemon never loaded is named by its id, else by its folder.
        title: installed?.title ?? entry.pluginId ?? readPathBaseName(entry.sourceRootPath),
        status: statusId === 'incompatible' || statusId === 'disabled'
            ? createPluginRowStatus(statusId)
            : daemonPhaseStatus,
        sourcePathLabel: formatPathRelativeToHome(entry.sourceRootPath, homeDir),
        attentionLabel: statusId === 'incompatible'
            ? readDevelopmentDiagnosticCopy(diagnostic) ?? t('settingsPlugins.rowAttention.incompatible')
            : statusId === 'needsAttention'
                ? readDevelopmentDiagnosticCopy(diagnostic)
                : null,
    });
}

/**
 * The row already shows the source folder, so a diagnostic about that folder is
 * said in the reader's language instead of repeating the daemon's English text
 * with the absolute path inside it. Other diagnostics keep the daemon's message.
 */
function readDevelopmentDiagnosticCopy(
    diagnostic: Readonly<{ code?: string; message?: string }> | null,
): string | null {
    if (diagnostic?.code === 'plugin_manifest_missing') return t('settingsPlugins.developmentDiagnostic.manifestMissing');
    if (diagnostic?.code === 'plugin_dev_project_missing') return t('settingsPlugins.developmentDiagnostic.projectMissing');
    return diagnostic?.message ?? null;
}
