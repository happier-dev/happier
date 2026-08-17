import { describe, expect, it, vi } from 'vitest';

import {
    normalizePluginAccountCollectionContractsV1,
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginPortableReleaseManifestV1Schema,
    type JsonValue,
} from '@happier-dev/protocol';
import type {
    PluginAccountCollectionMigrationRuntimeProjection,
} from '@happier-dev/plugin-sdk';
import type {
    ActivePluginCollectionCandidatePreparationV1,
} from '@/sync/api/plugins/data/candidatePluginCollectionPreparation';

import type {
    CandidatePluginCollectionMigrationArtifact,
} from './candidateCollectionMigrationArtifact';
import {
    createCandidateCollectionReleaseSelector,
    type CandidateCollectionReleaseSelectionDependencies,
    type CandidateCollectionReleaseSelectionPreparationInput,
    type CandidateCollectionReleaseSelectionTarget,
} from './candidateCollectionReleaseSelection';
import {
    createPluginAccountAvailabilityReader,
    type PluginAccountAvailabilitySnapshot,
} from './reader';

const pluginId = 'example.tasks';
const sourceVersion = '1.0.0';
const targetVersion = '2.0.0';
const sourceManifest = PluginPortableReleaseManifestV1Schema.parse({
    schemaVersion: 2,
    id: pluginId,
    version: sourceVersion,
    displayName: 'Example tasks',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: 'tasks',
            schemaVersion: 1,
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string', maxLength: 256 },
                    title: { type: 'string', maxLength: 256 },
                },
                required: ['id', 'title'],
                additionalProperties: false,
            },
            rowIdField: 'id',
            serverReadable: ['id', 'title'],
            indexes: [],
            uiQueries: [],
            relations: [],
            readableSchemaVersions: [],
            migrations: [],
        }],
    },
});
const targetManifest = PluginPortableReleaseManifestV1Schema.parse({
    schemaVersion: 2,
    id: pluginId,
    version: targetVersion,
    displayName: 'Example tasks',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: 'tasks',
            schemaVersion: 2,
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string', maxLength: 256 },
                    title: { type: 'string', maxLength: 256 },
                    completed: { type: 'boolean' },
                },
                required: ['id', 'title', 'completed'],
                additionalProperties: false,
            },
            rowIdField: 'id',
            serverReadable: ['id', 'title', 'completed'],
            indexes: [],
            uiQueries: [],
            relations: [],
            readableSchemaVersions: [1],
            migrations: [{
                id: 'add-completed',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
            }],
        }],
    },
});
const sourceContracts = normalizePluginAccountCollectionContractsV1({
    pluginId,
    contributions: sourceManifest.contributes.accountCollections,
});
const targetContracts = normalizePluginAccountCollectionContractsV1({
    pluginId,
    contributions: targetManifest.contributes.accountCollections,
});
const sourceRefs = sourceContracts.map((contract) => ({
    pluginId: contract.pluginId,
    collectionId: contract.collectionId,
    schemaVersion: contract.schemaVersion,
    contractDigest: contract.contractDigest,
}));
const targetRefs = targetContracts.map((contract) => ({
    pluginId: contract.pluginId,
    collectionId: contract.collectionId,
    schemaVersion: contract.schemaVersion,
    contractDigest: contract.contractDigest,
}));

const accountLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

function createReader(input: Readonly<{ noIncumbent?: boolean }> = {}) {
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: 4,
        hostingCapability: { enabled: false },
        intent: input.noIncumbent ? null : {
            pluginId,
            desiredVersion: sourceVersion,
            enabled: true,
            offlineUiHosting: 'disabled',
            writableCollections: sourceRefs,
            revision: 'intent-1',
        },
        release: input.noIncumbent ? null : {
            ref: { pluginId, version: sourceVersion },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: sourceManifest,
            collectionContracts: sourceRefs,
            uiSlots: [],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
                resources: [],
            },
        },
        uiArtifacts: [],
    });
    const snapshot: PluginAccountAvailabilitySnapshot = {
        availabilityCursor: 4,
        intentReads: [{ pluginId, response }],
        materializations: [],
    };
    return createPluginAccountAvailabilityReader({
        scope: accountLifetime.scope,
        snapshot,
    });
}

