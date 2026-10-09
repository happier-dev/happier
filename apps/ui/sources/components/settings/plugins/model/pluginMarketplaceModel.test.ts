import { describe, expect, it } from 'vitest';

import { PluginInstallationReviewSchema } from '@happier-dev/protocol/marketplace/internal';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';

import {
    createPluginSettingsViews,
    buildDiscoverQueryFilters,
    filterInstalledPlugins,
    groupDiscoverEntriesByShelf,
    projectBrowseShelves,
    isPluginMutationVisibleAfterRefresh,
    projectDevelopmentPluginPresentation,
    projectInstalledPluginLifecycleCapabilities,
    projectInstalledPluginPresentation,
    readDevelopmentPlugins,
    readPendingPluginChangeReview,
    readPendingPluginChangeStatus,
    readPendingPluginChanges,
    readPluginChangeKind,
    resolvePluginDaemonOperationsAvailability,
    resolvePluginReadOnlySnapshotNotice,
    resolvePluginTruthReadState,
    installedPluginVersionLabel,
    partitionInstalledPlugins,
    type DevelopmentPluginEntry,
    type InstalledPluginEntry,
} from './pluginMarketplaceModel';

/**
 * Built from the canonical serialized-review fixture beside the cross-process
 * schema, so these tests parse and present the exact review shape the CLI
 * daemon projects instead of a UI-local copy that can drift from it.
 */
const completeReview = createPluginInstallationReviewFixture({
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
    updatePolicy: 'allowed',
});

const installed: InstalledPluginEntry = {
    pluginId: 'example.plugin',
    title: 'Example',
    description: null,
    version: '1.0.0',
    enabled: true,
    source: {
        kind: 'marketplace',
        locator: '@example/plugin',
        trustPolicy: 'prompt',
        installPolicy: 'managed_install',
    },
    install: {
        mode: 'managed_install',
        manifestVersion: '1',
    },
    compatibility: {
        status: 'compatible',
        diagnostics: [],
    },
    diagnostics: [],
};

describe('selected plugin truth read lifecycle', () => {
    it('keeps an online target unresolved until its fresh execution target exists', () => {
        expect(resolvePluginTruthReadState({
            targetOnline: true,
            hasExecutionTarget: false,
            capabilitiesLoaded: false,
            daemonAdministrationAvailable: false,
            projectionPhase: 'idle',
        })).toEqual({ targetResolving: true, installedPluginsRead: false, pluginTruthSettled: false });
    });

    it('settles no-target truth but keeps a failed enrichment independent of installed inventory', () => {
        expect(resolvePluginTruthReadState({
            targetOnline: false,
            hasExecutionTarget: false,
            capabilitiesLoaded: false,
            daemonAdministrationAvailable: false,
            projectionPhase: 'idle',
        })).toEqual({ targetResolving: false, installedPluginsRead: true, pluginTruthSettled: true });
        expect(resolvePluginTruthReadState({
            targetOnline: true,
            hasExecutionTarget: true,
            capabilitiesLoaded: true,
            daemonAdministrationAvailable: true,
            projectionPhase: 'error',
        })).toEqual({ targetResolving: false, installedPluginsRead: true, pluginTruthSettled: false });
    });
});

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
            canUpdate: false,
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
            // A record whose trust was forgotten has no trusted update channel
            // left for the daemon update owner to advance.
            canUpdate: false,
        });
    });

    it('offers the canonical update action from the installed record alone, with no marketplace listing in sight', () => {
        expect(projectInstalledPluginLifecycleCapabilities({
            ...installed,
            enabled: true,
            source: {
                ...installed.source,
                trustPolicy: 'prompt',
            },
        })).toMatchObject({ canUpdate: true });
    });
});

