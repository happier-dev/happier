import type { PluginPermissionDeclarationV1 } from '@happier-dev/protocol';

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
        resolvedDigest?: string | null;
    }>;
    install: Readonly<{
        mode: string;
        manifestVersion: string;
        manifestDigest?: string | null;
        installedPath?: string | null;
    }>;
    compatibility: Readonly<{
        status: string;
        diagnostics: readonly InstalledPluginDiagnostic[];
    }>;
    diagnostics: readonly InstalledPluginDiagnostic[];
    /**
     * The canonical install manifest projection, when present in the machine
     * capability snapshot. Declared capabilities/permissions are read from here
     * for the permission-review pane (the same `requiredPermissions` the daemon
     * projects to the server manifest projection).
     */
    manifest?: Readonly<{
        permissions?: readonly PluginPermissionDeclarationV1[];
        optionalPermissions?: readonly PluginPermissionDeclarationV1[];
    }> | null;
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

export function shouldShowPluginReadOnlySnapshotNotice(params: Readonly<{
    daemonOperationsAvailable: boolean;
    hasCapabilitySnapshot: boolean;
    installedPluginCount: number;
    developmentPluginCount: number;
    hasCatalog: boolean;
    hasMarketplaceSourceRegistry: boolean;
    hasProjectionInputs: boolean;
}>): boolean {
    return !params.daemonOperationsAvailable && (
        params.hasCapabilitySnapshot
        || params.installedPluginCount > 0
        || params.developmentPluginCount > 0
        || params.hasCatalog
        || params.hasMarketplaceSourceRegistry
        || params.hasProjectionInputs
    );
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
        || params.after.source.resolvedDigest !== params.before.source.resolvedDigest
        || params.after.install.manifestDigest !== params.before.install.manifestDigest;
}

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
        source: Readonly<{
            kind: 'path' | 'archive' | 'npm';
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
        integrity: Readonly<{
            packageDigest: string;
            manifestDigest: string;
            uiArtifactDigest: string;
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
        compatibility: Readonly<{ happier: string; runtimeApiVersion: 1 }>;
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

function readStringList(value: unknown, maximum: number): readonly string[] | null {
    if (!Array.isArray(value) || value.length > maximum) return null;
    const entries = value.map(readNonEmptyString);
    if (entries.some((entry) => entry === null)) return null;
    const strings = entries as string[];
    return new Set(strings).size === strings.length ? strings : null;
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
    if (value.change.kind !== 'reviewRequired') return null;

    const pendingChangeId = readNonEmptyString(value.change.pendingChangeId);
    const review = value.change.review;
    if (
        !pendingChangeId
        || !isRecord(review)
        || !hasOnlyKeys(review, [
            'pluginId', 'displayName', 'version', 'packageIdentity', 'publisherIdentity', 'source',
            'updateChannel', 'integrity', 'signature', 'provenance', 'curation', 'executableRealms',
            'contributions', 'uiArtifacts', 'requiredHostAccess', 'optionalHostAccess',
            'compatibility', 'updatePolicy',
        ])
        || !isRecord(review.source)
        || !hasOnlyKeys(review.source, ['kind', 'locator', 'integrity'])
    ) return null;

    const pluginId = readNonEmptyString(review.pluginId);
    const displayName = readNonEmptyString(review.displayName);
    const version = readNonEmptyString(review.version);
    const sourceKind = review.source.kind;
    const sourceLocator = readNonEmptyString(review.source.locator);
    const sourceIntegrity = review.source.integrity === undefined
        ? undefined
        : readNonEmptyString(review.source.integrity);
    const packageIdentity = review.packageIdentity;
    const packageName = isRecord(packageIdentity) && packageIdentity.name === null
        ? null
        : isRecord(packageIdentity) ? readNonEmptyString(packageIdentity.name) : null;
    const packageVersion = isRecord(packageIdentity) ? readNonEmptyString(packageIdentity.version) : null;
    const publisherIdentity = readPublisherIdentity(review.publisherIdentity);
    const updateChannel = readUpdateChannel(review.updateChannel);
    const digestPattern = /^sha256:[a-f0-9]{64}$/u;
    const integrity = review.integrity;
    const packageDigest = isRecord(integrity) ? readNonEmptyString(integrity.packageDigest) : null;
    const manifestDigest = isRecord(integrity) ? readNonEmptyString(integrity.manifestDigest) : null;
    const uiArtifactDigest = isRecord(integrity) ? readNonEmptyString(integrity.uiArtifactDigest) : null;
    const signature = readSignature(review.signature);
    const provenance = readProvenance(review.provenance);
    const curation = readCuration(review.curation);
    if (
        !pluginId
        || pluginId !== expectedPluginId
        || !displayName
        || !version
        || (sourceKind !== 'path' && sourceKind !== 'archive' && sourceKind !== 'npm')
        || !sourceLocator
        || (review.source.integrity !== undefined && !sourceIntegrity)
        || !isRecord(packageIdentity)
        || !hasOnlyKeys(packageIdentity, ['name', 'version'])
        || (packageIdentity.name !== null && !packageName)
        || !packageVersion
        || packageVersion !== version
        || !publisherIdentity
        || !updateChannel
        || !isRecord(integrity)
        || !hasOnlyKeys(integrity, ['packageDigest', 'manifestDigest', 'uiArtifactDigest'])
        || !packageDigest
        || !manifestDigest
        || !uiArtifactDigest
        || !digestPattern.test(packageDigest)
        || !digestPattern.test(manifestDigest)
        || !digestPattern.test(uiArtifactDigest)
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
    if (!requiredHostAccess || !optionalHostAccess) return null;
    const compatibility = review.compatibility;
    const happier = isRecord(compatibility) ? readNonEmptyString(compatibility.happier) : null;
    if (
        !isRecord(compatibility)
        || !hasOnlyKeys(compatibility, ['happier', 'runtimeApiVersion'])
        || !happier
        || compatibility.runtimeApiVersion !== 1
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
            source: {
                kind: sourceKind,
                locator: sourceLocator,
                ...(sourceIntegrity ? { integrity: sourceIntegrity } : {}),
            },
            updateChannel,
            integrity: { packageDigest, manifestDigest, uiArtifactDigest },
            signature,
            provenance,
            curation,
            executableRealms,
            contributions,
            uiArtifacts: { status: uiArtifactStatus, contributionIds: uiArtifactIds },
            requiredHostAccess,
            optionalHostAccess: optionalHostAccess as PendingPluginChangeReview['review']['optionalHostAccess'],
            compatibility: { happier, runtimeApiVersion: 1 },
            updatePolicy: review.updatePolicy,
        },
    };
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
    const verification = [
        `Source integrity: ${review.source.integrity ? 'matched staged bytes' : t('common.unavailable')}`,
        'Package, manifest, and UI artifact digests: verified against staged candidate',
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
    const compatibility = [
        `Happier: ${review.compatibility.happier}`,
        `Plugin runtime API: ${review.compatibility.runtimeApiVersion}`,
        `Update policy: ${review.updatePolicy}`,
    ].join('\n');
    return t('settingsPlugins.marketplaceInstallReviewBody', {
        identity,
        verification,
        executableRealms,
        contributions,
        uiArtifacts,
        requiredAccess,
        optionalAccess,
        compatibility,
    });
}

type MarketplaceCapabilitySnapshot = Readonly<{
    response: {
        protocolVersion: 1;
        results: Partial<Record<CapabilityId, Readonly<{
            ok: true;
            checkedAt: number;
            data?: {
                installedPlugins?: readonly InstalledPluginEntry[];
                developmentActions?: Readonly<{ create: boolean }>;
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
