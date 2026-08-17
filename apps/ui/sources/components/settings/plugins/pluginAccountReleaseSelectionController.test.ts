import { describe, expect, it, vi } from 'vitest';

import { PluginReleaseFactsV1Schema } from '@happier-dev/protocol/plugins/availability';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';

import {
    createPluginAccountReleaseSelectionController,
    type PluginAccountReleaseSelectionControllerDependencies,
} from './pluginAccountReleaseSelectionController';

const pluginId = 'example.tasks';
const targetVersion = '2.0.0';

const facts = PluginReleaseFactsV1Schema.parse({
    ref: { pluginId, version: targetVersion },
    archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
    normalizedManifest: {
        schemaVersion: 2,
        id: pluginId,
        version: targetVersion,
        displayName: 'Example tasks',
        engines: { happier: '^1.0.0' },
        runtime: { apiVersion: 1 },
        contributes: {},
    },
    collectionContracts: [],
    uiSlots: [],
    packageAssetArchive: {
        archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
        resources: [],
    },
});

function createLifetime() {
    let current = true;
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
        isCurrent: () => current,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
    return Object.freeze({
        lifetime,
        retire: () => { current = false; },
    });
}

function dependencies(input: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    readRelease?: PluginAccountReleaseSelectionControllerDependencies['readRelease'];
    resolveExecution?: PluginAccountReleaseSelectionControllerDependencies['resolveExecution'];
    resolveAccountHostedTarget?: PluginAccountReleaseSelectionControllerDependencies['resolveAccountHostedTarget'];
    select?: PluginAccountReleaseSelectionControllerDependencies['select'];
}>): PluginAccountReleaseSelectionControllerDependencies {
    return {
        captureLifetime: () => input.lifetime,
        readRelease: input.readRelease ?? (async () => Object.freeze({
            kind: 'available' as const,
            availabilityCursor: 7,
            facts,
        })),
        resolveExecution: input.resolveExecution ?? (() => Object.freeze({ kind: 'unavailable' as const })),
        resolveAccountHostedTarget: input.resolveAccountHostedTarget ?? (async () => (
            Object.freeze({ kind: 'unavailable' as const })
        )),
        createAppExactSource: () => Object.freeze({
            kind: 'appExact' as const,
            readFile: async () => null,
        }),
        select: input.select ?? (async () => Object.freeze({
            kind: 'selected' as const,
            intent: {
                pluginId,
                desiredVersion: targetVersion,
                enabled: true,
                offlineUiHosting: 'disabled' as const,
                writableCollections: [],
                revision: 'intent-1',
            },
        })),
    };
}

function actionInput(input: Readonly<{
    reader?: PluginAccountAvailabilityReader | null;
    isCurrent?: () => boolean;
}>) {
    return {
        pluginId,
        version: targetVersion,
        reader: input.reader ?? null,
        projection: null,
        daemon: {
            serverId: 'server-route-a',
            serverIdentityId: 'srv_a',
            machineId: 'machine-a',
        },
        isCurrent: input.isCurrent ?? (() => true),
    };
}