describe('installed marketplace catalog formatting', () => {
    it.each(['loading', 'error'] as const)(
        'keeps direct administration available while the merged projection is %s',
        (projectionPhase) => {
            const capabilityState = {
                status: 'loaded' as const,
                snapshot: {
                    response: {
                        protocolVersion: 1 as const,
                        results: {
                            'tool.plugins': { ok: true as const, checkedAt: 1, data: {} },
                        },
                    },
                },
            };

            expect(resolvePluginDaemonOperationsAvailability({
                hasExactExecutionTarget: true,
                daemonTransportOnline: true,
                capabilityStateIsCurrent: true,
                capabilityState,
                projectionPhase,
            })).toEqual({ administration: true, projection: false });
        },
    );

    it('fails both operation ceilings closed without a current reachable daemon capability', () => {
        expect(resolvePluginDaemonOperationsAvailability({
            hasExactExecutionTarget: true,
            daemonTransportOnline: false,
            capabilityStateIsCurrent: true,
            capabilityState: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'tool.plugins': { ok: true, checkedAt: 1, data: {} },
                        },
                    },
                },
            },
            projectionPhase: 'ready',
        })).toEqual({ administration: false, projection: false });
    });

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

    it('does not report a disconnect while a reachable transport is still reading plugin truth', () => {
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
        })).toEqual({ reason: 'refreshing' });
    });

    it('reads a selected machine that is still resolving as checking, never as disconnected', () => {
        const resolving = {
            daemonOperationsAvailable: false,
            daemonTransportOnline: false,
            targetResolving: true,
            projectionPhase: 'idle' as const,
            hasCapabilitySnapshot: false,
            installedPluginCount: 0,
            developmentPluginCount: 0,
            hasCatalog: false,
            hasMarketplaceSourceRegistry: false,
            hasProjectionInputs: false,
        };
        expect(resolvePluginReadOnlySnapshotNotice(resolving)).toBeNull();
        expect(resolvePluginReadOnlySnapshotNotice({ ...resolving, hasCapabilitySnapshot: true, installedPluginCount: 2 }))
            .toEqual({ reason: 'refreshing' });
        // A cached read failure from before is not proof the machine is gone.
        expect(resolvePluginReadOnlySnapshotNotice({ ...resolving, capabilityReadFailed: true })).toBeNull();
        // Once resolved and away, it is offline.
        expect(resolvePluginReadOnlySnapshotNotice({ ...resolving, targetResolving: false }))
            .toEqual({ reason: 'disconnected' });
    });

    it('never shows a version that means nothing: none for plugins that ship with Happier, none for 0.0.0', () => {
        const base = {
            pluginId: 'p', title: 'P', description: null, enabled: true,
            install: { mode: 'copy' as const, manifestVersion: '1.0.0' },
            compatibility: { status: 'compatible' as const, diagnostics: [] }, diagnostics: [],
        };
        expect(installedPluginVersionLabel({ ...base, version: '1.2.0', source: { kind: 'npm', locator: '@acme/p' } } as never)).toBe('1.2.0');
        expect(installedPluginVersionLabel({ ...base, version: '0.0.0', source: { kind: 'npm', locator: '@acme/p' } } as never)).toBeNull();
        expect(installedPluginVersionLabel({ ...base, version: '0.6.0', source: { kind: 'bundled', locator: 'p' } } as never)).toBeNull();
    });

    it('separates the plugins the user added from the ones that ship with Happier', () => {
        const entry = (pluginId: string, kind: string) => ({ pluginId, source: { kind, locator: pluginId } }) as never;
        const { added, included } = partitionInstalledPlugins([entry('a', 'npm'), entry('b', 'bundled'), entry('c', 'localPath')]);
        expect(added.map((row: { pluginId: string }) => row.pluginId)).toEqual(['a', 'c']);
        expect(included.map((row: { pluginId: string }) => row.pluginId)).toEqual(['b']);
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

    it('parses the bounded staged installation review returned by the daemon capability', () => {
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
                pendingChangeId: 'pending-1',
                review: completeReview,
            },
        }, 'install', 'example.plugin')).toEqual({
            pendingChangeId: 'pending-1',
            reason: 'firstInstall',
            currentVersion: null, authorityExpansion: [],
            review: completeReview,
        });
        expect(readPendingPluginChangeReview({
            action: 'install',
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: '', review: {} },
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
            updatePolicy: 'allowed',
        };

        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-local-integrity', review },
        }, 'install', 'example.plugin')).toBeNull();
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
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
                kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
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
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-blocked-newer', review },
        }, 'install', 'example.plugin');

        expect(parsed?.review.compatibility.blockedNewerVersions).toEqual(
            review.compatibility.blockedNewerVersions,
        );
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
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
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-daemon-entry', review },
        }, 'install', 'example.plugin')).toEqual({
            pendingChangeId: 'pending-daemon-entry',
            reason: 'firstInstall',
            currentVersion: null, authorityExpansion: [],
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
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-ui-artifact', review },
        }, 'install', 'example.plugin')).toEqual({
            pendingChangeId: 'pending-ui-artifact',
            reason: 'firstInstall',
            currentVersion: null, authorityExpansion: [],
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
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-incompatible-engine', review },
        }, 'install', 'example.plugin')).toEqual({
            pendingChangeId: 'pending-incompatible-engine',
            reason: 'firstInstall',
            currentVersion: null, authorityExpansion: [],
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
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-selected-engine', review },
        }, 'install', 'example.plugin')).toEqual({
            pendingChangeId: 'pending-selected-engine',
            reason: 'firstInstall',
            currentVersion: null, authorityExpansion: [],
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
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-no-engine', review },
        }, 'install', 'example.plugin');

        expect(parsed?.review.compatibility).toEqual({ runtimeApiVersion: 1 });
    });

    it('fails closed when any complete review-fact class is absent and renders every semantic class', () => {
        const { signature: _missing, ...incompleteReview } = completeReview;
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-1', review: incompleteReview },
        }, 'install', 'example.plugin')).toBeNull();
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
                pendingChangeId: 'pending-1',
                review: { ...completeReview, displayName: 'x'.repeat(32_769) },
            },
        }, 'install', 'example.plugin')).toBeNull();

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
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-raw', review: rawReview },
        }, 'install', 'example.plugin');
        const { rawCredentialAccess: _omittedRawCredentialAccess, ...undisclosedReview } = completeReview;

        expect(parsed).not.toBeNull();
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: 'example.plugin',
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-missing-raw', review: undisclosedReview },
        }, 'install', 'example.plugin')).toBeNull();
    });

    it('accepts the bounded review and committed result shapes for marketplace updates', () => {
        const updateReview = {
            action: 'update',
            pluginId: 'example.plugin',
            change: {
                kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
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
    const installationReview = {
        pendingChangeId: 'pending-2',
        reason: 'firstInstall',
        currentVersion: null, authorityExpansion: [],
        review: completeReview,
    } as const;
    const sourceRootEntry = { kind: 'reviewRequired', reviewKind: 'projectTrust', ...sourceRootReview } as const;
    const installEntry = { kind: 'reviewRequired', reviewKind: 'installation', ...installationReview } as const;

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

    it('parses a real CLI-projected review directly, by listing, and through the by-id rejoin', () => {
        // Built exactly as the CLI daemon projects a review with a declared
        // request policy: schema-sorted origins and methods, integer priority.
        const review = createPluginInstallationReviewFixture({
            requestInterceptors: [{
                id: 'rewrite-example-api',
                origins: ['https://a.example.test', 'https://b.example.test'],
                methods: ['GET', 'POST'],
                priority: 10,
            }],
        });
        // The value must remain one the CLI can actually emit: it satisfies the
        // one cross-process installation-review schema.
        expect(PluginInstallationReviewSchema.safeParse(review).success).toBe(true);

        const installationReview = {
            pendingChangeId: 'pending-cli-review',
            reason: 'firstInstall' as const,
            currentVersion: null, authorityExpansion: [],
            review,
        };

        // Direct: the change this app started.
        expect(readPendingPluginChangeReview({
            action: 'install',
            pluginId: review.pluginId,
            change: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-cli-review', review },
        }, 'install', review.pluginId)).toEqual(installationReview);

        // By-id rejoin: the same review re-read at the daemon change owner.
        expect(readPendingPluginChangeStatus({
            action: 'changeStatus',
            pendingChangeId: 'pending-cli-review',
            status: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-cli-review', review },
        })).toEqual({ kind: 'installation', installationReview });

        // Enumeration: a change some other client prepared.
        expect(readPendingPluginChanges(stateWith([
            { kind: 'reviewRequired', reviewKind: 'installation', ...installationReview },
        ]) as never)).toEqual([
            { kind: 'installation', installationReview },
        ]);

    });

    it('lists both decision shapes and an already-decided change', () => {
        expect(readPendingPluginChanges(
            stateWith([sourceRootEntry, installEntry, { kind: 'applying', pendingChangeId: 'pending-3' }]) as never,
        )).toEqual([
            { kind: 'projectTrust', projectTrustReview: sourceRootReview },
            { kind: 'installation', installationReview },
            { kind: 'applying', pendingChangeId: 'pending-3' },
        ]);
    });

    it('drops an entry it cannot fully type instead of offering it for approval', () => {
        // A half-read review would let a user approve host access the app never
        // rendered, so an unreadable entry is not listed at all.
        expect(readPendingPluginChanges(stateWith([
            { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-4', review: { pluginId: 'example.plugin' } },
            { kind: 'applying' },
            { kind: 'terminal', pendingChangeId: 'pending-5' },
            sourceRootEntry,
        ]) as never)).toEqual([
            { kind: 'projectTrust', projectTrustReview: sourceRootReview },
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
            kind: 'projectTrust',
            projectTrustReview: sourceRootReview,
        });
        expect(status({ kind: 'applying', pendingChangeId: 'pending-1' }))
            .toEqual({ kind: 'applying', pendingChangeId: 'pending-1' });
        expect(status({ kind: 'expired' })).toEqual({ kind: 'expired' });
        expect(status({ kind: 'daemonUnavailable' })).toEqual({ kind: 'daemonUnavailable' });
        expect(status({
            kind: 'terminal',
            pendingChangeId: 'pending-1',
            result: { kind: 'committed', pluginId: 'example.plugin' },
        })).toEqual({
            kind: 'terminal',
            pendingChangeId: 'pending-1',
            outcome: 'committed',
            pluginId: 'example.plugin',
        });
        // A terminal outcome that names no plugin still reconciles by pending
        // id alone; the affected-plugin identity stays null rather than absent.
        expect(status({
            kind: 'terminal',
            pendingChangeId: 'pending-1',
            result: { kind: 'cancelled' },
        })).toEqual({
            kind: 'terminal',
            pendingChangeId: 'pending-1',
            outcome: 'cancelled',
            pluginId: null,
        });
        expect(status({ kind: 'somethingElse', pendingChangeId: 'pending-1' })).toBeNull();
        // A status read is never confused with the develop action's envelope.
        expect(readPendingPluginChangeStatus({ action: 'develop', status: sourceRootEntry })).toBeNull();
    });
});

/**
 * The row presentation replaces a pipe-separated subtitle that concatenated the
 * enablement word, the raw source kind and locator, a raw compatibility code
 * and the first diagnostic message into one line. These tests pin the two
 * properties that made that a defect: a row states exactly one status, and it
 * never carries a technical code a reader cannot act on.
 */
describe('installed plugin row presentation', () => {
    it('states one status and a concise origin, and keeps raw locators and codes off the row', () => {
        const presentation = projectInstalledPluginPresentation({
            ...installed,
            source: { ...installed.source, kind: 'npm', locator: '@example/plugin' },
        });

        expect(presentation.status).toMatchObject({ id: 'enabled', variant: 'success' });
        expect(presentation.attentionLabel).toBeNull();
        expect(presentation.sourceLabel).not.toContain('@example/plugin');
        expect(presentation.sourceLabel).not.toContain('npm:');
        expect([presentation.sourceLabel, presentation.status.label].join(' ')).not.toContain('|');
    });

    it('ranks withdrawn trust above a compatibility refusal and a reported defect', () => {
        const incompatibleAndUntrusted = {
            ...installed,
            source: { ...installed.source, trustPolicy: 'untrusted' },
            compatibility: {
                status: 'requires_newer_host',
                diagnostics: [{ code: 'plugin_requires_newer_host', message: 'Needs a newer Happier.' }],
            },
            diagnostics: [{ code: 'plugin_load_failed', message: 'The plugin did not load.' }],
        } satisfies InstalledPluginEntry;

        expect(projectInstalledPluginPresentation(incompatibleAndUntrusted).status.id).toBe('trustRemoved');
        expect(projectInstalledPluginPresentation({
            ...incompatibleAndUntrusted,
            source: { ...installed.source, trustPolicy: 'prompt' },
        }).status.id).toBe('incompatible');
        expect(projectInstalledPluginPresentation({
            ...incompatibleAndUntrusted,
            source: { ...installed.source, trustPolicy: 'prompt' },
            compatibility: { status: 'compatible', diagnostics: [] },
        }).status.id).toBe('needsAttention');
    });

    it('surfaces the canonical diagnostic message and never its code', () => {
        const presentation = projectInstalledPluginPresentation({
            ...installed,
            diagnostics: [{ code: 'plugin_entry_missing', message: 'The plugin entry file is missing.' }],
        });

        expect(presentation.attentionLabel).toBe('The plugin entry file is missing.');
        expect(presentation.attentionLabel).not.toContain('plugin_entry_missing');
    });

    it('reports a disabled plugin as user intent rather than as a defect', () => {
        expect(projectInstalledPluginPresentation({ ...installed, enabled: false }).status)
            .toMatchObject({ id: 'disabled', variant: 'neutral' });
    });
});

describe('development plugin row presentation', () => {
    const development = {
        installed: { ...installed, pluginId: 'acme.dev', title: 'Acme dev' },
        sourceRootPath: '/home/ada/projects/acme-dev',
        phase: 'active',
        occurrenceId: 'occurrence-dev',
        uiArtifactDigest: 'sha256:dev',
        actions: { test: true, pack: true, unregister: false },
    } satisfies DevelopmentPluginEntry;

    it('shows the daemon-canonical source root home-relative, like a Session working directory', () => {
        expect(projectDevelopmentPluginPresentation(development, '/home/ada').sourcePathLabel)
            .toBe('~/projects/acme-dev');
    });

    it('keeps the absolute root when the selected machine reports no home directory', () => {
        expect(projectDevelopmentPluginPresentation(development).sourcePathLabel)
            .toBe('/home/ada/projects/acme-dev');
    });

    it('does not treat a sibling-prefixed home as containing the root', () => {
        expect(projectDevelopmentPluginPresentation(development, '/home/ad').sourcePathLabel)
            .toBe('/home/ada/projects/acme-dev');
    });

    it('carries the reload diagnostic as the one actionable line when a rebuild needs attention', () => {
        const presentation = projectDevelopmentPluginPresentation({
            ...development,
            phase: 'retained_incumbent',
            diagnostic: { code: 'plugin_build_failed', message: 'The last build did not finish.' },
        }, '/home/ada');

        expect(presentation.status).toMatchObject({ id: 'needsAttention', variant: 'warning' });
        expect(presentation.attentionLabel).toBe('The last build did not finish.');
    });
});

describe('development status projection', () => {
    it('uses the daemon phase, occurrence, digest, root, and diagnostic instead of deriving reload state from the catalog', () => {
        const developmentInstalled = {
            ...installed,
            pluginId: 'acme.dev',
            source: { ...installed.source, kind: 'path', locator: '/catalog/stale', devWatch: true },
            diagnostics: [{ code: 'catalog_stale', message: 'This must not classify development state.' }],
        } satisfies InstalledPluginEntry;
        const state = {
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        'tool.plugins': {
                            ok: true,
                            checkedAt: 1,
                            data: {
                                developmentActions: { create: true, develop: true, unregister: true },
                                developmentStatus: {
                                    roots: [{ kind: 'explicit', rootPath: '/daemon/root', trusted: true, persisted: true }],
                                    plugins: [{
                                        pluginId: 'acme.dev',
                                        sourceRootPath: '/daemon/root',
                                        phase: 'retained_incumbent',
                                        occurrenceId: 'occurrence-daemon',
                                        uiArtifactDigest: 'sha256:daemon',
                                        diagnostic: { code: 'candidate_failed', message: 'Previous version remains active.' },
                                    }],
                                },
                            },
                        },
                    },
                },
            },
        };

        expect(readDevelopmentPlugins(state as never, [developmentInstalled])).toEqual([
            expect.objectContaining({
                sourceRootPath: '/daemon/root',
                phase: 'retained_incumbent',
                occurrenceId: 'occurrence-daemon',
                uiArtifactDigest: 'sha256:daemon',
                diagnostic: expect.objectContaining({ code: 'candidate_failed' }),
                actions: { test: true, pack: true, unregister: true },
            }),
        ]);
    });
});

