import { describe, expect, it } from 'vitest';

import type { PluginMarketplaceCatalog } from '../readPluginMarketplaceCatalog';
import {
    createPluginSettingsViews,
    formatCatalogSubtitle,
    formatPluginInstallationReviewBody,
    isPluginMutationVisibleAfterRefresh,
    projectInstalledPluginLifecycleCapabilities,
    readPendingPluginChangeReview,
    readPendingPluginChangeStatus,
    readPendingPluginChanges,
    readPluginChangeKind,
    resolvePluginReadOnlySnapshotNotice,
    type InstalledPluginEntry,
} from './pluginMarketplaceModel';

const completeReview = {
    pluginId: 'example.plugin',
    displayName: 'Example',
    version: '2.0.0',
    packageIdentity: { name: '@example/plugin', version: '2.0.0' },
    publisherIdentity: { status: 'unverified', id: 'example', displayName: 'Example Publisher' },
    source: {
        kind: 'npm',
        locator: 'https://registry.example.test/example-plugin.tgz',
        integrity: 'sha512-exact',
        integrityBasis: 'expected',
    },
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
    rawCredentialAccess: [],
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

describe('installed plugin lifecycle capabilities', () => {
    it('does not advertise user-managed lifecycle mutations for host-bundled plugins', () => {
        expect(projectInstalledPluginLifecycleCapabilities({
            ...installed,
            enabled: true,
            rollbackAvailability: 'available',
            source: {
                kind: 'bundled',
                locator: '@happier-dev/plugins-bundled',
                trustPolicy: 'local_trusted',
            },
        })).toEqual({
            canEnable: false,
            canDisable: false,
            canRollback: false,
            canUninstall: false,
            canForgetTrust: false,
        });
    });

    it('projects only currently meaningful lifecycle actions for user-managed plugins', () => {
        expect(projectInstalledPluginLifecycleCapabilities({
            ...installed,
            enabled: false,
            rollbackAvailability: 'available',
            source: {
                ...installed.source,
                trustPolicy: 'untrusted',
            },
        })).toEqual({
            canEnable: true,
            canDisable: false,
            canRollback: true,
            canUninstall: true,
            canForgetTrust: false,
        });
    });
});

describe('installed marketplace catalog formatting', () => {
    it('resolves all four management labels from the current translation function on each render', () => {
        expect(createPluginSettingsViews((key) => key)[0]?.label).toBe('settingsPlugins.views.installed');
        expect(createPluginSettingsViews((key) => `es:${key}`)[0]?.label).toBe('es:settingsPlugins.views.installed');
    });

    it('marks catalog-only cached management metadata as a read-only snapshot while the daemon is unavailable', () => {
        expect(resolvePluginReadOnlySnapshotNotice({
            daemonOperationsAvailable: false,
            daemonTransportOnline: false,
            projectionPhase: 'idle',
            hasCapabilitySnapshot: false,
            installedPluginCount: 0,
            developmentPluginCount: 0,
            hasCatalog: true,
            hasMarketplaceSourceRegistry: false,
            hasProjectionInputs: false,
        })).toEqual({ reason: 'disconnected' });
    });

    it('reports a projection failure rather than a disconnect when the machine is still reachable', () => {
        expect(resolvePluginReadOnlySnapshotNotice({
            daemonOperationsAvailable: false,
            daemonTransportOnline: true,
            projectionPhase: 'error',
            hasCapabilitySnapshot: true,
            installedPluginCount: 2,
            developmentPluginCount: 0,
            hasCatalog: false,
            hasMarketplaceSourceRegistry: false,
            hasProjectionInputs: true,
        })).toEqual({ reason: 'projectionUnavailable' });
    });

    it('reports a projection failure when a reachable daemon does not serve the registry projection', () => {
        expect(resolvePluginReadOnlySnapshotNotice({
            daemonOperationsAvailable: false,
            daemonTransportOnline: true,
            projectionPhase: 'unsupported',
            hasCapabilitySnapshot: true,
            installedPluginCount: 1,
            developmentPluginCount: 0,
            hasCatalog: false,
            hasMarketplaceSourceRegistry: false,
            hasProjectionInputs: false,
        })).toEqual({ reason: 'projectionUnavailable' });
    });

    it('still reports a disconnect when a reachable transport has no daemon capability answer yet', () => {
        expect(resolvePluginReadOnlySnapshotNotice({
            daemonOperationsAvailable: false,
            daemonTransportOnline: true,
            projectionPhase: 'loading',
            hasCapabilitySnapshot: true,
            installedPluginCount: 1,
            developmentPluginCount: 0,
            hasCatalog: false,
            hasMarketplaceSourceRegistry: false,
            hasProjectionInputs: false,
        })).toEqual({ reason: 'disconnected' });
    });

    it('shows no notice when daemon operations are available', () => {
        expect(resolvePluginReadOnlySnapshotNotice({
            daemonOperationsAvailable: true,
            daemonTransportOnline: true,
            projectionPhase: 'ready',
            hasCapabilitySnapshot: true,
            installedPluginCount: 1,
            developmentPluginCount: 0,
            hasCatalog: true,
            hasMarketplaceSourceRegistry: true,
            hasProjectionInputs: true,
        })).toBeNull();
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

    it('accepts archive observed integrity but rejects local path and npm observed integrity claims', () => {
        const review = {
            ...completeReview,
            packageIdentity: { name: null, version: '2.0.0' },
            publisherIdentity: { status: 'unavailable' },
            source: {
                kind: 'path',
                locator: '/tmp/example-plugin',
                integrity: 'sha512-fabricated-local',
            },
            updateChannel: { kind: 'path', locator: '/tmp/example-plugin', development: false },
            signature: { status: 'notProvided' },
            provenance: { status: 'notProvided' },
            curation: { status: 'notApplicable' },
            updatePolicy: 'manual',
        };

        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', pendingChangeId: 'pending-local-integrity', review },
        }, 'install', 'example.plugin')).toBeNull();
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired',
                pendingChangeId: 'pending-archive-observed',
                review: {
                    ...completeReview,
                    source: {
                        kind: 'archive',
                        locator: 'https://registry.example.test/example-plugin.tgz',
                        integrity: 'sha512-observed',
                        integrityBasis: 'observed',
                    },
                },
            },
        }, 'install', 'example.plugin')?.pendingChangeId).toBe('pending-archive-observed');
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired',
                pendingChangeId: 'pending-npm-observed',
                review: {
                    ...completeReview,
                    source: { ...completeReview.source, integrityBasis: 'observed' },
                },
            },
        }, 'install', 'example.plugin')).toBeNull();
    });

    it('retains and explains bounded newer versions rejected before the selected artifact download', () => {
        const review = {
            ...completeReview,
            compatibility: {
                ...completeReview.compatibility,
                blockedNewerVersions: [{
                    version: '2.1.0',
                    diagnostics: [{
                        code: 'plugin_manifest_semantic_invalid',
                        message: 'Plugin manifest requires happier >=9999.0.0',
                    }],
                }],
            },
        };
        const parsed = readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', pendingChangeId: 'pending-blocked-newer', review },
        }, 'install', 'example.plugin');

        expect(parsed?.review.compatibility.blockedNewerVersions).toEqual(
            review.compatibility.blockedNewerVersions,
        );
        expect(formatPluginInstallationReviewBody(parsed!.review)).toContain(
            'Newer versions blocked before download:',
        );
        expect(formatPluginInstallationReviewBody(parsed!.review)).toContain(
            '2.1.0 [plugin_manifest_semantic_invalid]: Plugin manifest requires happier >=9999.0.0',
        );
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired',
                pendingChangeId: 'pending-too-many-blocked-newer',
                review: {
                    ...review,
                    compatibility: {
                        ...review.compatibility,
                        blockedNewerVersions: Array.from({ length: 33 }, () => (
                            review.compatibility.blockedNewerVersions[0]
                        )),
                    },
                },
            },
        }, 'install', 'example.plugin')).toBeNull();
    });

    it('accepts the bounded daemon-entry compatibility diagnostic emitted before download', () => {
        const review = {
            ...completeReview,
            compatibility: {
                ...completeReview.compatibility,
                blockedNewerVersions: [{
                    version: '2.1.0',
                    diagnostics: [{
                        code: 'plugin_manifest_semantic_invalid',
                        message: 'Plugin daemon entry uses an unsupported extension',
                    }],
                }],
            },
        };

        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', pendingChangeId: 'pending-daemon-entry', review },
        }, 'install', 'example.plugin')).toEqual({
            pendingChangeId: 'pending-daemon-entry',
            review,
        });
    });

    it('accepts the bounded generated UI artifact compatibility diagnostic emitted before download', () => {
        const review = {
            ...completeReview,
            compatibility: {
                ...completeReview.compatibility,
                blockedNewerVersions: [{
                    version: '2.1.0',
                    diagnostics: [{
                        code: 'plugin_compatibility_projection_invalid',
                        message: 'Generated UI artifact compatibility check failed: generated_ui_host_api_mismatch.',
                    }],
                }],
            },
        };

        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', pendingChangeId: 'pending-ui-artifact', review },
        }, 'install', 'example.plugin')).toEqual({
            pendingChangeId: 'pending-ui-artifact',
            review,
        });
    });

    it('accepts the bounded incompatible-engine compatibility diagnostic emitted before download', () => {
        const review = {
            ...completeReview,
            compatibility: {
                ...completeReview.compatibility,
                blockedNewerVersions: [{
                    version: '2.1.0',
                    diagnostics: [{
                        code: 'plugin_manifest_semantic_invalid',
                        message: 'Plugin manifest requires a compatible Happier CLI version',
                    }],
                }],
            },
        };

        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', pendingChangeId: 'pending-incompatible-engine', review },
        }, 'install', 'example.plugin')).toEqual({
            pendingChangeId: 'pending-incompatible-engine',
            review,
        });
    });

    it('accepts the bounded selected-engine compatibility declaration', () => {
        const review = {
            ...completeReview,
            compatibility: {
                ...completeReview.compatibility,
                happier: 'Declared compatible Happier CLI range',
            },
        };

        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', pendingChangeId: 'pending-selected-engine', review },
        }, 'install', 'example.plugin')).toEqual({
            pendingChangeId: 'pending-selected-engine',
            review,
        });
    });

    it('accepts the optional engine omission without inventing a host floor', () => {
        const review = {
            ...completeReview,
            compatibility: { runtimeApiVersion: 1 },
        };
        const parsed = readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', pendingChangeId: 'pending-no-engine', review },
        }, 'install', 'example.plugin');

        expect(parsed?.review.compatibility).toEqual({ runtimeApiVersion: 1 });
        expect(formatPluginInstallationReviewBody(parsed!.review)).toContain('Happier: Not provided');
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

    it('requires raw Voice credential disclosures and states that plugin code can receive and copy them', () => {
        const rawReview = {
            ...completeReview,
            rawCredentialAccess: [{
                accessMode: 'raw',
                contribution: { pluginId: 'acme.voice', localId: 'conversation' },
                credentialSlot: {
                    id: 'voice_auth',
                    title: 'Voice credential',
                    purpose: 'voice.client-auth',
                },
                sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
                realm: 'web',
                phase: 'connection',
                request: {
                    kind: 'httpHeaders',
                    origin: 'https://voice.example.test',
                    headerNames: ['authorization'],
                },
            }],
        };
        const parsed = readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', pendingChangeId: 'pending-raw', review: rawReview },
        }, 'install', 'example.plugin');
        const { rawCredentialAccess: _omittedRawCredentialAccess, ...undisclosedReview } = completeReview;

        expect(parsed).not.toBeNull();
        expect(formatPluginInstallationReviewBody(parsed!.review)).toContain('Raw Voice credential access:');
        expect(formatPluginInstallationReviewBody(parsed!.review)).toContain(
            'Plugin code in the web realm receives the selected credential directly and can use or copy it.',
        );
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', pendingChangeId: 'pending-missing-raw', review: undisclosedReview },
        }, 'install', 'example.plugin')).toBeNull();
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
        // The canonical update owner picks the newest compatible version from the
        // installed record, so a caller that never reviewed a candidate has no
        // target version to hold it to: the installed record advancing is the fact.
        ['update', installed, { ...installed, version: '1.4.0' }, null, true],
        ['update', installed, installed, null, false],
        ['update', installed, { ...installed, version: '1.4.0' }, '2.0.0', false],
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

    it('treats a same-version acquisition-integrity replacement as a visible external mutation', () => {
        const before = Object.assign({ ...installed }, { admittedIntegrity: 'sha512:first' });
        const after = Object.assign({ ...installed }, { admittedIntegrity: 'sha512:second' });

        expect(isPluginMutationVisibleAfterRefresh({
            method: 'rollback',
            pluginId: installed.pluginId,
            before,
            after,
            targetVersion: null,
        })).toBe(true);
    });

    it('retains structural generation identity for same-version local-path mutations', () => {
        const before = Object.assign({ ...installed }, {
            source: { ...installed.source, kind: 'path' },
            desiredGeneration: 'generation-1',
            appliedGeneration: 'generation-1',
        });
        const after = Object.assign({ ...installed }, {
            source: { ...installed.source, kind: 'path' },
            desiredGeneration: 'generation-2',
            appliedGeneration: 'generation-2',
        });

        expect(isPluginMutationVisibleAfterRefresh({
            method: 'rollback',
            pluginId: installed.pluginId,
            before,
            after,
            targetVersion: null,
        })).toBe(true);
    });
});