function target(input: Readonly<{
    expectedRevision?: string | null;
    withPreparation?: boolean;
}> = {}): CandidateCollectionReleaseSelectionTarget {
    return {
        release: { pluginId, version: targetVersion },
        collectionContracts: targetRefs,
        intent: {
            enabled: true,
            offlineUiHosting: 'disabled',
            expectedRevision: input.expectedRevision === undefined ? 'intent-1' : input.expectedRevision,
        },
        ...(input.withPreparation === false ? {} : {
            preparation: {
                kind: 'direct-ui' as const,
                candidateTarget: {
                    artifact: {
                        contributionId: 'tasks-ui',
                        platform: 'ios' as const,
                        digest: `sha256:${'c'.repeat(64)}`,
                    },
                    availabilityCursor: 4,
                },
                artifact: {
                    artifactGraph: {},
                    cacheIdentity: {
                        pluginId,
                        contributionId: 'tasks-ui',
                        artifactDigest: `sha256:${'c'.repeat(64)}`,
                        hostAppVersion: '1.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.0.0',
                        reactNativeVersion: '0.83.4',
                        platform: 'ios' as const,
                        channel: 'internal' as const,
                        nativeCapabilitiesDigest: `sha256:${'d'.repeat(64)}`,
                        projectionGeneration: 1,
                    },
                },
            },
        }),
    };
}

function candidate(isCurrent: () => boolean, dispose = vi.fn()): CandidatePluginCollectionMigrationArtifact {
    const collectionMigrations: PluginAccountCollectionMigrationRuntimeProjection = Object.freeze({
        tasks: Object.freeze([Object.freeze({
            id: 'add-completed',
            fromSchemaVersion: 1,
            toSchemaVersion: 2,
            migrate: async (value: Readonly<Record<string, JsonValue>>) => ({ ...value, completed: false }),
        })]),
    });
    return Object.freeze({
        release: Object.freeze({
            ref: Object.freeze({ pluginId, version: targetVersion }),
            normalizedManifest: targetManifest,
        }),
        collectionContracts: targetContracts,
        collectionMigrations,
        isCurrent,
        dispose,
    });
}

function preparation(): ActivePluginCollectionCandidatePreparationV1 {
    return Object.freeze({
        prepare: vi.fn(async () => Object.freeze({ kind: 'prepared' as const })),
        retire: vi.fn(async () => Object.freeze({ kind: 'retired' as const })),
    });
}