describe('Plugin Account release selection controller', () => {
    it('sends an initial exact target CAS without resolving candidate artifact preparation', async () => {
        const active = createLifetime();
        const select = vi.fn<PluginAccountReleaseSelectionControllerDependencies['select']>(async () => Object.freeze({
            kind: 'selected' as const,
            intent: {
                pluginId,
                desiredVersion: targetVersion,
                enabled: true,
                offlineUiHosting: 'disabled' as const,
                writableCollections: [],
                revision: 'intent-1',
            },
        }));
        const controller = createPluginAccountReleaseSelectionController(dependencies({
            lifetime: active.lifetime,
            select,
        }));

        await expect(controller.select(actionInput({}))).resolves.toMatchObject({
            kind: 'selected',
        });

        expect(select).toHaveBeenCalledWith(expect.objectContaining({
            // The optional selector reader is absent for an initial CAS; the
            // controller must not synthesize a reader authority from null.
            reader: undefined,
            accountLifetime: active.lifetime,
            target: expect.objectContaining({
                release: facts.ref,
                collectionContracts: facts.collectionContracts,
                intent: {
                    enabled: true,
                    offlineUiHosting: 'disabled',
                    expectedRevision: null,
                },
            }),
        }));
        const selectionCall = select.mock.calls[0];
        if (!selectionCall) throw new Error('Expected Account selection input.');
        const target = selectionCall[0].target;
        expect(target.preparation?.kind).toBe('direct-ui-target');
    });

    it('preserves a current Account intent revision and hosting mode for the exact CAS', async () => {
        const active = createLifetime();
        const select = vi.fn(async () => Object.freeze({
            kind: 'selected' as const,
            intent: {
                pluginId,
                desiredVersion: targetVersion,
                enabled: true,
                offlineUiHosting: 'enabled' as const,
                writableCollections: [],
                revision: 'intent-2',
            },
        }));
        const reader = {
            readCurrentReleaseSelection: () => Object.freeze({
                kind: 'available' as const,
                availabilityCursor: 4,
                intent: {
                    pluginId,
                    desiredVersion: '1.0.0',
                    enabled: true,
                    offlineUiHosting: 'enabled' as const,
                    writableCollections: [],
                    revision: 'intent-current',
                },
                release: {
                    ref: { pluginId, version: '1.0.0' },
                    normalizedManifest: facts.normalizedManifest,
                },
            }),
        } as unknown as PluginAccountAvailabilityReader;
        const controller = createPluginAccountReleaseSelectionController(dependencies({
            lifetime: active.lifetime,
            select,
        }));

        await controller.select(actionInput({ reader }));

        expect(select).toHaveBeenCalledWith(expect.objectContaining({
            target: expect.objectContaining({
                intent: {
                    enabled: true,
                    offlineUiHosting: 'enabled',
                    expectedRevision: 'intent-current',
                },
            }),
        }));
    });

    it('defers an exact Account-hosted target source until Availability requires preparation when daemon execution is unavailable', async () => {
        const active = createLifetime();
        const select = vi.fn<PluginAccountReleaseSelectionControllerDependencies['select']>(async () => {
            return Object.freeze({
                kind: 'selected' as const,
                intent: {
                    pluginId,
                    desiredVersion: targetVersion,
                    enabled: true,
                    offlineUiHosting: 'disabled' as const,
                    writableCollections: [],
                    revision: 'intent-1',
                },
            });
        });
        const resolveAccountHostedTarget = vi.fn(async () => Object.freeze({
            kind: 'available' as const,
            candidateTarget: {
                release: facts.ref,
                artifact: {
                    contributionId: 'tasks-ui',
                    platform: 'ios',
                    digest: `sha256:${'c'.repeat(64)}`,
                },
                availabilityCursor: 7,
            },
            artifact: {
                artifactGraph: {},
                cacheIdentity: {},
                accountHosted: { kind: 'target' as const },
            },
        }) as unknown as Awaited<ReturnType<PluginAccountReleaseSelectionControllerDependencies['resolveAccountHostedTarget']>>);
        const controller = createPluginAccountReleaseSelectionController(dependencies({
            lifetime: active.lifetime,
            select,
            resolveAccountHostedTarget,
        }));

        await expect(controller.select(actionInput({}))).resolves.toMatchObject({ kind: 'selected' });

        expect(resolveAccountHostedTarget).not.toHaveBeenCalled();
        const selectionCall = select.mock.calls[0];
        if (!selectionCall) throw new Error('Expected Account selection input.');
        const preparation = selectionCall[0].target.preparation;
        expect(preparation?.kind).toBe('direct-ui-target');
        if (!preparation || preparation.kind !== 'direct-ui-target') {
            throw new Error('Expected the lazy Account-hosted target preparation');
        }
        await expect(preparation.resolve({
            accountLifetime: active.lifetime,
            isCurrent: () => true,
        })).resolves.toMatchObject({
            kind: 'available',
            candidateTarget: {
                release: facts.ref,
                availabilityCursor: 7,
            },
            artifact: {
                appExact: { kind: 'appExact' },
                accountHosted: { kind: 'target' },
            },
        });
        expect(resolveAccountHostedTarget).toHaveBeenCalledExactlyOnceWith({
            accountLifetime: active.lifetime,
            isCurrent: expect.any(Function),
            availabilityCursor: 7,
            facts,
        });
    });

    it('uses the host-private daemon preparation bridge instead of loading daemon artifact bytes in the UI', async () => {
        const active = createLifetime();
        const select = vi.fn<PluginAccountReleaseSelectionControllerDependencies['select']>(async () => {
            return Object.freeze({
                kind: 'selected' as const,
                intent: {
                    pluginId,
                    desiredVersion: targetVersion,
                    enabled: true,
                    offlineUiHosting: 'disabled' as const,
                    writableCollections: [],
                    revision: 'intent-1',
                },
            });
        });
        const resolveExecution = vi.fn(() => Object.freeze({
            kind: 'available' as const,
            source: {
                kind: 'daemon' as const,
                release: { availabilityCursor: 7, facts },
                origin: {
                    serverIdentityId: 'srv_a',
                    materializationRef: {
                        machineId: 'machine-a',
                        materializationId: 'materialization-a',
                        pluginId,
                    },
                },
                serverId: 'server-route-a',
                artifactGraph: {},
                cacheIdentity: {},
            },
        }) as unknown as ReturnType<PluginAccountReleaseSelectionControllerDependencies['resolveExecution']>);
        const resolveAccountHostedTarget = vi.fn(async () => Object.freeze({ kind: 'unavailable' as const }));
        const controller = createPluginAccountReleaseSelectionController(dependencies({
            lifetime: active.lifetime,
            select,
            resolveExecution,
            resolveAccountHostedTarget,
        }));

        await expect(controller.select(actionInput({}))).resolves.toMatchObject({ kind: 'selected' });

        const selectionCall = select.mock.calls[0];
        if (!selectionCall) throw new Error('Expected Account selection input.');
        expect(selectionCall[0].target.preparation?.kind).toBe('daemon');
        expect(resolveAccountHostedTarget).not.toHaveBeenCalled();
    });

    it('cancels an A-to-B Account change after the exact release read and never sends its CAS', async () => {
        const active = createLifetime();
        let resolveRead!: (value: Awaited<ReturnType<PluginAccountReleaseSelectionControllerDependencies['readRelease']>>) => void;
        const readPending = new Promise<Awaited<ReturnType<PluginAccountReleaseSelectionControllerDependencies['readRelease']>>>((resolve) => {
            resolveRead = resolve;
        });
        const select = vi.fn();
        const controller = createPluginAccountReleaseSelectionController(dependencies({
            lifetime: active.lifetime,
            readRelease: async () => await readPending,
            select,
        }));

        const result = controller.select(actionInput({}));
        active.retire();
        resolveRead(Object.freeze({ kind: 'available' as const, availabilityCursor: 7, facts }));

        await expect(result).resolves.toEqual({ kind: 'cancelled' });
        expect(select).not.toHaveBeenCalled();
    });

    it('surfaces an unavailable exact target instead of falling back to marketplace or current intent metadata', async () => {
        const active = createLifetime();
        const select = vi.fn();
        const controller = createPluginAccountReleaseSelectionController(dependencies({
            lifetime: active.lifetime,
            readRelease: async () => Object.freeze({ kind: 'notFound' as const }),
            select,
        }));

        await expect(controller.select(actionInput({}))).resolves.toEqual({
            kind: 'unavailable',
            code: 'target_release_unavailable',
        });
        expect(select).not.toHaveBeenCalled();
    });
});