describe('Browse shelves', () => {
    function listing(id: string, sourceKind: 'curated' | 'community-npm' | 'user', sourceId = `source:${sourceKind}`) {
        return { id, sourceId, sourceKind } as Parameters<typeof groupDiscoverEntriesByShelf>[0][number];
    }

    it('shelves results by provenance, curated first and unreviewed community last, keeping the query order inside a shelf', () => {
        const shelves = groupDiscoverEntriesByShelf([
            listing('npm.a', 'community-npm'),
            listing('curated.b', 'curated'),
            listing('mine.c', 'user'),
            listing('curated.a', 'curated'),
            listing('npm.b', 'community-npm'),
        ]);

        expect(shelves.map((shelf) => [shelf.id, shelf.entries.map((entry) => entry.id)])).toEqual([
            ['curated', ['curated.b', 'curated.a']],
            ['user', ['mine.c']],
            ['community-npm', ['npm.a', 'npm.b']],
        ]);
    });

    it('never renders an empty shelf', () => {
        expect(groupDiscoverEntriesByShelf([listing('npm.a', 'community-npm')]).map((shelf) => shelf.id)).toEqual(['community-npm']);
        expect(groupDiscoverEntriesByShelf([])).toEqual([]);
    });
});

describe('Browse categories and shelf focus', () => {
    function listing(id: string, sourceKind: 'curated' | 'community-npm' | 'user', categories: string[]) {
        return { id, sourceId: `source:${sourceKind}`, sourceKind, categories } as unknown as Parameters<typeof projectBrowseShelves>[0][number];
    }
    const entries = [
        listing('c1', 'curated', ['code']),
        listing('c2', 'curated', ['agents']),
        listing('c3', 'curated', ['code']),
        listing('c4', 'curated', ['files']),
        listing('n1', 'community-npm', ['code', 'utilities']),
    ];

    it('offers the categories the results carry, in first-seen order, and none when the catalog has none', () => {
        expect(projectBrowseShelves(entries, { category: null, focusedShelfId: null }).categories)
            .toEqual(['code', 'agents', 'files', 'utilities']);
        expect(projectBrowseShelves([listing('x', 'curated', [])], { category: null, focusedShelfId: null }).categories).toEqual([]);
    });

    it('keeps shelves compact and says how many more each holds', () => {
        const view = projectBrowseShelves(entries, { category: null, focusedShelfId: null });
        expect(view.shelves.map((shelf) => [shelf.id, shelf.entries.map((e) => e.id), shelf.hiddenCount])).toEqual([
            ['curated', ['c1', 'c2', 'c3'], 1],
            ['community-npm', ['n1'], 0],
        ]);
    });

    it('shows one whole shelf when it is focused ("See all")', () => {
        const view = projectBrowseShelves(entries, { category: null, focusedShelfId: 'curated' });
        expect(view.shelves.map((shelf) => [shelf.id, shelf.entries.length, shelf.hiddenCount])).toEqual([['curated', 4, 0]]);
    });

    it('narrows every shelf to the chosen category while keeping the full category list', () => {
        const view = projectBrowseShelves(entries, { category: 'code', focusedShelfId: null });
        expect(view.categories).toEqual(['code', 'agents', 'files', 'utilities']);
        expect(view.shelves.map((shelf) => [shelf.id, shelf.entries.map((e) => e.id)])).toEqual([
            ['curated', ['c1', 'c3']],
            ['community-npm', ['n1']],
        ]);
    });
});

