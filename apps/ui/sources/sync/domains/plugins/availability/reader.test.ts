import { describe, expect, it, vi } from 'vitest';

import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginMachineMaterializationV1Schema,
} from '@happier-dev/protocol/plugins/availability';

// The app build emits this module; vitest resolves the platform-neutral empty
// variant. Standing in one host-bundled entry is a build-artifact boundary, not
// a substitute for any reader logic under test.
vi.mock('./generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([Object.freeze({
        pluginId: 'happier.fixture',
        contributionId: 'fixture-list-page-native',
        tier: 'reactNative' as const,
        platform: 'web' as const,
        digest: `sha256:${'d'.repeat(64)}`,
        releaseVersion: '0.0.0',
        files: Object.freeze([Object.freeze({
            relativePath: 'react-native-web/fixture-list-page-native/entry.mjs.bundle',
            asset: 'fixture-web-entry',
        })]),
    })]),
}));

import {
    createPluginAccountAvailabilityReader,
    createPluginAccountAvailabilityReaderStore,
    type PluginAccountAvailabilitySnapshot,
} from './reader';

const scope = { serverId: 'srv-local-a', accountId: 'account-a' } as const;

const hostedSlot = {
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
};
const artifactDigest = `sha256:${'b'.repeat(64)}`;

function intentRead() {
    const releaseCompatibility = {
        hostUiApiVersion: '1.0.0',
    };
    const hostCompatibility = {
        hostAppVersion: '1.0.0',
        ...releaseCompatibility,
        reactVersion: '19.2.0',
        platform: 'web' as const,
        channel: 'store' as const,
        nativeCapabilities: ['safe-area'],
    };
    return PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: 42,
        hostingCapability: {
            enabled: true,
            maxArtifactBytes: 1024,
            maxAccountBytes: 2048,
        },
        intent: {
            pluginId: 'com.acme.fixture',
            desiredVersion: '1.2.3',
            enabled: true,
            offlineUiHosting: 'enabled',
            writableCollections: [],
            revision: 'intent-1',
        },
        release: {
            ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: {
                schemaVersion: 2,
                id: 'com.acme.fixture',
                version: '1.2.3',
                displayName: 'Fixture',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                contributes: {},
            },
            collectionContracts: [],
            uiSlots: [{
                ...hostedSlot,
                artifactDigest,
                compatibility: releaseCompatibility,
            }],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                resources: [],
            },
        },
        uiArtifacts: [{
            release: { pluginId: 'com.acme.fixture', version: '1.2.3' },
            ...hostedSlot,
            artifactId: '00000000-0000-4000-8000-000000000001',
            artifactDigest,
            compatibility: hostCompatibility,
        }],
    });
}

function snapshot(overrides: Partial<PluginAccountAvailabilitySnapshot> = {}): PluginAccountAvailabilitySnapshot {
    return {
        availabilityCursor: 42,
        intentReads: [],
        materializations: [PluginMachineMaterializationV1Schema.parse({
            serverIdentityId: 'srv_fixture',
            machineId: 'machine-1',
            materializationId: 'install-1',
            pluginId: 'com.acme.fixture',
            version: '1.2.3',
            sourceClass: 'registryPackage',
            portableRelease: true,
            uiArtifacts: [{
                contributionId: 'hosted',
                tier: 'hostedWeb',
                platform: 'web',
                artifactDigest: `sha256:${'a'.repeat(64)}`,
            }],
            enabled: false,
            trustState: 'revoked',
            observedAt: 1_700_000_000_000,
        })],
        ...overrides,
    };
}

