import { describe, expect, it } from 'vitest';

import type { PluginMarketplaceCatalog } from '../readPluginMarketplaceCatalog';
import {
    createPluginSettingsViews,
    formatCatalogSubtitle,
    formatPluginInstallationReviewBody,
    isPluginMutationVisibleAfterRefresh,
    readPendingPluginChangeReview,
    readPluginChangeKind,
    shouldShowPluginReadOnlySnapshotNotice,
    type InstalledPluginEntry,
} from './pluginMarketplaceModel';

const completeReview = {
    pluginId: 'example.plugin',
    displayName: 'Example',
    version: '2.0.0',
    packageIdentity: { name: '@example/plugin', version: '2.0.0' },
    publisherIdentity: { status: 'unverified', id: 'example', displayName: 'Example Publisher' },
    source: { kind: 'npm', locator: 'https://registry.example.test/example-plugin.tgz', integrity: 'sha512-exact' },
    updateChannel: {
        kind: 'npm',
        packageName: '@example/plugin',
        registryOrigin: 'https://registry.example.test',
        registryProfileId: 'registry_private',
        marketplaceSource: {
            id: 'marketplace:curated',
            kind: 'curated',
            sourceUrl: 'https://marketplace.example.test/catalog.json',
        },
    },
    integrity: {
        packageDigest: `sha256:${'a'.repeat(64)}`,
        manifestDigest: `sha256:${'b'.repeat(64)}`,
        uiArtifactDigest: `sha256:${'c'.repeat(64)}`,
    },
    signature: { status: 'verified', keyId: 'registry-key-1' },
    provenance: { status: 'retrievedUnverified', predicateTypes: ['https://slsa.dev/provenance/v1'] },
    curation: {
        status: 'approved',
        sourceId: 'marketplace:curated',
        reviewedAt: '2026-07-24T00:00:00.000Z',
        reason: 'Reviewed for the curated channel',
    },
    executableRealms: ['daemon'],
    contributions: [{ family: 'actions', count: 1 }],
    uiArtifacts: { status: 'none', contributionIds: [] },
    requiredHostAccess: [{
        id: 'network',
        capability: 'network',
        reason: 'Connect to the service',
        authorizationClass: 'cooperativeDisclosure',
        normalizedScope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }] },
    }],
    optionalHostAccess: [{
        id: 'sessions',
        capability: 'sessions',
        reason: 'Use selected sessions',
        authorizationClass: 'hostResourceSelection',
        normalizedScope: { access: ['read'] },
    }],
    compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
    updatePolicy: 'automatic',
} as const;

const installed: InstalledPluginEntry = {
    pluginId: 'example.plugin',
    title: 'Example',
    description: null,
    version: '1.0.0',
    enabled: true,
    source: {
        kind: 'catalog',
        locator: 'https://marketplace.example.test/catalog.json',
    },
    install: {
        mode: 'catalog',
        manifestVersion: '1',
    },
    compatibility: {
        status: 'compatible',
        diagnostics: [],
    },
    diagnostics: [],
};

const catalog: PluginMarketplaceCatalog = {
    sourceUrl: 'https://marketplace.example.test/catalog.json',
    title: 'Example marketplace',
    description: null,
    entries: [{
        id: 'example.plugin',
        sourceId: 'marketplace:curated',
        sourceKind: 'curated',
        reviewStatus: 'approved',
        title: 'Example',
        description: null,
        version: '2.0.0',
        installable: false,
        updateable: true,
    }],
};

