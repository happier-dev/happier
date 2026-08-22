import {
    ConnectedAccountMaterializationRequestSchema,
    ConnectedAccountPurposeIdSchema,
    PluginContributionIdentityV1Schema,
    VoiceCredentialAccessPhaseSchema,
    VoiceCredentialSlotIdSchema,
    type ConnectedAccountMaterializationRequest,
} from '@happier-dev/protocol';

import type { DaemonMergedProjectionPhase } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { type CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { t } from '@/text';

import type { PluginMarketplaceCatalog } from '../readPluginMarketplaceCatalog';

export const MARKETPLACE_CAPABILITY_ID = 'tool.plugins' as CapabilityId;

export type PluginSettingsViewId = 'installed' | 'discover' | 'development' | 'diagnostics';

type PluginSettingsViewTranslationKey =
    | 'settingsPlugins.views.installed'
    | 'settingsPlugins.views.discover'
    | 'settingsPlugins.views.development'
    | 'settingsPlugins.views.diagnostics';

export function createPluginSettingsViews(
    translate: (key: PluginSettingsViewTranslationKey) => string,
): readonly Readonly<{ id: PluginSettingsViewId; label: string }>[] {
    return [
        { id: 'installed', label: translate('settingsPlugins.views.installed') },
        { id: 'discover', label: translate('settingsPlugins.views.discover') },
        { id: 'development', label: translate('settingsPlugins.views.development') },
        { id: 'diagnostics', label: translate('settingsPlugins.views.diagnostics') },
    ];
}

export type InstalledPluginDiagnostic = Readonly<{
    code: string;
    message: string;
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
    }>;
    compatibility: Readonly<{
        status: string;
        diagnostics: readonly InstalledPluginDiagnostic[];
    }>;
    diagnostics: readonly InstalledPluginDiagnostic[];
}>;

export type DevelopmentPluginEntry = Readonly<{
    installed: InstalledPluginEntry;
    sourceRootPath: string;
    watch: Readonly<{ state: 'configured' }>;
    reload: Readonly<{
        state: 'clear' | 'attention';
        diagnostics: readonly InstalledPluginDiagnostic[];
    }>;
    actions: Readonly<{
        test: boolean;
        pack: boolean;
    }>;
}>;

export type PluginMarketplaceActionRequest = Readonly<{
    method: 'install' | 'update' | 'rollback' | 'uninstall' | 'forgetTrust' | 'enable' | 'disable';
    pluginId: string;
    sourceId?: string;
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
export type PluginReadOnlySnapshotReason = 'disconnected' | 'projectionUnavailable' | 'accountRecovery';

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
}>): PluginReadOnlySnapshotNoticeState | null {
    if (params.daemonOperationsAvailable) {
        return null;
    }
    const hasCachedTruth = params.hasCapabilitySnapshot
        || params.installedPluginCount > 0
        || params.developmentPluginCount > 0
        || params.hasCatalog
        || params.hasMarketplaceSourceRegistry
        || params.hasProjectionInputs;
    if (!hasCachedTruth) {
        return null;
    }
    const projectionAnswered = params.projectionPhase === 'error' || params.projectionPhase === 'unsupported';
    return {
        reason: params.daemonTransportOnline && projectionAnswered
            ? 'projectionUnavailable'
            : 'disconnected',
    };
}