describe('daemon-issued pending plugin changes', () => {
    const sourceRootReview = {
        pendingChangeId: 'pending-1',
        review: { source: { kind: 'path', locator: '/workspace/plugins/agent-authored' } },
    } as const;
    const installationReview = { pendingChangeId: 'pending-2', review: completeReview } as const;
    const sourceRootEntry = { kind: 'sourceRootReviewRequired', ...sourceRootReview } as const;
    const installEntry = { kind: 'reviewRequired', ...installationReview } as const;

    const stateWith = (pendingChanges: readonly unknown[]) => ({
        status: 'loaded' as const,
        snapshot: {
            response: {
                protocolVersion: 1 as const,
                results: {
                    'tool.plugins': {
                        ok: true as const,
                        checkedAt: 0,
                        data: { installedPlugins: [], pendingChanges },
                    },
                },
            },
        },
    });

    it('lists both decision shapes and an already-decided change', () => {
        expect(readPendingPluginChanges(
            stateWith([sourceRootEntry, installEntry, { kind: 'applying', pendingChangeId: 'pending-3' }]) as never,
        )).toEqual([
            { kind: 'sourceRootReviewRequired', sourceRootReview },
            { kind: 'reviewRequired', installationReview },
            { kind: 'applying', pendingChangeId: 'pending-3' },
        ]);
    });

    it('drops an entry it cannot fully type instead of offering it for approval', () => {
        // A half-read review would let a user approve host access the app never
        // rendered, so an unreadable entry is not listed at all.
        expect(readPendingPluginChanges(stateWith([
            { kind: 'reviewRequired', pendingChangeId: 'pending-4', review: { pluginId: 'example.plugin' } },
            { kind: 'applying' },
            { kind: 'terminal', pendingChangeId: 'pending-5' },
            sourceRootEntry,
        ]) as never)).toEqual([
            { kind: 'sourceRootReviewRequired', sourceRootReview },
        ]);
    });

    it('reports no pending changes for a machine whose snapshot predates the enumeration', () => {
        expect(readPendingPluginChanges({
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: { 'tool.plugins': { ok: true, checkedAt: 0, data: { installedPlugins: [] } } },
                },
            },
        } as never)).toEqual([]);
    });

    it('projects every by-id rejoin arm the change owner can answer with', () => {
        const status = (value: unknown) => readPendingPluginChangeStatus({
            action: 'changeStatus',
            pendingChangeId: 'pending-1',
            status: value,
        });

        expect(status(sourceRootEntry)).toEqual({
            kind: 'sourceRootReviewRequired',
            sourceRootReview,
        });
        expect(status({ kind: 'applying', pendingChangeId: 'pending-1' }))
            .toEqual({ kind: 'applying', pendingChangeId: 'pending-1' });
        expect(status({ kind: 'expired' })).toEqual({ kind: 'expired' });
        expect(status({ kind: 'daemonUnavailable' })).toEqual({ kind: 'daemonUnavailable' });
        expect(status({
            kind: 'terminal',
            pendingChangeId: 'pending-1',
            result: { kind: 'committed', pluginId: 'example.plugin' },
        })).toEqual({ kind: 'terminal', pendingChangeId: 'pending-1', outcome: 'committed' });
        expect(status({ kind: 'somethingElse', pendingChangeId: 'pending-1' })).toBeNull();
        // A status read is never confused with the develop action's envelope.
        expect(readPendingPluginChangeStatus({ action: 'develop', status: sourceRootEntry })).toBeNull();
    });
});