describe('installed marketplace catalog formatting', () => {
    it('resolves all four management labels from the current translation function on each render', () => {
        expect(createPluginSettingsViews((key) => key)[0]?.label).toBe('settingsPlugins.views.installed');
        expect(createPluginSettingsViews((key) => `es:${key}`)[0]?.label).toBe('es:settingsPlugins.views.installed');
    });

    it('marks catalog-only cached management metadata as a read-only snapshot while the daemon is unavailable', () => {
        expect(shouldShowPluginReadOnlySnapshotNotice({
            daemonOperationsAvailable: false,
            hasCapabilitySnapshot: false,
            installedPluginCount: 0,
            developmentPluginCount: 0,
            hasCatalog: true,
            hasMarketplaceSourceRegistry: false,
            hasProjectionInputs: false,
        })).toBe(true);
    });

    it('does not advertise an update from a legacy catalog locator', () => {
        expect(formatCatalogSubtitle({ catalog, installed })).not.toContain('2.0.0');
    });

    it('parses the bounded staged installation review returned by the daemon capability', () => {
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired',
                pendingChangeId: 'pending-1',
                review: completeReview,
            },
        }, 'install', 'example.plugin')).toEqual({
            pendingChangeId: 'pending-1',
            review: completeReview,
        });
        expect(readPendingPluginChangeReview({
            action: 'install',
            change: { kind: 'reviewRequired', pendingChangeId: '', review: {} },
        }, 'install', 'example.plugin')).toBeNull();
    });

    it('fails closed when any complete review-fact class is absent and renders every semantic class', () => {
        const { signature: _missing, ...incompleteReview } = completeReview;
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', pendingChangeId: 'pending-1', review: incompleteReview },
        }, 'install', 'example.plugin')).toBeNull();
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired',
                pendingChangeId: 'pending-1',
                review: { ...completeReview, displayName: 'x'.repeat(32_769) },
            },
        }, 'install', 'example.plugin')).toBeNull();

        const body = formatPluginInstallationReviewBody(completeReview);
        expect(body).toContain('Identity:');
        expect(body).toContain('Example Publisher');
        expect(body).toContain('registry profile registry_private');
        expect(body).toContain('Verification signals:');
        expect(body).toContain('Reviewed for the curated channel');
        expect(body).toContain('Contributions: actions (1)');
        expect(body).toContain('Required disclosures and cooperative services:');
        expect(body).toContain('Optional host-owned resources');
        expect(body).toContain('Compatibility and updates:');
        expect(body).toContain('Update policy: automatic');

        const notProvidedBody = formatPluginInstallationReviewBody({
            ...completeReview,
            signature: { status: 'notProvided' },
            provenance: { status: 'notProvided' },
        });
        expect(notProvidedBody).toContain('Signature: Not provided');
        expect(notProvidedBody).toContain('Provenance: Not provided');
    });

    it('accepts the bounded review and committed result shapes for marketplace updates', () => {
        const updateReview = {
            action: 'update',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired',
                pendingChangeId: 'pending-update-1',
                review: {
                    ...completeReview,
                    requiredHostAccess: [],
                    optionalHostAccess: [],
                },
            },
        };

        expect(readPendingPluginChangeReview(updateReview, 'update', 'example.plugin')?.pendingChangeId).toBe('pending-update-1');
        expect(readPendingPluginChangeReview(updateReview, 'install', 'example.plugin')).toBeNull();
        expect(readPendingPluginChangeReview(updateReview, 'update', 'other.plugin')).toBeNull();
        expect(readPluginChangeKind(updateReview, 'update', 'example.plugin')).toBe('reviewRequired');
        expect(readPluginChangeKind({
            action: 'update',
            pluginId: 'example.plugin',
            change: { kind: 'committed' },
        }, 'update', 'example.plugin')).toBe('committed');
        expect(readPluginChangeKind(updateReview, 'install', 'example.plugin')).toBeNull();
        expect(readPluginChangeKind(updateReview, 'update', 'other.plugin')).toBeNull();
    });

    it.each([
        ['install', null, { ...installed, version: '2.0.0' }, '2.0.0', true],
        ['install', null, null, '2.0.0', false],
        ['update', installed, { ...installed, version: '2.0.0' }, '2.0.0', true],
        ['update', installed, installed, '2.0.0', false],
        ['rollback', installed, { ...installed, version: '0.9.0' }, null, true],
        ['rollback', installed, installed, null, false],
        ['uninstall', installed, null, null, true],
        ['uninstall', installed, installed, null, false],
        ['forgetTrust', installed, {
            ...installed,
            enabled: false,
            source: { ...installed.source, trustPolicy: 'untrusted' },
        }, null, true],
        ['forgetTrust', installed, installed, null, false],
    ] as const)(
        'derives a visible %s result only from the authoritative refreshed installed state',
        (method, before, after, targetVersion, expected) => {
            expect(isPluginMutationVisibleAfterRefresh({
                method,
                pluginId: installed.pluginId,
                before,
                after,
                targetVersion,
            })).toBe(expected);
        },
    );
});