export function isPluginMutationVisibleAfterRefresh(params: Readonly<{
    method: 'install' | 'update' | 'rollback' | 'uninstall' | 'forgetTrust';
    pluginId: string;
    before: InstalledPluginEntry | null;
    after: InstalledPluginEntry | null;
    targetVersion: string | null;
}>): boolean {
    if (params.method === 'uninstall') {
        return params.after === null;
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
    if (params.method === 'update') {
        return params.targetVersion !== null
            && params.after.version === params.targetVersion
            && params.after.version !== params.before.version;
    }
    return params.after.version !== params.before.version
        || params.after.admittedIntegrity !== params.before.admittedIntegrity
        || params.after.desiredGeneration !== params.before.desiredGeneration
        || params.after.appliedGeneration !== params.before.appliedGeneration;
}

type ReviewRawCredentialSourceClass =
    | Readonly<{
        kind: 'savedSecret';
        secretKinds: readonly ('apiKey' | 'token' | 'password' | 'other')[];
    }>
    | Readonly<{
        kind: 'connectedAccount';
        service: Readonly<{ pluginId: string; localId: string }>;
    }>;

type ReviewRawCredentialAccess = Readonly<{
    accessMode: 'raw';
    contribution: Readonly<{ pluginId: string; localId: string }>;
    credentialSlot: Readonly<{ id: string; title: string; purpose: string }>;
    sourceClass: ReviewRawCredentialSourceClass;
    realm: 'web' | 'ios' | 'android' | 'daemon';
    phase: 'settings' | 'prepare' | 'connection' | 'speech';
    request: ConnectedAccountMaterializationRequest;
}>;

export type PendingPluginChangeReview = Readonly<{
    pendingChangeId: string;
    review: Readonly<{
        pluginId: string;
        displayName: string;
        version: string;
        packageIdentity: Readonly<{ name: string | null; version: string }>;
        publisherIdentity:
            | Readonly<{ status: 'unavailable' }>
            | Readonly<{ status: 'unverified'; id: string; displayName: string }>;
        source:
            | Readonly<{
                kind: 'path';
                locator: string;
            }>
            | Readonly<{
                kind: 'archive' | 'npm';
                locator: string;
                integrity?: string;
            }>;
        updateChannel:
            | Readonly<{ kind: 'path'; locator: string; development: boolean }>
            | Readonly<{ kind: 'archive'; locator: string }>
            | Readonly<{
                kind: 'npm';
                packageName: string;
                registryOrigin: string;
                registryProfileId?: string;
                marketplaceSource?: Readonly<{
                    id: string;
                    kind: 'curated' | 'community-npm';
                    sourceUrl: string;
                }>;
            }>;
        signature:
            | Readonly<{ status: 'notProvided' }>
            | Readonly<{ status: 'verified' | 'unsupported'; keyId: string }>;
        provenance:
            | Readonly<{ status: 'notProvided' }>
            | Readonly<{ status: 'declaredUnverified'; predicateType: string }>
            | Readonly<{ status: 'retrievedUnverified'; predicateTypes: readonly string[] }>
            | Readonly<{ status: 'unavailable'; code: string }>;
        curation:
            | Readonly<{ status: 'notApplicable' }>
            | Readonly<{ status: 'approved'; sourceId: string; reviewedAt: string; reason?: string | null }>
            | Readonly<{ status: 'unreviewed'; sourceId: string }>;
        executableRealms: readonly ('daemon' | 'reactNative')[];
        contributions: readonly Readonly<{ family: string; count: number }>[];
        uiArtifacts: Readonly<{
            status: 'verified' | 'none' | 'unavailable';
            contributionIds: readonly string[];
        }>;
        requiredHostAccess: readonly ReviewHostAccess[];
        optionalHostAccess: readonly (ReviewHostAccess & Readonly<{ authorizationClass: 'hostResourceSelection' }>)[];
        rawCredentialAccess: readonly ReviewRawCredentialAccess[];
        compatibility: Readonly<{
            happier?: string;
            runtimeApiVersion: 1;
            /**
             * Bounded evaluator-owned reasons for a newer version being
             * skipped before acquisition. The review only presents them; it
             * never makes a compatibility decision.
             */
            blockedNewerVersions?: readonly Readonly<{
                version: string;
                diagnostics: readonly Readonly<{ code: string; message: string }>[];
            }>[];
        }>;
        updatePolicy: 'automatic' | 'manual' | 'pinned';
    }>;
}>;

type ReviewHostAccess = Readonly<{
    id: string;
    capability: string;
    reason: string;
    authorizationClass: 'cooperativeDisclosure' | 'hostResourceSelection' | 'presentIntentOrOs';
    normalizedScope: Readonly<Record<string, unknown>>;
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

function isBoundedJsonValue(value: unknown, depth = 0): boolean {
    if (depth > 8) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 4_096;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) {
        return value.length <= 256 && value.every((entry) => isBoundedJsonValue(entry, depth + 1));
    }
    if (!isRecord(value) || Object.keys(value).length > 256) return false;
    return Object.entries(value).every(([key, entry]) => (
        key.length <= 256 && isBoundedJsonValue(entry, depth + 1)
    ));
}

function readHostAccessRequests(value: unknown, optional: boolean): readonly ReviewHostAccess[] | null {
    if (!Array.isArray(value) || value.length > 128) return null;
    const requests: ReviewHostAccess[] = [];
    const ids = new Set<string>();
    for (const entry of value) {
        if (
            !isRecord(entry)
            || !hasOnlyKeys(entry, ['id', 'capability', 'reason', 'authorizationClass', 'normalizedScope'])
        ) return null;
        const id = readNonEmptyString(entry.id);
        const capability = readNonEmptyString(entry.capability);
        const reason = readNonEmptyString(entry.reason);
        const authorizationClass = entry.authorizationClass;
        if (
            !id
            || !capability
            || !reason
            || ids.has(id)
            || (
                authorizationClass !== 'cooperativeDisclosure'
                && authorizationClass !== 'hostResourceSelection'
                && authorizationClass !== 'presentIntentOrOs'
            )
            || (optional && authorizationClass !== 'hostResourceSelection')
            || !isRecord(entry.normalizedScope)
            || !isBoundedJsonValue(entry.normalizedScope)
        ) return null;
        ids.add(id);
        requests.push({ id, capability, reason, authorizationClass, normalizedScope: entry.normalizedScope });
    }
    return requests;
}

function readRawCredentialSourceClass(value: unknown): ReviewRawCredentialSourceClass | null {
    if (!isRecord(value)) return null;
    if (value.kind === 'savedSecret') {
        if (!hasOnlyKeys(value, ['kind', 'secretKinds']) || !Array.isArray(value.secretKinds)) return null;
        const secretKinds = value.secretKinds.filter((kind): kind is 'apiKey' | 'token' | 'password' | 'other' => (
            kind === 'apiKey' || kind === 'token' || kind === 'password' || kind === 'other'
        ));
        return secretKinds.length === value.secretKinds.length
            && secretKinds.length > 0
            && secretKinds.length <= 4
            && new Set(secretKinds).size === secretKinds.length
            ? { kind: 'savedSecret', secretKinds }
            : null;
    }
    if (value.kind !== 'connectedAccount' || !hasOnlyKeys(value, ['kind', 'service'])) return null;
    const service = PluginContributionIdentityV1Schema.safeParse(value.service);
    return service.success
        ? {
            kind: 'connectedAccount',
            service: { pluginId: service.data.pluginId, localId: service.data.localId },
        }
        : null;
}

function readRawCredentialAccess(
    value: unknown,
): readonly ReviewRawCredentialAccess[] | null {
    if (!Array.isArray(value)) return null;
    const access: ReviewRawCredentialAccess[] = [];
    for (const entry of value) {
        if (
            !isRecord(entry)
            || !hasOnlyKeys(entry, [
                'accessMode', 'contribution', 'credentialSlot', 'sourceClass', 'realm', 'phase', 'request',
            ])
            || entry.accessMode !== 'raw'
        ) return null;
        const contribution = PluginContributionIdentityV1Schema.safeParse(entry.contribution);
        const credentialSlot = entry.credentialSlot;
        if (!contribution.success || !isRecord(credentialSlot)
            || !hasOnlyKeys(credentialSlot, ['id', 'title', 'purpose'])) return null;
        const credentialSlotId = VoiceCredentialSlotIdSchema.safeParse(credentialSlot.id);
        const credentialSlotTitle = readNonEmptyString(credentialSlot.title);
        const credentialSlotPurpose = ConnectedAccountPurposeIdSchema.safeParse(credentialSlot.purpose);
        const sourceClass = readRawCredentialSourceClass(entry.sourceClass);
        const phase = VoiceCredentialAccessPhaseSchema.safeParse(entry.phase);
        const request = ConnectedAccountMaterializationRequestSchema.safeParse(entry.request);
        if (
            !credentialSlotId.success
            || !credentialSlotTitle
            || !credentialSlotPurpose.success
            || !sourceClass
            || !phase.success
            || !request.success
            || (entry.realm !== 'web' && entry.realm !== 'ios' && entry.realm !== 'android' && entry.realm !== 'daemon')
        ) return null;
        access.push({
            accessMode: 'raw',
            contribution: {
                pluginId: contribution.data.pluginId,
                localId: contribution.data.localId,
            },
            credentialSlot: {
                id: credentialSlotId.data,
                title: credentialSlotTitle,
                purpose: credentialSlotPurpose.data,
            },
            sourceClass,
            realm: entry.realm,
            phase: phase.data,
            request: request.data,
        });
    }
    return access;
}

function readStringList(value: unknown, maximum: number): readonly string[] | null {
    if (!Array.isArray(value) || value.length > maximum) return null;
    const entries = value.map(readNonEmptyString);
    if (entries.some((entry) => entry === null)) return null;
    const strings = entries as string[];
    return new Set(strings).size === strings.length ? strings : null;
}

function readPluginInstallationReviewSource(
    value: unknown,
): PendingPluginChangeReview['review']['source'] | null {
    if (!isRecord(value)) return null;
    const locator = readNonEmptyString(value.locator);
    if (!locator) return null;
    if (value.kind === 'path') {
        return hasOnlyKeys(value, ['kind', 'locator'])
            ? { kind: 'path', locator }
            : null;
    }
    if (value.kind !== 'archive' && value.kind !== 'npm') return null;
    const integrity = value.integrity === undefined ? undefined : readNonEmptyString(value.integrity);
    return hasOnlyKeys(value, ['kind', 'locator', 'integrity'])
        && (value.integrity === undefined || integrity)
        ? { kind: value.kind, locator, ...(integrity ? { integrity } : {}) }
        : null;
}

function readPluginInstallationReviewCompatibility(
    value: unknown,
): PendingPluginChangeReview['review']['compatibility'] | null {
    if (
        !isRecord(value)
        || !hasOnlyKeys(value, ['happier', 'runtimeApiVersion', 'blockedNewerVersions'])
        || value.runtimeApiVersion !== 1
    ) return null;
    const happier = value.happier === undefined ? undefined : readNonEmptyString(value.happier);
    if (value.happier !== undefined && !happier) return null;
    if (value.blockedNewerVersions === undefined) {
        return { ...(happier ? { happier } : {}), runtimeApiVersion: 1 };
    }
    if (!Array.isArray(value.blockedNewerVersions) || value.blockedNewerVersions.length > 32) return null;
    const blockedNewerVersions = value.blockedNewerVersions.flatMap((blocked) => {
        if (
            !isRecord(blocked)
            || !hasOnlyKeys(blocked, ['version', 'diagnostics'])
            || !Array.isArray(blocked.diagnostics)
            || blocked.diagnostics.length === 0
            || blocked.diagnostics.length > 4
        ) return [];
        const version = readNonEmptyString(blocked.version);
        const diagnostics = blocked.diagnostics.flatMap((diagnostic) => {
            if (!isRecord(diagnostic) || !hasOnlyKeys(diagnostic, ['code', 'message'])) return [];
            const code = readNonEmptyString(diagnostic.code);
            const message = readNonEmptyString(diagnostic.message);
            return code && message ? [{ code, message }] : [];
        });
        return version && diagnostics.length === blocked.diagnostics.length
            ? [{ version, diagnostics }]
            : [];
    });
    if (blockedNewerVersions.length !== value.blockedNewerVersions.length) return null;
    return {
        ...(happier ? { happier } : {}),
        runtimeApiVersion: 1,
        blockedNewerVersions,
    };
}

function readPublisherIdentity(value: unknown): PendingPluginChangeReview['review']['publisherIdentity'] | null {
    if (!isRecord(value)) return null;
    if (value.status === 'unavailable' && hasOnlyKeys(value, ['status'])) return { status: 'unavailable' };
    const id = readNonEmptyString(value.id);
    const displayName = readNonEmptyString(value.displayName);
    return value.status === 'unverified'
        && hasOnlyKeys(value, ['status', 'id', 'displayName'])
        && id
        && displayName
        ? { status: 'unverified', id, displayName }
        : null;
}

function readUpdateChannel(value: unknown): PendingPluginChangeReview['review']['updateChannel'] | null {
    if (!isRecord(value)) return null;
    if (value.kind === 'path') {
        const locator = readNonEmptyString(value.locator);
        return hasOnlyKeys(value, ['kind', 'locator', 'development'])
            && locator
            && typeof value.development === 'boolean'
            ? { kind: 'path', locator, development: value.development }
            : null;
    }
    if (value.kind === 'archive') {
        const locator = readNonEmptyString(value.locator);
        return hasOnlyKeys(value, ['kind', 'locator']) && locator ? { kind: 'archive', locator } : null;
    }
    if (
        value.kind !== 'npm'
        || !hasOnlyKeys(value, ['kind', 'packageName', 'registryOrigin', 'registryProfileId', 'marketplaceSource'])
    ) {
        return null;
    }
    const packageName = readNonEmptyString(value.packageName);
    const registryOrigin = readNonEmptyString(value.registryOrigin);
    const registryProfileId = value.registryProfileId === undefined
        ? null
        : readNonEmptyString(value.registryProfileId);
    if (value.registryProfileId !== undefined && !registryProfileId) return null;
    if (!packageName || !registryOrigin) return null;
    const channel = {
        kind: 'npm' as const,
        packageName,
        registryOrigin,
        ...(registryProfileId ? { registryProfileId } : {}),
    };
    if (value.marketplaceSource === undefined) return channel;
    if (
        !isRecord(value.marketplaceSource)
        || !hasOnlyKeys(value.marketplaceSource, ['id', 'kind', 'sourceUrl'])
    ) return null;
    const id = readNonEmptyString(value.marketplaceSource.id);
    const sourceUrl = readNonEmptyString(value.marketplaceSource.sourceUrl);
    const kind = value.marketplaceSource.kind;
    return id && sourceUrl && (kind === 'curated' || kind === 'community-npm')
        ? { ...channel, marketplaceSource: { id, kind, sourceUrl } }
        : null;
}

function readSignature(value: unknown): PendingPluginChangeReview['review']['signature'] | null {
    if (!isRecord(value)) return null;
    if (value.status === 'notProvided' && hasOnlyKeys(value, ['status'])) return { status: 'notProvided' };
    const keyId = readNonEmptyString(value.keyId);
    return (value.status === 'verified' || value.status === 'unsupported')
        && hasOnlyKeys(value, ['status', 'keyId'])
        && keyId
        ? { status: value.status, keyId }
        : null;
}

function readProvenance(value: unknown): PendingPluginChangeReview['review']['provenance'] | null {
    if (!isRecord(value)) return null;
    if (value.status === 'notProvided' && hasOnlyKeys(value, ['status'])) return { status: 'notProvided' };
    if (value.status === 'declaredUnverified' && hasOnlyKeys(value, ['status', 'predicateType'])) {
        const predicateType = readNonEmptyString(value.predicateType);
        return predicateType ? { status: 'declaredUnverified', predicateType } : null;
    }
    if (value.status === 'retrievedUnverified' && hasOnlyKeys(value, ['status', 'predicateTypes'])) {
        const predicateTypes = readStringList(value.predicateTypes, 64);
        return predicateTypes?.length ? { status: 'retrievedUnverified', predicateTypes } : null;
    }
    if (value.status === 'unavailable' && hasOnlyKeys(value, ['status', 'code'])) {
        const code = readNonEmptyString(value.code);
        return code ? { status: 'unavailable', code } : null;
    }
    return null;
}

function readCuration(value: unknown): PendingPluginChangeReview['review']['curation'] | null {
    if (!isRecord(value)) return null;
    if (value.status === 'notApplicable' && hasOnlyKeys(value, ['status'])) return { status: 'notApplicable' };
    const sourceId = readNonEmptyString(value.sourceId);
    if (!sourceId) return null;
    if (value.status === 'unreviewed' && hasOnlyKeys(value, ['status', 'sourceId'])) {
        return { status: 'unreviewed', sourceId };
    }
    if (value.status !== 'approved' || !hasOnlyKeys(value, ['status', 'sourceId', 'reviewedAt', 'reason'])) return null;
    const reviewedAt = readNonEmptyString(value.reviewedAt);
    const reason = value.reason === undefined || value.reason === null ? value.reason : readNonEmptyString(value.reason);
    return reviewedAt && (value.reason === undefined || value.reason === null || reason)
        ? { status: 'approved', sourceId, reviewedAt, ...(value.reason !== undefined ? { reason } : {}) }
        : null;
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
export type PendingPluginDevelopmentSourceRootReview = Readonly<{
    pendingChangeId: string;
    review: Readonly<{
        source: Readonly<{ kind: 'path'; locator: string }>;
    }>;
}>;

export function readPluginDevelopmentSourceRootReviewChange(
    change: unknown,
): PendingPluginDevelopmentSourceRootReview | null {
    if (!isRecord(change) || change.kind !== 'sourceRootReviewRequired') return null;
    const pendingChangeId = readNonEmptyString(change.pendingChangeId);
    const review = change.review;
    if (
        !pendingChangeId
        || !isRecord(review)
        || !hasOnlyKeys(review, ['source'])
        || !isRecord(review.source)
        || !hasOnlyKeys(review.source, ['kind', 'locator'])
        || review.source.kind !== 'path'
    ) return null;
    const locator = readNonEmptyString(review.source.locator);
    return locator
        ? { pendingChangeId, review: { source: { kind: 'path', locator } } }
        : null;
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
    | Readonly<{ kind: 'sourceRootReviewRequired'; sourceRootReview: PendingPluginDevelopmentSourceRootReview }>
    | Readonly<{ kind: 'reviewRequired'; installationReview: PendingPluginChangeReview }>;

export function readPendingPluginChangeDecision(change: unknown): PendingPluginChangeDecision | null {
    const sourceRootReview = readPluginDevelopmentSourceRootReviewChange(change);
    if (sourceRootReview) return { kind: 'sourceRootReviewRequired', sourceRootReview };
    const installationReview = readPluginInstallationReviewChange(change, null);
    return installationReview ? { kind: 'reviewRequired', installationReview } : null;
}

/** The daemon-issued id of whichever decision this change is currently at. */
export function readPendingPluginChangeDecisionId(decision: PendingPluginChangeDecision): string {
    return decision.kind === 'sourceRootReviewRequired'
        ? decision.sourceRootReview.pendingChangeId
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
    | Readonly<{ kind: 'terminal'; pendingChangeId: string; outcome: string }>
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
    return outcome ? { kind: 'terminal', pendingChangeId, outcome } : null;
}

/**
 * Reads the daemon's bare `reviewRequired` change. Both the capability-invoke
 * envelope and the follow-up returned by a source-root trust decision carry the
 * identical change shape, so they share this one parser rather than growing a
 * second, drifting copy.
 */
export function readPluginInstallationReviewChange(
    change: unknown,
    expectedPluginId: string | null,
): PendingPluginChangeReview | null {
    if (!isRecord(change) || change.kind !== 'reviewRequired') return null;

    const pendingChangeId = readNonEmptyString(change.pendingChangeId);
    const review = change.review;
    if (
        !pendingChangeId
        || !isRecord(review)
        || !hasOnlyKeys(review, [
            'pluginId', 'displayName', 'version', 'packageIdentity', 'publisherIdentity', 'source',
            'updateChannel', 'signature', 'provenance', 'curation', 'executableRealms',
            'contributions', 'uiArtifacts', 'requiredHostAccess', 'optionalHostAccess',
            'rawCredentialAccess', 'compatibility', 'updatePolicy',
        ])
    ) return null;

    const pluginId = readNonEmptyString(review.pluginId);
    const displayName = readNonEmptyString(review.displayName);
    const version = readNonEmptyString(review.version);
    const source = readPluginInstallationReviewSource(review.source);
    const packageIdentity = review.packageIdentity;
    const packageName = isRecord(packageIdentity) && packageIdentity.name === null
        ? null
        : isRecord(packageIdentity) ? readNonEmptyString(packageIdentity.name) : null;
    const packageVersion = isRecord(packageIdentity) ? readNonEmptyString(packageIdentity.version) : null;
    const publisherIdentity = readPublisherIdentity(review.publisherIdentity);
    const updateChannel = readUpdateChannel(review.updateChannel);
    const signature = readSignature(review.signature);
    const provenance = readProvenance(review.provenance);
    const curation = readCuration(review.curation);
    if (
        !pluginId
        || (expectedPluginId !== null && pluginId !== expectedPluginId)
        || !displayName
        || !version
        || !source
        || !isRecord(packageIdentity)
        || !hasOnlyKeys(packageIdentity, ['name', 'version'])
        || (packageIdentity.name !== null && !packageName)
        || !packageVersion
        || packageVersion !== version
        || !publisherIdentity
        || !updateChannel
        || !signature
        || !provenance
        || !curation
    ) {
        return null;
    }

    if (!Array.isArray(review.executableRealms) || review.executableRealms.length > 2) return null;
    const executableRealms = review.executableRealms.flatMap((realm) => (
        realm === 'daemon' || realm === 'reactNative' ? [realm] : []
    ));
    if (executableRealms.length !== review.executableRealms.length || new Set(executableRealms).size !== executableRealms.length) {
        return null;
    }
    if (!Array.isArray(review.contributions) || review.contributions.length > 64) return null;
    const contributions = review.contributions.flatMap((entry) => {
        if (!isRecord(entry) || !hasOnlyKeys(entry, ['family', 'count'])) return [];
        const family = readNonEmptyString(entry.family);
        return family && Number.isSafeInteger(entry.count) && (entry.count as number) > 0
            ? [{ family, count: entry.count as number }]
            : [];
    });
    if (
        contributions.length !== review.contributions.length
        || new Set(contributions.map((entry) => entry.family)).size !== contributions.length
    ) return null;
    if (!isRecord(review.uiArtifacts) || !hasOnlyKeys(review.uiArtifacts, ['status', 'contributionIds'])) return null;
    const uiArtifactStatus = review.uiArtifacts.status;
    const uiArtifactIds = readStringList(review.uiArtifacts.contributionIds, 64);
    if (
        (uiArtifactStatus !== 'verified' && uiArtifactStatus !== 'none' && uiArtifactStatus !== 'unavailable')
        || !uiArtifactIds
        || (uiArtifactStatus === 'none' && uiArtifactIds.length !== 0)
        || (uiArtifactStatus !== 'none' && uiArtifactIds.length === 0)
    ) return null;
    const requiredHostAccess = readHostAccessRequests(review.requiredHostAccess, false);
    const optionalHostAccess = readHostAccessRequests(review.optionalHostAccess, true);
    const rawCredentialAccess = readRawCredentialAccess(review.rawCredentialAccess);
    if (!requiredHostAccess || !optionalHostAccess || !rawCredentialAccess) return null;
    const compatibility = readPluginInstallationReviewCompatibility(review.compatibility);
    if (
        !compatibility
        || (
            review.updatePolicy !== 'automatic'
            && review.updatePolicy !== 'manual'
            && review.updatePolicy !== 'pinned'
        )
    ) return null;

    return {
        pendingChangeId,
        review: {
            pluginId,
            displayName,
            version,
            packageIdentity: { name: packageName, version: packageVersion },
            publisherIdentity,
            source,
            updateChannel,
            signature,
            provenance,
            curation,
            executableRealms,
            contributions,
            uiArtifacts: { status: uiArtifactStatus, contributionIds: uiArtifactIds },
            requiredHostAccess,
            optionalHostAccess: optionalHostAccess as PendingPluginChangeReview['review']['optionalHostAccess'],
            rawCredentialAccess,
            compatibility,
            updatePolicy: review.updatePolicy,
        },
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
    ) return null;
    return readNonEmptyString(value.change.kind);
}

function formatRawCredentialReviewSourceClass(sourceClass: ReviewRawCredentialSourceClass): string {
    return sourceClass.kind === 'savedSecret'
        ? `savedSecret(${sourceClass.secretKinds.join(', ')})`
        : `connectedAccount(${sourceClass.service.pluginId}/${sourceClass.service.localId})`;
}

export function formatPluginInstallationReviewBody(review: PendingPluginChangeReview['review']): string {
    const requiredAccess = review.requiredHostAccess.length > 0
        ? review.requiredHostAccess.map((entry) => (
            `${entry.capability} [${entry.authorizationClass}]: ${entry.reason}; `
            + `${JSON.stringify(entry.normalizedScope)}`
        )).join('\n')
        : t('common.none');
    const optionalAccess = review.optionalHostAccess.length > 0
        ? review.optionalHostAccess.map((entry) => (
            `${entry.capability}: ${entry.reason}; ${JSON.stringify(entry.normalizedScope)}`
        )).join('\n')
        : t('common.none');
    const executableRealms = review.executableRealms.length > 0
        ? review.executableRealms.join(', ')
        : t('common.none');
    const publisher = review.publisherIdentity.status === 'unavailable'
        ? t('common.unavailable')
        : `${review.publisherIdentity.displayName} (${review.publisherIdentity.id}; unverified marketplace claim)`;
    const channel = review.updateChannel.kind === 'path'
        ? `${review.updateChannel.development ? 'development path' : 'path'}: ${review.updateChannel.locator}`
        : review.updateChannel.kind === 'archive'
            ? `archive: ${review.updateChannel.locator}`
            : `npm: ${review.updateChannel.packageName} @ ${review.updateChannel.registryOrigin}${
                review.updateChannel.registryProfileId
                    ? ` via registry profile ${review.updateChannel.registryProfileId}`
                    : ''
            }${
                review.updateChannel.marketplaceSource
                    ? ` via ${review.updateChannel.marketplaceSource.kind} ${review.updateChannel.marketplaceSource.id}`
                    : ''
            }`;
    const identity = [
        `Plugin: ${review.pluginId}`,
        `Package: ${review.packageIdentity.name ?? t('common.unavailable')} ${review.packageIdentity.version}`,
        `Publisher: ${publisher}`,
        `Source: ${review.source.kind} ${review.source.locator}`,
        `Update channel: ${channel}`,
    ].join('\n');
    const signature = review.signature.status === 'notProvided'
        ? t('common.notProvided')
        : review.signature.status === 'verified'
            ? `verified (${review.signature.keyId})`
            : `unsupported (${review.signature.keyId})`;
    const provenance = review.provenance.status === 'notProvided'
        ? t('common.notProvided')
        : review.provenance.status === 'declaredUnverified'
            ? `declared, unverified (${review.provenance.predicateType})`
            : review.provenance.status === 'retrievedUnverified'
                ? `retrieved, unverified (${review.provenance.predicateTypes.join(', ')})`
                : `${t('common.unavailable')} (${review.provenance.code})`;
    const curation = review.curation.status === 'notApplicable'
        ? 'not applicable'
        : review.curation.status === 'unreviewed'
            ? `unreviewed (${review.curation.sourceId})`
            : `approved (${review.curation.sourceId}, ${review.curation.reviewedAt})${
                review.curation.reason ? ` — ${review.curation.reason}` : ''
            }`;
    const sourceIntegrity = review.source.kind === 'path' ? undefined : review.source.integrity;
    const verification = [
        `Source integrity: ${sourceIntegrity ? 'matched staged bytes' : t('common.unavailable')}`,
        `Signature: ${signature}`,
        `Provenance: ${provenance}`,
        `Curation: ${curation}`,
    ].join('\n');
    const contributions = review.contributions.length > 0
        ? review.contributions.map((entry) => `${entry.family} (${entry.count})`).join(', ')
        : t('common.none');
    const uiArtifacts = review.uiArtifacts.contributionIds.length > 0
        ? `${review.uiArtifacts.status}: ${review.uiArtifacts.contributionIds.join(', ')}`
        : t('common.none');
    const blockedNewerVersions = review.compatibility.blockedNewerVersions ?? [];
    const compatibility = [
        `Happier: ${review.compatibility.happier ?? t('common.notProvided')}`,
        `Plugin runtime API: ${review.compatibility.runtimeApiVersion}`,
        ...(blockedNewerVersions.length > 0
            ? [
                t('settingsPlugins.marketplaceInstallReviewBlockedNewerVersions'),
                ...blockedNewerVersions.map((blocked) => (
                    `${blocked.version} ${blocked.diagnostics
                        .map((diagnostic) => `[${diagnostic.code}]: ${diagnostic.message}`)
                        .join('; ')}`
                )),
            ]
            : []),
        `Update policy: ${review.updatePolicy}`,
    ].join('\n');
    const reviewBody = t('settingsPlugins.marketplaceInstallReviewBody', {
        identity,
        verification,
        executableRealms,
        contributions,
        uiArtifacts,
        requiredAccess,
        optionalAccess,
        compatibility,
    });
    if (review.rawCredentialAccess.length === 0) return reviewBody;
    const rawCredentialAccess = review.rawCredentialAccess.map((access) => t(
        'settingsPlugins.marketplaceInstallReviewRawCredentialAccessItem',
        {
            contribution: `${access.contribution.pluginId}/${access.contribution.localId}`,
            credential: `${access.credentialSlot.title} (${access.credentialSlot.id}; ${access.credentialSlot.purpose})`,
            source: formatRawCredentialReviewSourceClass(access.sourceClass),
            realm: access.realm,
            phase: access.phase,
            request: JSON.stringify(access.request),
        },
    )).join('\n');
    return `${reviewBody}\n\n${t('settingsPlugins.marketplaceInstallReviewRawCredentialAccess', {
        details: rawCredentialAccess,
    })}`;
}

type MarketplaceCapabilitySnapshot = Readonly<{
    response: {
        protocolVersion: 1;
        results: Partial<Record<CapabilityId, Readonly<{
            ok: true;
            checkedAt: number;
            data?: {
                installedPlugins?: readonly InstalledPluginEntry[];
                developmentActions?: Readonly<{ create: boolean; develop?: boolean }>;
                developmentSources?: readonly Readonly<{
                    pluginId: string;
                    sourceRootPath: string;
                    watch: Readonly<{ state: 'configured' }>;
                    reload: Readonly<{
                        state: 'clear' | 'attention';
                        diagnostics: readonly InstalledPluginDiagnostic[];
                    }>;
                    actions: Readonly<{ test: boolean; pack: boolean }>;
                }>[];
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

export function resolvePluginMarketplaceErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    return t('errors.unknownError');
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
    const developmentSources = toolPlugins?.ok && toolPlugins.data && typeof toolPlugins.data === 'object'
        ? toolPlugins.data.developmentSources
        : null;
    if (!Array.isArray(developmentSources)) return [];

    const installedById = new Map(installedPlugins.map((entry) => [entry.pluginId, entry] as const));
    return developmentSources.flatMap((source) => {
        const installed = installedById.get(source.pluginId);
        return installed ? [{ ...source, installed }] : [];
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
 * What a listed pending change is asking for, in the user's own terms. The
 * locator and the package identity are the whole security payload of the two
 * decisions, so both are shown verbatim rather than summarised away.
 */
export function formatPendingPluginChangeTitle(entry: PendingPluginChangeListing): string {
    if (entry.kind === 'applying') return t('settingsPlugins.pendingChangeApplying');
    return entry.kind === 'sourceRootReviewRequired'
        ? t('settingsPlugins.developmentTrustSourceRootTitle')
        : t('settingsPlugins.marketplaceInstallReviewTitle', {
            name: entry.installationReview.review.displayName,
            version: entry.installationReview.review.version,
        });
}

export function formatPendingPluginChangeSubtitle(entry: PendingPluginChangeListing): string {
    if (entry.kind === 'applying') return entry.pendingChangeId;
    return entry.kind === 'sourceRootReviewRequired'
        ? t('settingsPlugins.pendingChangeSourceRootSubtitle', {
            path: entry.sourceRootReview.review.source.locator,
        })
        : t('settingsPlugins.pendingChangeInstallSubtitle', {
            pluginId: entry.installationReview.review.pluginId,
            source: entry.installationReview.review.source.locator,
        });
}

export function formatCatalogEntryVersion(version: string | null): string | undefined {
    return version ?? undefined;
}

export function formatInstalledSubtitle(entry: InstalledPluginEntry): string {
    const diagnostics = [...entry.diagnostics, ...entry.compatibility.diagnostics];
    const parts = [
        entry.enabled ? t('common.enabled') : t('common.disabled'),
        `${entry.source.kind}: ${entry.source.locator}`,
    ];
    if (entry.compatibility.status !== 'compatible') {
        parts.push(entry.compatibility.status);
    }
    if (diagnostics.length > 0) {
        parts.push(diagnostics[0].message);
    }
    return parts.join(' | ');
}

export function formatDevelopmentPluginSubtitle(entry: DevelopmentPluginEntry): string {
    const parts = [
        entry.installed.pluginId,
        entry.installed.enabled ? t('common.enabled') : t('common.disabled'),
        `path: ${entry.sourceRootPath}`,
    ];
    if (entry.installed.compatibility.status !== 'compatible') {
        parts.push(entry.installed.compatibility.status);
    }
    parts.push(...entry.reload.diagnostics.map((diagnostic) => diagnostic.message));
    return parts.join(' | ');
}

export function formatCatalogSubtitle(params: Readonly<{
    catalog: PluginMarketplaceCatalog;
    installed: InstalledPluginEntry | null;
}>): string {
    if (!params.installed) {
        return params.catalog.description ?? t('deps.ui.notInstalled');
    }

    return t('deps.ui.installedWithVersion', { version: params.installed.version });
}
