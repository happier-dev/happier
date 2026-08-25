import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const projectionDescribeMock = vi.hoisted(() => vi.fn());
const projectionRevision = vi.hoisted(() => ({ value: 0 }));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => projectionRevision.value,
    machineContributionRegistryProjectionDescribe: projectionDescribeMock,
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

function daemonProjection(generation: number) {
    return {
        v: 2 as const,
        generation,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {},
        diagnostics: [],
    };
}

function createAccountLifetime(accountId: string): Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    retire(): void;
}> {
    let current = true;
    const retireCallbacks = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope: Object.freeze({ serverId: 'server-1', accountId }),
        isCurrent: () => current,
        onRetire: (cancel) => {
            if (!current) {
                cancel();
                return Object.freeze({ dispose: () => {} });
            }
            retireCallbacks.add(cancel);
            return Object.freeze({
                dispose: () => retireCallbacks.delete(cancel),
            });
        },
    });
    return Object.freeze({
        lifetime,
        retire: () => {
            if (!current) return;
            current = false;
            const callbacks = [...retireCallbacks];
            retireCallbacks.clear();
            for (const callback of callbacks) callback();
        },
    });
}

const retainedTestAccountLifetime = createAccountLifetime('account-default').lifetime;

const automationEligibleEvents = [{
    event: {
        id: 'acme.events/repository/updated',
        identity: { pluginId: 'acme.events', localId: 'repository/updated' },
        immutableGenerationId: 'event-generation-a',
        title: 'Repository updated',
        description: null,
        payloadSchema: { type: 'object', additionalProperties: false },
        automation: {
            v: 1 as const,
            eligible: true as const,
            source: {
                sourceContractVersion: 1,
                supportedObservationTransports: ['checkpointedPull' as const],
                sourceConfigSchema: { type: 'object', additionalProperties: false },
                setupActionRef: { pluginId: 'acme.events', localId: 'configure-source' },
            },
        },
    },
    setupAction: {
        id: 'acme.events/configure-source',
        identity: { pluginId: 'acme.events', localId: 'configure-source' },
        immutableGenerationId: 'event-generation-a',
        title: 'Configure source',
        description: null,
        inputSchema: { type: 'object', additionalProperties: false },
        inputHints: null,
    },
}] as const;

const composerSurfaceCatalog = [{
    contribution: { pluginId: 'acme.composer', localId: 'review-region' },
    immutableGenerationId: 'composer-generation-a',
    projectionGeneration: 7,
    role: 'region' as const,
    rendererChain: [{ pluginId: 'acme.composer', localId: 'review-region-renderer' }],
    selectedRenderer: {
        identity: { pluginId: 'acme.composer', localId: 'review-region-renderer' },
        renderer: {
            kind: 'declarative' as const,
            contributionId: 'review-region-renderer',
            model: { visible: true },
        },
        availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
    },
    executionOrigin: {
        serverIdentityId: 'srv_composer',
        materializationRef: {
            machineId: 'machine-1',
            materializationId: 'composer-materialization',
            pluginId: 'acme.composer',
        },
    },
    resourceCapability: { readable: true, dynamic: true },
    contributorTargetedContributions: {
        target: { pluginId: 'acme.composer', immutableGenerationId: 'composer-generation-a' },
        points: [],
    },
}] as const;