describe('Browse after the results change under a chosen chip or shelf', () => {
    function listing(id: string, sourceKind: 'curated' | 'community-npm' | 'user', categories: string[]) {
        return { id, sourceId: `source:${sourceKind}`, sourceKind, categories } as unknown as Parameters<typeof projectBrowseShelves>[0][number];
    }

    it('drops a category and a focused shelf the new results no longer carry, so cards always show', () => {
        const view = projectBrowseShelves([listing('n1', 'community-npm', []), listing('n2', 'community-npm', ['tools'])], {
            category: 'agents',
            focusedShelfId: 'curated',
        });
        expect(view.category).toBeNull();
        expect(view.focusedShelfId).toBeNull();
        expect(view.shelves.map((shelf) => [shelf.id, shelf.entries.map((e) => e.id)])).toEqual([['community-npm', ['n1', 'n2']]]);
    });

    it('drops a focused shelf that has no results in the chosen category', () => {
        const view = projectBrowseShelves([listing('c1', 'curated', ['code']), listing('n1', 'community-npm', ['agents'])], {
            category: 'agents',
            focusedShelfId: 'curated',
        });
        expect(view.category).toBe('agents');
        expect(view.focusedShelfId).toBeNull();
        expect(view.shelves.map((shelf) => shelf.id)).toEqual(['community-npm']);
    });
});