describe('Plugin Account Availability reader', () => {
    const hostBundledSlot = {
        pluginId: 'happier.fixture',
        contributionId: 'fixture-list-page-native',
        tier: 'reactNative' as const,
        platform: 'web' as const,
    };

    it('admits the app-package coordinate for a host-bundled plugin the Account can never hold a release for', () => {
        const reader = createPluginAccountAvailabilityReader({ scope, snapshot: snapshot() });

        expect(reader.readCurrentArtifact(hostBundledSlot)).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            artifact: {
                pluginId: 'happier.fixture',
                contributionId: 'fixture-list-page-native',
                tier: 'reactNative',
                platform: 'web',
                digest: `sha256:${'d'.repeat(64)}`,
                releaseVersion: '0.0.0',
            },
        });
    });

    it('never lets host-bundled bytes override an Account intent that exists for the same plugin', () => {
        const response = intentRead();
        const intent = response.intent;
        if (!intent) throw new Error('Fixture requires a current intent.');
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'happier.fixture',
                    response: {
                        ...response,
                        intent: { ...intent, pluginId: 'happier.fixture', enabled: false },
                        release: response.release
                            ? {
                                ...response.release,
                                ref: { pluginId: 'happier.fixture', version: '1.2.3' },
                                normalizedManifest: {
                                    ...response.release.normalizedManifest,
                                    id: 'happier.fixture',
                                },
                            }
                            : response.release,
                        uiArtifacts: response.uiArtifacts.map((link) => ({
                            ...link,
                            release: { pluginId: 'happier.fixture', version: '1.2.3' },
                        })),
                    },
                }],
            },
        });

        expect(reader.readCurrentArtifact(hostBundledSlot)).toEqual({
            kind: 'unavailable',
            code: 'artifact_not_current',
        });
    });

    it('projects only Account currentness/materialization facts and never a byte-source or renderer URL selector', () => {
        const reader = createPluginAccountAvailabilityReader({ scope, snapshot: snapshot() });

        expect(reader).not.toHaveProperty('readHostedWebArtifact');
        expect(reader.readMaterializations()).toMatchObject({
            kind: 'available',
            availabilityCursor: 42,
            materializations: [expect.objectContaining({
                materializationId: 'install-1',
                enabled: false,
                trustState: 'revoked',
            })],
        });
    });

    it('derives the current Artifact coordinate from the canonical intent-read response without granting a byte source', () => {
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: intentRead(),
                }],
            },
        });

        expect(reader.readCurrentArtifact({
            pluginId: 'com.acme.fixture',
            ...hostedSlot,
        })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            artifact: expect.objectContaining({
                pluginId: 'com.acme.fixture',
                contributionId: 'hosted',
                tier: 'hostedWeb',
                platform: 'web',
                accountArtifactId: '00000000-0000-4000-8000-000000000001',
                accountArtifactCompatibility: {
                    hostAppVersion: '1.0.0',
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.2.0',
                    platform: 'web',
                    channel: 'store',
                    nativeCapabilities: ['safe-area'],
                },
                digest: artifactDigest,
                releaseVersion: '1.2.3',
            }),
        });
        expect(reader.readCurrentArtifact({
            pluginId: 'com.acme.fixture',
            ...hostedSlot,
        })).not.toHaveProperty('artifact.entryPath');
    });

    it('withholds Account-hosted provenance when hosting is unavailable or the intent opts out while preserving Artifact admission', () => {
        const response = intentRead();
        const intent = response.intent;
        if (!intent) throw new Error('Fixture requires a current intent.');
        for (const input of [
            { hostingCapability: { enabled: false as const }, offlineUiHosting: 'enabled' as const },
            { hostingCapability: response.hostingCapability, offlineUiHosting: 'disabled' as const },
        ]) {
            const reader = createPluginAccountAvailabilityReader({
                scope,
                snapshot: {
                    ...snapshot(),
                    intentReads: [{
                        pluginId: 'com.acme.fixture',
                        response: {
                            ...response,
                            hostingCapability: input.hostingCapability,
                            intent: { ...intent, offlineUiHosting: input.offlineUiHosting },
                        },
                    }],
                },
            });

            expect(reader.readCurrentArtifact({
                pluginId: 'com.acme.fixture',
                ...hostedSlot,
            })).toEqual({
                kind: 'available',
                availabilityCursor: 42,
                artifact: {
                    pluginId: 'com.acme.fixture',
                    contributionId: 'hosted',
                    tier: 'hostedWeb',
                    platform: 'web',
                    digest: artifactDigest,
                    releaseVersion: '1.2.3',
                },
            });
        }
    });

    it('admits only the current enabled release Package Asset descriptor without exposing its Artifact transport', () => {
        const response = intentRead();
        if (!response.release) throw new Error('Fixture requires a current release.');
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response,
                }],
            },
        });

        expect(reader.readCurrentPackageAsset({ pluginId: 'com.acme.fixture' })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            packageAsset: {
                pluginId: 'com.acme.fixture',
                releaseVersion: '1.2.3',
                descriptor: response.release.packageAssetArchive,
            },
        });
        expect(reader.readCurrentPackageAsset({ pluginId: 'com.acme.fixture' }))
            .not.toHaveProperty('packageAsset.artifactId');
    });

    it('admits the current normalized declaration for Account Settings even when activation is disabled', () => {
        const response = intentRead();
        if (!response.intent || !response.release) throw new Error('Fixture requires a current release.');
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: {
                        ...response,
                        intent: { ...response.intent, enabled: false },
                    },
                }],
            },
        });

        expect(reader.readCurrentSettingsDeclaration({ pluginId: 'com.acme.fixture' })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            declaration: response.release.normalizedManifest,
        });
    });

    it('admits the current Account release selection with its CAS revision even while the release is disabled', () => {
        const response = intentRead();
        if (!response.intent || !response.release) throw new Error('Fixture requires a current release.');
        const disabledIntent = { ...response.intent, enabled: false };
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: {
                        ...response,
                        intent: disabledIntent,
                    },
                }],
            },
        });

        expect(reader.readCurrentReleaseSelection({ pluginId: 'com.acme.fixture' })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            intent: disabledIntent,
            release: {
                ref: response.release.ref,
                normalizedManifest: response.release.normalizedManifest,
            },
        });
        expect(reader.readCurrentCollectionCapability({ pluginId: 'com.acme.fixture' })).toEqual({
            kind: 'unavailable',
            code: 'collection_not_current',
        });
    });

    it('projects only the exact immutable Collection ref admitted by the current release', () => {
        const ref = {
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
            schemaVersion: 2,
            contractDigest: 'A'.repeat(43),
        };
        const response = intentRead();
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: {
                        ...response,
                        release: response.release
                            ? { ...response.release, collectionContracts: [ref] }
                            : null,
                    },
                }],
            },
        });

        expect(reader.readCurrentCollectionContract({
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
        })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            ref,
        });
        expect(reader.readCurrentCollectionContract({
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
        })).not.toHaveProperty('contract');
        expect(reader.readCurrentCollectionContract({
            pluginId: 'com.acme.fixture',
            collectionId: 'projects',
        })).toEqual({
            kind: 'unavailable',
            code: 'collection_not_current',
        });
    });

    it('admits Account Data rendering only when the current enabled release has a Collection contract', () => {
        const ref = {
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
            schemaVersion: 2,
            contractDigest: 'A'.repeat(43),
        };
        const response = intentRead();
        const readerFor = (input: Readonly<{
            contracts: readonly typeof ref[];
            enabled?: boolean;
        }>) => createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: {
                        ...response,
                        intent: response.intent
                            ? { ...response.intent, enabled: input.enabled ?? true }
                            : null,
                        release: response.release
                            ? { ...response.release, collectionContracts: input.contracts }
                            : null,
                    },
                }],
            },
        });

        expect(readerFor({ contracts: [] }).readCurrentCollectionCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({
            kind: 'unavailable',
            code: 'collection_not_current',
        });
        // Read capability is release-declared, not inferred from the mutable
        // intent list. CAS remains Data-owned and can require a writable grant.
        expect(readerFor({ contracts: [ref] }).readCurrentCollectionCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
        });
        expect(readerFor({ contracts: [ref], enabled: false }).readCurrentCollectionCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({
            kind: 'unavailable',
            code: 'collection_not_current',
        });
    });

    it('derives exact Account-release correspondence from a strict materialization without electing a machine', () => {
        const response = intentRead();
        const currentRelease = response.release;
        if (!currentRelease) throw new Error('Fixture requires a current release.');
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response,
                }],
            },
        });
        const classifyRelease = reader.classifyRelease;
        const exact = {
            ...snapshot().materializations[0]!,
            enabled: true,
            trustState: 'trusted' as const,
            archiveDigestSha256: currentRelease.archiveDigestSha256,
            uiArtifacts: currentRelease.uiSlots.map(({ compatibility: _compatibility, ...slot }) => slot),
        };
        const identity = {
            serverIdentityId: exact.serverIdentityId,
            materializationRef: {
                machineId: exact.machineId,
                materializationId: exact.materializationId,
                pluginId: exact.pluginId,
            },
        };

        expect(classifyRelease(exact)).toEqual({
            ...identity,
            releaseContent: 'matched',
            validation: { kind: 'admitted' },
        });
        for (const correspondenceMismatch of [
            PluginMachineMaterializationV1Schema.parse({
                ...exact,
                version: '1.2.4',
            }),
            PluginMachineMaterializationV1Schema.parse({
                ...exact,
                uiArtifacts: [{
                    ...exact.uiArtifacts[0]!,
                    artifactDigest: `sha256:${'c'.repeat(64)}`,
                }],
            }),
        ]) {
            expect(classifyRelease(correspondenceMismatch)).toEqual({
                ...identity,
                releaseContent: 'conflict',
                validation: { kind: 'admitted' },
            });
        }
        expect(classifyRelease({ ...exact, portableRelease: false })).toEqual({
            ...identity,
            releaseContent: 'unknown',
            validation: { kind: 'rejected', reason: 'unknown' },
        });
    });

    it('fails closed after the store moves to a different Account scope', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: snapshot() });
        const reader = store.bind({ serverId: 'srv-local-a', accountId: 'account-b' });

        expect(reader.readMaterializations())
            .toEqual({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
    });

    it('replaces one complete materialization projection atomically', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: snapshot() });
        const reader = store.bind(scope);

        expect(reader.readMaterializations()).toMatchObject({
            kind: 'available',
            availabilityCursor: 42,
        });
        store.replace({ scope, snapshot: snapshot({
            availabilityCursor: 43,
            materializations: [],
        }) });
        expect(reader.readMaterializations()).toEqual({
            kind: 'available',
            availabilityCursor: 43,
            materializations: [],
        });
    });

    it('snapshots caller-owned nested release, intent, and materialization facts at reader ingestion', () => {
        const response = intentRead();
        const intent = response.intent;
        const release = response.release;
        if (!intent || !release) throw new Error('Fixture requires a current intent and release.');
        const mutableResponse = {
            ...response,
            intent: {
                ...intent,
                writableCollections: [...intent.writableCollections],
            },
            release: {
                ...release,
                normalizedManifest: {
                    ...release.normalizedManifest,
                    engines: { ...release.normalizedManifest.engines },
                },
                collectionContracts: [...release.collectionContracts],
                uiSlots: release.uiSlots.map((slot) => ({
                    ...slot,
                    compatibility: { ...slot.compatibility },
                })),
                packageAssetArchive: {
                    ...release.packageAssetArchive,
                    resources: [...release.packageAssetArchive.resources],
                },
            },
            uiArtifacts: response.uiArtifacts.map((artifact) => ({
                ...artifact,
                release: { ...artifact.release },
                compatibility: {
                    ...artifact.compatibility,
                    nativeCapabilities: [...artifact.compatibility.nativeCapabilities],
                },
            })),
        };
        const mutableMaterializations = snapshot().materializations.map((materialization) => ({
            ...materialization,
            uiArtifacts: materialization.uiArtifacts.map((artifact) => ({ ...artifact })),
        }));
        const mutableSnapshot = {
            availabilityCursor: 42,
            intentReads: [{
                pluginId: 'com.acme.fixture',
                response: mutableResponse,
            }],
            materializations: mutableMaterializations,
        };
        const directReader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: mutableSnapshot,
        });
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: mutableSnapshot });
        const liveReader = store.bind(scope);

        // These mutations model the transport/projection owner reusing its
        // input graph after ingestion. Neither reader may silently adopt them
        // without a new Account Availability replacement/cursor notification.
        mutableResponse.intent.enabled = false;
        mutableResponse.intent.writableCollections.push({
            pluginId: 'com.acme.fixture',
            collectionId: 'mutated',
            schemaVersion: 1,
            contractDigest: 'm'.repeat(43),
        });
        mutableResponse.release.normalizedManifest.displayName = 'Mutated fixture';
        mutableResponse.release.uiSlots.splice(0, 1);
        mutableMaterializations[0]!.enabled = true;
        mutableMaterializations[0]!.uiArtifacts.splice(0, 1);

        for (const reader of [directReader, liveReader]) {
            expect(reader.readCurrentArtifact({
                pluginId: 'com.acme.fixture',
                ...hostedSlot,
            })).toMatchObject({
                kind: 'available',
                artifact: {
                    digest: artifactDigest,
                    releaseVersion: '1.2.3',
                },
            });
            expect(reader.readCurrentSettingsDeclaration({ pluginId: 'com.acme.fixture' }))
                .toMatchObject({
                    kind: 'available',
                    declaration: { displayName: 'Fixture' },
                });
            expect(reader.readMaterializations()).toMatchObject({
                kind: 'available',
                materializations: [{
                    enabled: false,
                    uiArtifacts: [{ contributionId: 'hosted' }],
                }],
            });
        }
    });
});