describe('loadDaemonMergedProjectionCacheEntry', () => {
    beforeEach(async () => {
        projectionDescribeMock.mockReset();
        projectionRevision.value = 0;
        const { clearDaemonMergedProjectionCacheForTests } = await import('./loadDaemonMergedProjectionInputs');
        clearDaemonMergedProjectionCacheForTests();
    });

    it('retains the last ready projection as inert cached metadata after a transport error', async () => {
        projectionDescribeMock
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(7),
            })
            .mockResolvedValueOnce({
                supported: false,
                reason: 'error',
            });
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
        } = await import('./loadDaemonMergedProjectionInputs');

        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        });
        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        });

        expect(readCachedDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        })).toMatchObject({
            kind: 'error',
            inputs: {
                pluginProjectionV2: {
                    generation: 7,
                },
            },
        });
    });

    it('carries the daemon-selected Composer surface catalog through the canonical merged inputs', async () => {
        projectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: daemonProjection(7),
            composerSurfaceCatalog,
        });
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');

        await expect(loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        })).resolves.toMatchObject({
            kind: 'ready',
            inputs: { composerSurfaceCatalog },
        });
    });

    it('shares one bounded failure between concurrent reads of the same target generation', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        let resolveProjection!: (value: unknown) => void;
        projectionDescribeMock.mockImplementation(async () => await new Promise((resolve) => {
            resolveProjection = resolve;
        }));
        const {
            loadDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const release = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });

        try {
            const first = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });
            const second = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });

            await Promise.resolve();
            expect(projectionDescribeMock).toHaveBeenCalledTimes(1);

            resolveProjection({ supported: false, reason: 'error' });
            const [firstEntry, secondEntry] = await Promise.all([first, second]);
            expect(firstEntry).toBe(secondEntry);
            expect(firstEntry).toMatchObject({ kind: 'error' });
        } finally {
            release();
        }
    });

    it('does not expose Account A target projection to Account B on the same server, machine, and target', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const accountA = createAccountLifetime('account-a');
        const accountB = createAccountLifetime('account-b');
        projectionDescribeMock
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(7),
                targetedContributions: { target: mountedTarget, points: [] },
            })
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(8),
                targetedContributions: { target: mountedTarget, points: [] },
            });
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const releaseA = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: accountA.lifetime,
        });

        try {
            const accountAEntry = await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: accountA.lifetime,
            });
            expect(accountAEntry).toMatchObject({
                kind: 'ready',
                inputs: { pluginProjectionV2: { generation: 7 } },
            });

            accountA.retire();
            const releaseB = retainMountedTargetProjectionCacheScope({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: accountB.lifetime,
            });
            try {
                expect(readCachedDaemonMergedProjectionCacheEntry({
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    mountedTarget,
                    accountLifetime: accountB.lifetime,
                })).toBeNull();

                await expect(loadDaemonMergedProjectionCacheEntry({
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    mountedTarget,
                    accountLifetime: accountB.lifetime,
                })).resolves.toMatchObject({
                    kind: 'ready',
                    inputs: { pluginProjectionV2: { generation: 8 } },
                });
                expect(projectionDescribeMock).toHaveBeenCalledTimes(2);
            } finally {
                releaseB();
            }
        } finally {
            releaseA();
        }
    });

    it('compiles and retains one exact target surface binding for concurrent reads of G', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const mountG = Object.freeze({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: Object.freeze({ pointId: 'details', protocol: Object.freeze({ id: 'review-detail', version: 1 }) }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'contributor-generation-g',
            }),
            role: 'detail',
            presentation: 'content' as const,
            inputSchema: Object.freeze({
                type: 'object',
                properties: Object.freeze({ reviewId: Object.freeze({ type: 'string' }) }),
                required: Object.freeze(['reviewId']),
                additionalProperties: false,
            }),
        });
        let resolveProjection!: (value: unknown) => void;
        projectionDescribeMock.mockImplementation(async () => await new Promise((resolve) => {
            resolveProjection = resolve;
        }));
        const validation = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const prepare = vi.spyOn(validation, 'preparePluginJsonSchema');
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const release = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });

        try {
            const first = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });
            const second = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });

            await Promise.resolve();
            expect(projectionDescribeMock).toHaveBeenCalledTimes(1);

            resolveProjection({
                supported: true,
                projection: daemonProjection(7),
                targetedSurfaceMounts: [mountG],
            });
            const [firstEntry, secondEntry] = await Promise.all([first, second]);

            expect(prepare).toHaveBeenCalledTimes(1);
            expect(firstEntry).toBe(secondEntry);
            if (firstEntry?.kind !== 'ready' || secondEntry?.kind !== 'ready') {
                throw new Error('Expected a retained G target binding.');
            }
            expect(firstEntry.inputs.preparedTargetedSurfaceMounts?.[0]?.inputValidation)
                .toBe(secondEntry.inputs.preparedTargetedSurfaceMounts?.[0]?.inputValidation);
            expect(readCachedDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            })).toBe(firstEntry);
        } finally {
            release();
            prepare.mockRestore();
        }
    });

    it('does not revive contributor G after contributor H has become current', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const inputSchema = Object.freeze({
            type: 'object',
            properties: Object.freeze({ reviewId: Object.freeze({ type: 'string' }) }),
            required: Object.freeze(['reviewId']),
            additionalProperties: false,
        });
        const mount = (immutableGenerationId: string) => Object.freeze({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: Object.freeze({ pointId: 'details', protocol: Object.freeze({ id: 'review-detail', version: 1 }) }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId,
            }),
            role: 'detail',
            presentation: 'content' as const,
            inputSchema,
        });
        const mountG = mount('contributor-generation-g');
        const mountH = mount('contributor-generation-h');
        let resolveStaleG!: (value: unknown) => void;
        let resolveH!: (value: unknown) => void;
        projectionDescribeMock
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(7),
                targetedSurfaceMounts: [mountG],
            })
            .mockImplementationOnce(async () => await new Promise((resolve) => {
                resolveStaleG = resolve;
            }))
            .mockImplementationOnce(async () => await new Promise((resolve) => {
                resolveH = resolve;
            }));
        const validation = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const prepare = vi.spyOn(validation, 'preparePluginJsonSchema');
        const {
            loadDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const release = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });

        try {
            const initial = await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });
            if (initial?.kind !== 'ready') throw new Error('Expected the initial G target snapshot.');
            const gValidation = initial.inputs.preparedTargetedSurfaceMounts?.[0]?.inputValidation;
            expect(gValidation).toBeDefined();
            expect(prepare).toHaveBeenCalledTimes(1);

            const staleG = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });
            await Promise.resolve();

            projectionRevision.value = 1;
            const currentH = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });
            await Promise.resolve();
            expect(projectionDescribeMock).toHaveBeenCalledTimes(3);

            resolveH({
                supported: true,
                projection: daemonProjection(9),
                targetedSurfaceMounts: [mountH],
            });
            const hEntry = await currentH;
            if (hEntry?.kind !== 'ready') throw new Error('Expected the current H target snapshot.');
            const hValidation = hEntry.inputs.preparedTargetedSurfaceMounts?.[0]?.inputValidation;
            expect(hValidation).toBeDefined();
            expect(hValidation).not.toBe(gValidation);
            expect(prepare).toHaveBeenCalledTimes(2);

            resolveStaleG({
                supported: true,
                projection: daemonProjection(8),
                targetedSurfaceMounts: [mountG],
            });
            await expect(staleG).resolves.toBe(hEntry);
            expect(prepare).toHaveBeenCalledTimes(2);
        } finally {
            release();
            prepare.mockRestore();
        }
    });

    it('does not retain a rejected G schema for an unrelated H contributor generation', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const mount = (immutableGenerationId: string, inputSchema: object) => Object.freeze({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: Object.freeze({ pointId: 'details', protocol: Object.freeze({ id: 'review-detail', version: 1 }) }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId,
            }),
            role: 'detail',
            presentation: 'content' as const,
            inputSchema,
        });
        const invalidMountG = mount('contributor-generation-g', {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
        });
        const mountH = mount('contributor-generation-h', {
            type: 'object',
            properties: { reviewId: { type: 'string' } },
            required: ['reviewId'],
            additionalProperties: false,
        });
        projectionDescribeMock
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(7),
                targetedSurfaceMounts: [invalidMountG],
            })
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(8),
                targetedSurfaceMounts: [mountH],
            });
        const validation = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const prepare = vi.spyOn(validation, 'preparePluginJsonSchema');
        const {
            loadDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const release = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });

        try {
            const failedG = await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });
            expect(failedG).toMatchObject({
                kind: 'ready',
                inputs: { preparedTargetedSurfaceMounts: [] },
            });
            // Parser/normalizer admission rejects G before compiler ownership;
            // no failed candidate can remain under its authority.
            expect(prepare).toHaveBeenCalledTimes(0);

            projectionRevision.value = 1;
            const hEntry = await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });
            if (hEntry?.kind !== 'ready') throw new Error('Expected the unrelated H target snapshot.');
            const hMount = hEntry.inputs.preparedTargetedSurfaceMounts?.[0];
            expect(hMount?.contributor.immutableGenerationId).toBe('contributor-generation-h');
            expect(hMount?.inputValidation.validate).toEqual(expect.any(Function));
            expect(prepare).toHaveBeenCalledTimes(1);
        } finally {
            release();
            prepare.mockRestore();
        }
    });

    it('keeps target-scoped contribution snapshots in the incumbent cache only for their exact mounted target', async () => {
        const targetA = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const targetB = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-b' } as const;
        projectionDescribeMock.mockImplementation(async (_machineId: string, options?: Readonly<{
            mountedTarget?: typeof targetA;
        }>) => ({
            supported: true,
            projection: daemonProjection(7),
            targetedContributions: {
                target: options?.mountedTarget,
                points: [],
            },
        }));
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const releaseTargetA = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget: targetA,
            accountLifetime: retainedTestAccountLifetime,
        });
        const releaseTargetB = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget: targetB,
            accountLifetime: retainedTestAccountLifetime,
        });

        try {
            await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget: targetA,
                accountLifetime: retainedTestAccountLifetime,
            });
            await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget: targetB,
                accountLifetime: retainedTestAccountLifetime,
            });

            expect(projectionDescribeMock).toHaveBeenNthCalledWith(1, 'machine-1', expect.objectContaining({
                mountedTarget: targetA,
            }));
            expect(projectionDescribeMock).toHaveBeenNthCalledWith(2, 'machine-1', expect.objectContaining({
                mountedTarget: targetB,
            }));
            expect(readCachedDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget: targetA,
                accountLifetime: retainedTestAccountLifetime,
            })).toMatchObject({
                kind: 'ready',
                inputs: { targetedContributions: { target: targetA } },
            });
            expect(readCachedDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget: targetB,
                accountLifetime: retainedTestAccountLifetime,
            })).toMatchObject({
                kind: 'ready',
                inputs: { targetedContributions: { target: targetB } },
            });
        } finally {
            releaseTargetA();
            releaseTargetB();
        }
    });

    it('retains current target-scoped surface mounts beside their exact contribution snapshot', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const targetedSurfaceMounts = [{
            kind: 'targetedSurface',
            target: mountedTarget,
            point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
            contributor: {
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'contributor-generation-a',
            },
            role: 'detail',
            presentation: 'content',
            inputSchema: Object.freeze({ type: 'object' }),
        }];
        projectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: daemonProjection(7),
            targetedContributions: { target: mountedTarget, points: [] },
            targetedSurfaceMounts,
        });
        const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');

        const entry = await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });

        expect(entry).toMatchObject({
            kind: 'ready',
            inputs: {
                targetedContributions: { target: mountedTarget },
                preparedTargetedSurfaceMounts: [expect.objectContaining({
                    ...targetedSurfaceMounts[0],
                    inputValidation: expect.objectContaining({
                        jsonSchema: expect.any(Object),
                        validate: expect.any(Function),
                    }),
                })],
            },
        });
    });

    it('retires a prepared target validator when its final mounted host releases the target scope', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const targetedSurfaceMounts = [{
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
            contributor: {
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'contributor-generation-a',
            },
            role: 'detail',
            presentation: 'content' as const,
            inputSchema: Object.freeze({ type: 'object' }),
        }];
        projectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: daemonProjection(7),
            targetedSurfaceMounts,
        });
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const release = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });

        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });
        expect(readCachedDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        })).toMatchObject({
            kind: 'ready',
            inputs: {
                preparedTargetedSurfaceMounts: [expect.objectContaining({
                    inputValidation: expect.objectContaining({ validate: expect.any(Function) }),
                })],
            },
        });

        release();
        expect(readCachedDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        })).toBeNull();
    });

    it('does not prepare a target validator after its final mounted host retires during the RPC', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const targetedSurfaceMounts = [{
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
            contributor: {
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'contributor-generation-a',
            },
            role: 'detail',
            presentation: 'content' as const,
            inputSchema: Object.freeze({ type: 'object' }),
        }];
        let resolveProjection!: (value: unknown) => void;
        projectionDescribeMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolveProjection = resolve;
        }));
        const validation = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const prepare = vi.spyOn(validation, 'preparePluginJsonSchema');
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const release = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });

        try {
            const load = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });
            release();
            resolveProjection({
                supported: true,
                projection: daemonProjection(7),
                targetedSurfaceMounts,
            });

            await expect(load).resolves.toBeNull();
            expect(prepare).not.toHaveBeenCalled();
            expect(readCachedDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            })).toBeNull();
        } finally {
            prepare.mockRestore();
        }
    });

    it('does not revive a retired target cache lifecycle when the same target key is immediately remounted', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const account = createAccountLifetime('account-a');
        const mount = (immutableGenerationId: string) => Object.freeze({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: Object.freeze({ pointId: 'details', protocol: Object.freeze({ id: 'review-detail', version: 1 }) }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId,
            }),
            role: 'detail',
            presentation: 'content' as const,
            inputSchema: Object.freeze({ type: 'object' }),
        });
        const mountG = mount('contributor-generation-g');
        const mountH = mount('contributor-generation-h');
        let resolveG!: (value: unknown) => void;
        let resolveH!: (value: unknown) => void;
        projectionDescribeMock
            .mockImplementationOnce(async () => await new Promise((resolve) => {
                resolveG = resolve;
            }))
            .mockImplementationOnce(async () => await new Promise((resolve) => {
                resolveH = resolve;
            }));
        const validation = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const prepare = vi.spyOn(validation, 'preparePluginJsonSchema');
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const releaseG = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: account.lifetime,
        });

        try {
            const inFlightG = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: account.lifetime,
            });
            releaseG();
            const releaseH = retainMountedTargetProjectionCacheScope({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: account.lifetime,
            });

            try {
                const replacement = loadDaemonMergedProjectionCacheEntry({
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    mountedTarget,
                    accountLifetime: account.lifetime,
                });
                await Promise.resolve();
                expect(projectionDescribeMock).toHaveBeenCalledTimes(2);

                resolveH({
                    supported: true,
                    projection: daemonProjection(8),
                    targetedSurfaceMounts: [mountH],
                });
                const replacementEntry = await replacement;
                expect(replacementEntry).toMatchObject({
                    kind: 'ready',
                    inputs: {
                        preparedTargetedSurfaceMounts: [expect.objectContaining({
                            contributor: expect.objectContaining({ immutableGenerationId: 'contributor-generation-h' }),
                        })],
                    },
                });
                expect(prepare).toHaveBeenCalledTimes(1);

                resolveG({
                    supported: true,
                    projection: daemonProjection(7),
                    targetedSurfaceMounts: [mountG],
                });
                await expect(inFlightG).resolves.toBeNull();
                expect(readCachedDaemonMergedProjectionCacheEntry({
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    mountedTarget,
                    accountLifetime: account.lifetime,
                })).toMatchObject({
                    kind: 'ready',
                    inputs: {
                        preparedTargetedSurfaceMounts: [expect.objectContaining({
                            contributor: expect.objectContaining({ immutableGenerationId: 'contributor-generation-h' }),
                        })],
                    },
                });
                expect(prepare).toHaveBeenCalledTimes(1);
            } finally {
                releaseH();
            }
        } finally {
            prepare.mockRestore();
        }
    });

    it('still prepares a target validator when another mounted host retains the exact target scope', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const targetedSurfaceMounts = [{
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: { pointId: 'details', protocol: { id: 'review-detail', version: 1 } },
            contributor: {
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'contributor-generation-a',
            },
            role: 'detail',
            presentation: 'content' as const,
            inputSchema: Object.freeze({ type: 'object' }),
        }];
        let resolveProjection!: (value: unknown) => void;
        projectionDescribeMock.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolveProjection = resolve;
        }));
        const validation = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const prepare = vi.spyOn(validation, 'preparePluginJsonSchema');
        const {
            loadDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const releaseFirst = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });
        const releaseSecond = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });

        try {
            const load = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });
            releaseFirst();
            resolveProjection({
                supported: true,
                projection: daemonProjection(7),
                targetedSurfaceMounts,
            });

            await expect(load).resolves.toMatchObject({ kind: 'ready' });
            expect(prepare).toHaveBeenCalledTimes(1);
        } finally {
            releaseSecond();
            prepare.mockRestore();
        }
    });

    it('retains only the prepared launch-input validator while replacing same-generation private mount facts', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const inputSchema = Object.freeze({
            type: 'object',
            properties: Object.freeze({ reviewId: Object.freeze({ type: 'string' }) }),
            required: Object.freeze(['reviewId']),
            additionalProperties: false,
        });
        const mount = (immutableGenerationId: string, resourceReadable: boolean) => Object.freeze({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: Object.freeze({ pointId: 'details', protocol: Object.freeze({ id: 'review-detail', version: 1 }) }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId,
            }),
            role: 'detail',
            presentation: 'content' as const,
            inputSchema,
            resourceCapability: Object.freeze({ readable: resourceReadable, dynamic: resourceReadable }),
        });
        const mountGUnavailable = mount('contributor-generation-g', false);
        const mountGAvailable = mount('contributor-generation-g', true);
        const mountH = mount('contributor-generation-h', true);
        projectionDescribeMock
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(7),
                targetedSurfaceMounts: [mountGUnavailable],
            })
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(8),
                targetedSurfaceMounts: [mountGAvailable],
            })
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(9),
                targetedSurfaceMounts: [mountH],
            });
        const {
            loadDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const release = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: retainedTestAccountLifetime,
        });

        try {
            const initial = await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });
            const refresh = await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });

            expect(initial).toMatchObject({ kind: 'ready' });
            expect(refresh).toMatchObject({ kind: 'ready' });
            if (initial?.kind !== 'ready' || refresh?.kind !== 'ready') throw new Error('Expected ready target snapshots.');
            const initialValidator = initial.inputs.preparedTargetedSurfaceMounts?.[0]?.inputValidation;
            const refreshValidator = refresh.inputs.preparedTargetedSurfaceMounts?.[0]?.inputValidation;
            expect(initialValidator).toBeDefined();
            expect(refreshValidator).toBe(initialValidator);
            expect(initial.inputs.preparedTargetedSurfaceMounts?.[0]?.resourceCapability).toEqual({
                readable: false,
                dynamic: false,
            });
            expect(refresh.inputs.preparedTargetedSurfaceMounts?.[0]?.resourceCapability).toEqual({
                readable: true,
                dynamic: true,
            });

            const replacement = await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: retainedTestAccountLifetime,
            });

            expect(replacement).toMatchObject({ kind: 'ready' });
            if (replacement?.kind !== 'ready') throw new Error('Expected the H target snapshot.');
            expect(replacement.inputs.preparedTargetedSurfaceMounts?.[0]?.inputValidation)
                .not.toBe(initialValidator);
        } finally {
            release();
        }
    });

    it('fails closed for schema and presentation drift under one exact admitted authority', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const account = createAccountLifetime('account-a');
        const canonicalSchema = Object.freeze({
            type: 'object',
            properties: Object.freeze({ reviewId: Object.freeze({ type: 'string' }) }),
            required: Object.freeze(['reviewId']),
            additionalProperties: false,
        });
        const mount = Object.freeze({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: Object.freeze({ pointId: 'details', protocol: Object.freeze({ id: 'review-detail', version: 1 }) }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'contributor-generation-g',
            }),
            role: 'detail',
            presentation: 'content' as const,
            inputSchema: canonicalSchema,
        });
        const schemaDrift = Object.freeze({
            ...mount,
            inputSchema: Object.freeze({
                type: 'object',
                properties: Object.freeze({ reviewId: Object.freeze({ type: 'number' }) }),
                required: Object.freeze(['reviewId']),
                additionalProperties: false,
            }),
        });
        const presentationDrift = Object.freeze({ ...mount, presentation: 'fill' as const });
        projectionDescribeMock
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(7),
                targetedSurfaceMounts: [mount, schemaDrift],
            })
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(8),
                targetedSurfaceMounts: [mount, presentationDrift],
            });
        const validation = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const prepare = vi.spyOn(validation, 'preparePluginJsonSchema');
        const {
            loadDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const release = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: account.lifetime,
        });

        try {
            await expect(loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: account.lifetime,
            })).resolves.toMatchObject({
                kind: 'ready',
                inputs: { preparedTargetedSurfaceMounts: [] },
            });

            projectionRevision.value = 1;
            await expect(loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: account.lifetime,
            })).resolves.toMatchObject({
                kind: 'ready',
                inputs: { preparedTargetedSurfaceMounts: [] },
            });
            expect(prepare).not.toHaveBeenCalled();
        } finally {
            release();
            prepare.mockRestore();
        }
    });

    it('retains a canonical validator through same-authority drift without mounting the drifted response', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const account = createAccountLifetime('account-a');
        const canonicalSchema = Object.freeze({
            type: 'object',
            properties: Object.freeze({ reviewId: Object.freeze({ type: 'string' }) }),
            required: Object.freeze(['reviewId']),
            additionalProperties: false,
        });
        const canonicalMount = Object.freeze({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: Object.freeze({ pointId: 'details', protocol: Object.freeze({ id: 'review-detail', version: 1 }) }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'contributor-generation-g',
            }),
            role: 'detail',
            presentation: 'content' as const,
            inputSchema: canonicalSchema,
        });
        const driftedMount = Object.freeze({
            ...canonicalMount,
            inputSchema: Object.freeze({
                type: 'object',
                properties: Object.freeze({ reviewId: Object.freeze({ type: 'number' }) }),
                required: Object.freeze(['reviewId']),
                additionalProperties: false,
            }),
        });
        projectionDescribeMock
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(7),
                targetedSurfaceMounts: [canonicalMount],
            })
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(8),
                targetedSurfaceMounts: [driftedMount],
            })
            .mockResolvedValueOnce({
                supported: true,
                projection: daemonProjection(9),
                targetedSurfaceMounts: [canonicalMount],
            });
        const validation = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const prepare = vi.spyOn(validation, 'preparePluginJsonSchema');
        const {
            loadDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const release = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: account.lifetime,
        });

        try {
            const canonical = await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: account.lifetime,
            });
            if (canonical?.kind !== 'ready') throw new Error('Expected the canonical G target snapshot.');
            const canonicalValidator = canonical.inputs.preparedTargetedSurfaceMounts?.[0]?.inputValidation;
            expect(canonicalValidator).toBeDefined();
            expect(prepare).toHaveBeenCalledTimes(1);

            projectionRevision.value = 1;
            await expect(loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: account.lifetime,
            })).resolves.toMatchObject({
                kind: 'ready',
                inputs: { preparedTargetedSurfaceMounts: [] },
            });
            expect(prepare).toHaveBeenCalledTimes(1);

            projectionRevision.value = 2;
            const cleanRetry = await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: account.lifetime,
            });
            if (cleanRetry?.kind !== 'ready') throw new Error('Expected the clean G target retry.');
            expect(cleanRetry.inputs.preparedTargetedSurfaceMounts?.[0]?.inputValidation).toBe(canonicalValidator);
            expect(prepare).toHaveBeenCalledTimes(1);
        } finally {
            release();
            prepare.mockRestore();
        }
    });

    it('compiles one validator and reuses it for duplicate exact-authority rows in one response', async () => {
        const mountedTarget = { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' } as const;
        const account = createAccountLifetime('account-a');
        const inputSchema = Object.freeze({
            type: 'object',
            properties: Object.freeze({ reviewId: Object.freeze({ type: 'string' }) }),
            required: Object.freeze(['reviewId']),
            additionalProperties: false,
        });
        const mount = Object.freeze({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: Object.freeze({ pointId: 'details', protocol: Object.freeze({ id: 'review-detail', version: 1 }) }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'contributor-generation-g',
            }),
            role: 'detail',
            presentation: 'content' as const,
            inputSchema,
            resourceCapability: Object.freeze({ readable: false, dynamic: false }),
        });
        const duplicate = Object.freeze({
            ...mount,
            resourceCapability: Object.freeze({ readable: true, dynamic: true }),
        });
        projectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: daemonProjection(7),
            targetedSurfaceMounts: [mount, duplicate],
        });
        const validation = await import('@happier-dev/protocol/plugins/actions/json-schema-validation');
        const prepare = vi.spyOn(validation, 'preparePluginJsonSchema');
        const {
            loadDaemonMergedProjectionCacheEntry,
            retainMountedTargetProjectionCacheScope,
        } = await import('./loadDaemonMergedProjectionInputs');
        const release = retainMountedTargetProjectionCacheScope({
            machineId: 'machine-1',
            serverId: 'server-1',
            mountedTarget,
            accountLifetime: account.lifetime,
        });

        try {
            const entry = await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget,
                accountLifetime: account.lifetime,
            });
            if (entry?.kind !== 'ready') throw new Error('Expected duplicate target rows to be retained.');
            const prepared = entry.inputs.preparedTargetedSurfaceMounts;
            expect(prepared).toHaveLength(2);
            expect(prepared?.[0]?.inputValidation).toBe(prepared?.[1]?.inputValidation);
            expect(prepared?.[0]?.resourceCapability).toEqual({ readable: false, dynamic: false });
            expect(prepared?.[1]?.resourceCapability).toEqual({ readable: true, dynamic: true });
            expect(prepare).toHaveBeenCalledTimes(1);
        } finally {
            release();
            prepare.mockRestore();
        }
    });

    describe('retained admission custody around a target-scoped answer', () => {
        const CUSTODY_TARGET = {
            pluginId: 'acme.preview',
            immutableGenerationId: 'target-generation-a',
        } as const;

        function custodyProjection(generation: number) {
            return {
                ...daemonProjection(generation),
                installedPackagesById: {
                    [CUSTODY_TARGET.pluginId]: {
                        id: CUSTODY_TARGET.pluginId,
                        displayName: 'Acme preview',
                        version: '1.0.0',
                        enabled: true,
                        source: { kind: 'bundled', locator: CUSTODY_TARGET.pluginId },
                        immutableGenerationId: CUSTODY_TARGET.immutableGenerationId,
                        brand: { state: 'missing' },
                    },
                },
                familiesById: {
                    pluginUi: {
                        family: 'pluginUi',
                        entriesById: {
                            [`translations:${CUSTODY_TARGET.pluginId}`]: {
                                id: `translations:${CUSTODY_TARGET.pluginId}`,
                                pluginId: CUSTODY_TARGET.pluginId,
                                contributionKind: 'translations',
                                locales: ['en'],
                                bundles: { en: { title: 'Acme preview' } },
                            },
                        },
                    },
                },
            };
        }

        const custodyTargetedContributions = {
            target: CUSTODY_TARGET,
            points: [{
                pointId: 'review-detail',
                protocols: [{
                    protocol: { id: 'review/detail', version: 1 },
                    contributions: [{
                        contributor: {
                            pluginId: 'acme.review',
                            contributionId: 'detail',
                            immutableGenerationId: 'review-generation-a',
                        },
                        protocol: { id: 'review/detail', version: 1 },
                        operations: [],
                        surfaces: [],
                    }],
                }],
            }],
        } as const;

        async function warmCache() {
            const warm = await import('@/sync/domains/plugins/ui/projectionWarmCache');
            const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
            await prepareWarmCacheEncryptionKey();
            const persistence = await import('@/sync/domains/state/warmCachePersistence');
            const targetKey = warm.pluginUiProjectionAdmissionTargetKey({
                serverId: 'server-1',
                machineId: 'machine-1',
            });
            return Object.freeze({
                targetKey,
                scope: retainedTestAccountLifetime.scope,
                readEntry: () => persistence.loadPluginUiProjectionWarmCacheEntries(
                    retainedTestAccountLifetime.scope.serverId,
                    retainedTestAccountLifetime.scope.accountId,
                )[targetKey],
                reset: () => warm.forgetPluginUiProjectionAdmissionSnapshots(retainedTestAccountLifetime.scope),
                savePresentation: (generation: number) => warm.savePluginUiProjectionAdmissionSnapshot({
                    scope: retainedTestAccountLifetime.scope,
                    targetKey,
                    machineId: 'machine-1',
                    projection: custodyProjection(generation) as never,
                }),
            });
        }

        async function primeCustody() {
            const custody = await warmCache();
            custody.reset();
            custody.savePresentation(7);
            projectionDescribeMock.mockResolvedValueOnce({
                supported: true,
                projection: custodyProjection(7),
                targetedContributions: custodyTargetedContributions,
            });
            const { loadDaemonMergedProjectionCacheEntry } = await import('./loadDaemonMergedProjectionInputs');
            await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget: CUSTODY_TARGET,
                accountLifetime: retainedTestAccountLifetime,
            });
            expect(custody.readEntry()?.targetedContributionsByPluginId?.[CUSTODY_TARGET.pluginId])
                .toEqual(custodyTargetedContributions);
            return custody;
        }

        it('retires the whole retained entry when the current target answer is method-not-found', async () => {
            const custody = await primeCustody();
            const {
                clearDaemonMergedProjectionCacheForTests,
                loadDaemonMergedProjectionCacheEntry,
            } = await import('./loadDaemonMergedProjectionInputs');
            clearDaemonMergedProjectionCacheForTests();
            projectionDescribeMock.mockResolvedValueOnce({ supported: false, reason: 'not-supported' });

            await expect(loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget: CUSTODY_TARGET,
                accountLifetime: retainedTestAccountLifetime,
            })).resolves.toMatchObject({ kind: 'unsupported' });

            // This client sends one RPC for both shapes, so method-not-found is
            // a machine fact: the presentation slice goes with the target row.
            expect(custody.readEntry()).toBeUndefined();
        });

        it('keeps retained custody through a transient target transport failure', async () => {
            const custody = await primeCustody();
            const {
                clearDaemonMergedProjectionCacheForTests,
                loadDaemonMergedProjectionCacheEntry,
            } = await import('./loadDaemonMergedProjectionInputs');
            clearDaemonMergedProjectionCacheForTests();
            projectionDescribeMock.mockResolvedValueOnce({ supported: false, reason: 'error' });

            await loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget: CUSTODY_TARGET,
                accountLifetime: retainedTestAccountLifetime,
            });

            expect(custody.readEntry()?.targetedContributionsByPluginId?.[CUSTODY_TARGET.pluginId])
                .toEqual(custodyTargetedContributions);
        });

        it('does not let an old-endpoint method-not-found delete custody a newer machine answer established', async () => {
            const custody = await primeCustody();
            const {
                clearDaemonMergedProjectionCacheForTests,
                loadDaemonMergedProjectionCacheEntry,
            } = await import('./loadDaemonMergedProjectionInputs');
            clearDaemonMergedProjectionCacheForTests();

            let settleStaleResponse!: (value: unknown) => void;
            projectionDescribeMock.mockImplementationOnce(async () => await new Promise((resolve) => {
                settleStaleResponse = resolve;
            }));
            const stale = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget: CUSTODY_TARGET,
                accountLifetime: retainedTestAccountLifetime,
            });
            await Promise.resolve();

            // The machine's daemon state advanced, so the canonical projection
            // revision advanced and a newer machine-wide answer re-established
            // custody. The in-flight response belongs to the previous endpoint.
            projectionRevision.value += 1;
            custody.savePresentation(8);

            settleStaleResponse({ supported: false, reason: 'not-supported' });
            await expect(stale).resolves.toBeNull();
            expect(custody.readEntry()?.targetedContributionsByPluginId?.[CUSTODY_TARGET.pluginId])
                .toEqual(custodyTargetedContributions);
        });

        it('does not persist or publish an old-endpoint target success after the projection revision advances', async () => {
            const custody = await warmCache();
            custody.reset();
            custody.savePresentation(7);
            const {
                clearDaemonMergedProjectionCacheForTests,
                loadDaemonMergedProjectionCacheEntry,
                readCachedDaemonMergedProjectionCacheEntry,
            } = await import('./loadDaemonMergedProjectionInputs');
            clearDaemonMergedProjectionCacheForTests();

            let settleStaleResponse!: (value: unknown) => void;
            projectionDescribeMock.mockImplementationOnce(async () => await new Promise((resolve) => {
                settleStaleResponse = resolve;
            }));
            const stale = loadDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget: CUSTODY_TARGET,
                accountLifetime: retainedTestAccountLifetime,
            });
            await Promise.resolve();
            projectionRevision.value += 1;

            settleStaleResponse({
                supported: true,
                projection: custodyProjection(7),
                targetedContributions: custodyTargetedContributions,
            });
            await expect(stale).resolves.toBeNull();

            expect(custody.readEntry()?.targetedContributionsByPluginId).toBeUndefined();
            expect(readCachedDaemonMergedProjectionCacheEntry({
                machineId: 'machine-1',
                serverId: 'server-1',
                mountedTarget: CUSTODY_TARGET,
                accountLifetime: retainedTestAccountLifetime,
            })).toBeNull();
        });
    });

    it('keeps the current Event Automation snapshot in the incumbent projection cache', async () => {
        projectionDescribeMock.mockResolvedValueOnce({
            supported: true,
            projection: daemonProjection(7),
            automationEligibleEvents,
        });
        const {
            loadDaemonMergedProjectionCacheEntry,
            readCachedDaemonMergedProjectionCacheEntry,
        } = await import('./loadDaemonMergedProjectionInputs');

        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        });

        expect(readCachedDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-1',
        })).toMatchObject({
            kind: 'ready',
            inputs: { automationEligibleEvents },
        });
    });
});