describe('candidate Collection release selection', () => {
    it('creates an initial Account selection without loading an executable candidate artifact', async () => {
        const casOnlyTarget = {
            release: { pluginId, version: targetVersion },
            collectionContracts: targetRefs,
            intent: {
                enabled: true,
                offlineUiHosting: 'disabled' as const,
                expectedRevision: null,
            },
        };
        const loader = {
            load: vi.fn(async () => Object.freeze({
                kind: 'available' as const,
                candidate: candidate(() => true),
            })),
        };
        const setIntent = vi.fn(async () => Object.freeze({
            kind: 'updated' as const,
            intent: {
                pluginId,
                desiredVersion: targetVersion,
                enabled: true,
                offlineUiHosting: 'disabled' as const,
                writableCollections: targetRefs,
                revision: 'intent-0',
            },
        }));
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: loader,
            createPreparation: () => preparation(),
            setIntent,
        });

        await expect(selector.select({
            accountLifetime,
            target: casOnlyTarget,
        })).resolves.toMatchObject({ kind: 'selected', intent: { revision: 'intent-0' } });

        expect(setIntent).toHaveBeenCalledTimes(1);
        expect(setIntent).toHaveBeenCalledWith(expect.objectContaining({
            desiredVersion: targetVersion,
            writableCollections: targetRefs,
            expectedRevision: null,
        }));
        expect(loader.load).not.toHaveBeenCalled();
    });

    it('settles a no-migration server success without loading candidate code', async () => {
        const loader = {
            load: vi.fn(async () => Object.freeze({
                kind: 'available' as const,
                candidate: candidate(() => true),
            })),
        };
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: loader,
            createPreparation: () => preparation(),
            setIntent: async () => Object.freeze({
                kind: 'updated' as const,
                intent: {
                    pluginId,
                    desiredVersion: targetVersion,
                    enabled: true,
                    offlineUiHosting: 'disabled' as const,
                    writableCollections: targetRefs,
                    revision: 'intent-2',
                },
            }),
        });

        await expect(selector.select({
            reader: createReader(),
            accountLifetime,
            target: target({ withPreparation: false }),
        })).resolves.toMatchObject({ kind: 'selected', intent: { revision: 'intent-2' } });

        expect(loader.load).not.toHaveBeenCalled();
    });

    it('resolves an exact prospective direct-UI target only after Availability requires preparation', async () => {
        const loader = {
            load: vi.fn(async () => Object.freeze({
                kind: 'available' as const,
                candidate: candidate(() => true),
            })),
        };
        const direct = target().preparation;
        if (!direct || direct.kind !== 'direct-ui') throw new Error('Expected direct preparation fixture.');
        const resolve = vi.fn(async () => Object.freeze({
            kind: 'available' as const,
            candidateTarget: {
                release: { pluginId, version: targetVersion },
                ...direct.candidateTarget,
            },
            artifact: direct.artifact,
        }));
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: loader,
            createPreparation: () => preparation(),
            setIntent: vi.fn()
                .mockResolvedValueOnce(Object.freeze({ kind: 'preparationRequired' as const }))
                .mockResolvedValueOnce(Object.freeze({
                    kind: 'updated' as const,
                    intent: {
                        pluginId,
                        desiredVersion: targetVersion,
                        enabled: true,
                        offlineUiHosting: 'disabled' as const,
                        writableCollections: targetRefs,
                        revision: 'intent-2',
                    },
                })),
        });
        const lazyTarget: CandidateCollectionReleaseSelectionTarget = {
            ...target({ withPreparation: false }),
            preparation: {
                kind: 'direct-ui-target',
                resolve,
            },
        };

        await expect(selector.select({
            reader: createReader(),
            accountLifetime,
            target: lazyTarget,
        })).resolves.toMatchObject({ kind: 'selected' });

        expect(resolve).toHaveBeenCalledTimes(1);
        expect(loader.load).toHaveBeenCalledTimes(1);
    });

    it('does not load candidate code after an Availability intent conflict', async () => {
        const loader = {
            load: vi.fn(async () => Object.freeze({
                kind: 'available' as const,
                candidate: candidate(() => true),
            })),
        };
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: loader,
            createPreparation: () => preparation(),
            setIntent: async () => Object.freeze({
                kind: 'conflict' as const,
                code: 'intent_revision_conflict' as const,
            }),
        });

        await expect(selector.select({
            reader: createReader(),
            accountLifetime,
            target: target({ withPreparation: false }),
        })).resolves.toEqual({ kind: 'conflict', code: 'intent_revision_conflict' });

        expect(loader.load).not.toHaveBeenCalled();
    });

    it('derives the staged candidate identity from the exact verified artifact digest, not a caller token', async () => {
        const prepared = preparation();
        let stagedArtifactDigest: string | null = null;
        const loader = {
            load: vi.fn(async () => Object.freeze({
                kind: 'available' as const,
                candidate: candidate(() => true),
            })),
        };
        const setIntent = vi.fn()
            .mockResolvedValueOnce(Object.freeze({ kind: 'preparationRequired' as const }))
            .mockResolvedValueOnce(Object.freeze({
                kind: 'updated' as const,
                intent: {
                    pluginId,
                    desiredVersion: targetVersion,
                    enabled: true,
                    offlineUiHosting: 'disabled' as const,
                    writableCollections: targetRefs,
                    revision: 'intent-2',
                },
            }));
        const createPreparation: CandidateCollectionReleaseSelectionDependencies['createPreparation'] = (input) => {
            stagedArtifactDigest = input.candidate.binding.candidate.artifactDigest;
            return prepared;
        };
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: loader,
            createPreparation,
            setIntent,
        });
        const targetWithCallerGeneration = {
            ...target(),
            generationId: 'unrelated-caller-generation',
        };

        await expect(selector.select({
            reader: createReader(),
            accountLifetime,
            target: targetWithCallerGeneration,
        })).resolves.toMatchObject({ kind: 'selected' });

        expect(stagedArtifactDigest).toBe(`sha256:${'c'.repeat(64)}`);
        expect(loader.load).toHaveBeenCalledTimes(1);
        expect(prepared.prepare).toHaveBeenCalledTimes(1);
        expect(setIntent).toHaveBeenCalledTimes(2);
    });

    it('uses a selected trusted-daemon preparation bridge for the same one retry and retirement path', async () => {
        const loader = {
            load: vi.fn(),
        };
        const retire = vi.fn(async () => {});
        const prepare = vi.fn(async (input: CandidateCollectionReleaseSelectionPreparationInput) => {
            expect(input.source.release).toEqual({ pluginId, version: sourceVersion });
            expect(input.target.release).toEqual({ pluginId, version: targetVersion });
            expect(input.target.collectionContracts).toEqual(targetRefs);
            expect(input.isCurrent()).toBe(true);
            return Object.freeze({
                kind: 'prepared' as const,
                stage: Object.freeze({ retire }),
            });
        });
        const setIntent = vi.fn()
            .mockResolvedValueOnce(Object.freeze({ kind: 'preparationRequired' as const }))
            .mockResolvedValueOnce(Object.freeze({
                kind: 'rejected' as const,
                code: 'request_rejected' as const,
            }));
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: loader,
            createPreparation: () => preparation(),
            setIntent,
        });
        const daemonTarget: CandidateCollectionReleaseSelectionTarget = {
            ...target({ withPreparation: false }),
            preparation: { kind: 'daemon', prepare },
        };

        await expect(selector.select({
            reader: createReader(),
            accountLifetime,
            target: daemonTarget,
        })).resolves.toEqual({ kind: 'rejected', code: 'intent_set_rejected' });

        expect(prepare).toHaveBeenCalledTimes(1);
        expect(setIntent).toHaveBeenCalledTimes(2);
        expect(retire).toHaveBeenCalledTimes(1);
        expect(loader.load).not.toHaveBeenCalled();
    });

    it('maps a trusted-daemon preparation transport failure to a typed unavailable result', async () => {
        const setIntent = vi.fn(async () => Object.freeze({ kind: 'preparationRequired' as const }));
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: { load: vi.fn() },
            createPreparation: () => preparation(),
            setIntent,
        });
        const daemonTarget: CandidateCollectionReleaseSelectionTarget = {
            ...target({ withPreparation: false }),
            preparation: {
                kind: 'daemon',
                prepare: async () => {
                    throw new Error('daemon transport unavailable');
                },
            },
        };

        await expect(selector.select({
            reader: createReader(),
            accountLifetime,
            target: daemonTarget,
        })).resolves.toEqual({ kind: 'unavailable', code: 'candidate_preparation_unavailable' });

        expect(setIntent).toHaveBeenCalledTimes(1);
    });

    it('keeps exact prepared stages for a retry CAS conflict instead of replaying candidate work', async () => {
        const prepared = preparation();
        const dispose = vi.fn();
        const setIntent = vi.fn()
            .mockResolvedValueOnce(Object.freeze({ kind: 'preparationRequired' as const }))
            .mockResolvedValueOnce(Object.freeze({
                kind: 'conflict' as const,
                code: 'intent_revision_conflict' as const,
            }));
        const loader = {
            load: vi.fn(async () => Object.freeze({
                kind: 'available' as const,
                candidate: candidate(() => true, dispose),
            })),
        };
        const createPreparation: CandidateCollectionReleaseSelectionDependencies['createPreparation'] = () => prepared;
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: loader,
            createPreparation,
            setIntent,
        });

        await expect(selector.select({
            reader: createReader(),
            accountLifetime,
            target: target(),
        })).resolves.toEqual({ kind: 'conflict', code: 'intent_revision_conflict' });

        expect(prepared.prepare).toHaveBeenCalledTimes(1);
        expect(prepared.retire).not.toHaveBeenCalled();
        expect(setIntent).toHaveBeenCalledTimes(2);
        expect(setIntent).toHaveBeenCalledWith(expect.objectContaining({
            pluginId,
            desiredVersion: targetVersion,
            expectedRevision: 'intent-1',
            writableCollections: targetRefs,
        }));
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('keeps exact prepared stages when an Availability intent CAS transport outcome is unavailable', async () => {
        const prepared = preparation();
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: {
                load: async () => Object.freeze({
                    kind: 'available' as const,
                    candidate: candidate(() => true),
                }),
            },
            createPreparation: () => prepared,
            setIntent: vi.fn()
                .mockResolvedValueOnce(Object.freeze({ kind: 'preparationRequired' as const }))
                .mockResolvedValueOnce(Object.freeze({
                    kind: 'unavailable' as const,
                    code: 'transport_unavailable' as const,
                })),
        });

        await expect(selector.select({
            reader: createReader(),
            accountLifetime,
            target: target(),
        })).resolves.toEqual({ kind: 'unavailable', code: 'intent_set_unavailable' });

        expect(prepared.prepare).toHaveBeenCalledTimes(1);
        expect(prepared.retire).not.toHaveBeenCalled();
    });

    it('retires exact prepared stages when Availability definitively rejects the intent CAS', async () => {
        const prepared = preparation();
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: {
                load: async () => Object.freeze({
                    kind: 'available' as const,
                    candidate: candidate(() => true),
                }),
            },
            createPreparation: () => prepared,
            setIntent: vi.fn()
                .mockResolvedValueOnce(Object.freeze({ kind: 'preparationRequired' as const }))
                .mockResolvedValueOnce(Object.freeze({
                    kind: 'rejected' as const,
                    code: 'request_rejected' as const,
                })),
        });

        await expect(selector.select({
            reader: createReader(),
            accountLifetime,
            target: target(),
        })).resolves.toEqual({ kind: 'rejected', code: 'intent_set_rejected' });

        expect(prepared.prepare).toHaveBeenCalledTimes(1);
        expect(prepared.retire).toHaveBeenCalledTimes(1);
    });

    it('cancels before Availability CAS when the present-user action is no longer current', async () => {
        let actionCurrent = true;
        const retire = vi.fn(async () => Object.freeze({ kind: 'retired' as const }));
        const prepare = vi.fn(async () => {
            actionCurrent = false;
            return Object.freeze({ kind: 'prepared' as const });
        });
        const prepared: ActivePluginCollectionCandidatePreparationV1 = Object.freeze({ prepare, retire });
        const setIntent = vi.fn(async () => Object.freeze({ kind: 'preparationRequired' as const }));
        const createPreparation: CandidateCollectionReleaseSelectionDependencies['createPreparation'] = () => prepared;
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: {
                load: async () => Object.freeze({
                    kind: 'available' as const,
                    candidate: candidate(() => actionCurrent),
                }),
            },
            createPreparation,
            setIntent,
        });

        await expect(selector.select({
            reader: createReader(),
            accountLifetime,
            target: target(),
            isCurrent: () => actionCurrent,
        })).resolves.toEqual({ kind: 'cancelled' });

        expect(retire).toHaveBeenCalledTimes(1);
        // Cancellation happens while the one permitted preparation pass is running,
        // so the initial CAS already established that preparation was needed. It
        // must prevent the retry CAS rather than erase that observed first call.
        expect(setIntent).toHaveBeenCalledTimes(1);
    });

    it('retires the exact prepared stage when Account selection changes during the retry CAS', async () => {
        let actionCurrent = true;
        let releaseRetry!: () => void;
        const retry = new Promise<void>((resolve) => {
            releaseRetry = resolve;
        });
        const retire = vi.fn(async () => {});
        const setIntent = vi.fn()
            .mockResolvedValueOnce(Object.freeze({ kind: 'preparationRequired' as const }))
            .mockImplementationOnce(async () => {
                await retry;
                return Object.freeze({
                    kind: 'updated' as const,
                    intent: {
                        pluginId,
                        desiredVersion: targetVersion,
                        enabled: true,
                        offlineUiHosting: 'disabled' as const,
                        writableCollections: targetRefs,
                        revision: 'intent-2',
                    },
                });
            });
        const selector = createCandidateCollectionReleaseSelector({
            artifactLoader: { load: vi.fn() },
            createPreparation: () => preparation(),
            setIntent,
        });
        const daemonTarget: CandidateCollectionReleaseSelectionTarget = {
            ...target({ withPreparation: false }),
            preparation: {
                kind: 'daemon',
                prepare: async () => Object.freeze({
                    kind: 'prepared' as const,
                    stage: Object.freeze({ retire }),
                }),
            },
        };

        const pending = selector.select({
            reader: createReader(),
            accountLifetime,
            target: daemonTarget,
            isCurrent: () => actionCurrent,
        });
        await vi.waitFor(() => expect(setIntent).toHaveBeenCalledTimes(2));
        actionCurrent = false;
        releaseRetry();

        await expect(pending).resolves.toEqual({ kind: 'cancelled' });
        expect(retire).toHaveBeenCalledTimes(1);
    });
});