describe('Discover query filters', () => {
    it('sends no source filter for All, narrows to a source, and resolves one exact listing', () => {
        expect(buildDiscoverQueryFilters({ sourceId: null })).toEqual({ includeUnavailable: true });
        expect(buildDiscoverQueryFilters({ sourceId: 's1' })).toEqual({ sourceIds: ['s1'], includeUnavailable: true });
        expect(buildDiscoverQueryFilters({ sourceId: 's1', pluginId: 'acme.tools' }))
            .toEqual({ sourceIds: ['s1'], pluginIds: ['acme.tools'], includeUnavailable: true });
    });
});

describe('Installed search and status filter', () => {
    const entry = (overrides: Partial<InstalledPluginEntry>): InstalledPluginEntry => ({ ...installed, ...overrides });
    const triage = entry({ pluginId: 'happier.triage', title: 'Triage', description: 'Sort GitHub issues into queues' });
    const linear = entry({ pluginId: 'acme.linear', title: 'Linear', enabled: false });
    const broken = entry({
        pluginId: 'acme.pdf',
        title: 'PDF preview',
        compatibility: { status: 'incompatible', diagnostics: [] },
    });
    const all = [triage, linear, broken];

    it('matches the query against name, purpose and id, ignoring case and surrounding space', () => {
        expect(filterInstalledPlugins(all, { query: '  GITHUB ', status: 'all' }).map((e) => e.pluginId)).toEqual(['happier.triage']);
        expect(filterInstalledPlugins(all, { query: 'acme.', status: 'all' }).map((e) => e.pluginId)).toEqual(['acme.linear', 'acme.pdf']);
        expect(filterInstalledPlugins(all, { query: '', status: 'all' })).toBe(all);
    });

    it('narrows by the status the row shows: enabled, disabled, or needing a decision', () => {
        expect(filterInstalledPlugins(all, { query: '', status: 'enabled' }).map((e) => e.pluginId)).toEqual(['happier.triage']);
        expect(filterInstalledPlugins(all, { query: '', status: 'disabled' }).map((e) => e.pluginId)).toEqual(['acme.linear']);
        expect(filterInstalledPlugins(all, { query: '', status: 'attention' }).map((e) => e.pluginId)).toEqual(['acme.pdf']);
    });
});
