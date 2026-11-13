import { describe, expect, it, vi } from 'vitest';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';

import { PluginReleaseFactsV1Schema } from '@happier-dev/protocol/plugins/availability';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { createActivePluginAccountHostedArtifactRemover } from '@/sync/api/plugins/availability/removeActivePluginAccountHostedArtifact';
import { createActivePluginAccountAvailabilityIntentSetter } from '@/sync/api/plugins/availability/setActivePluginAccountAvailabilityIntent';
import { createActivePluginAccountPackageAssetsRemover } from '@/sync/api/plugins/availability/removeActivePluginAccountPackageAssets';
import { log } from '@/log';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createPluginAccountAvailabilityReader, type PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';

import {
    createPluginAccountReleaseAdministration as createPluginAccountReleaseSelectionController,
    type PluginAccountReleaseSelectionControllerDependencies,
} from './pluginAccountReleaseSelectionController';

await initializeRealAppRuntimeForTests();

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

describe.each(['hostedUi', 'packageAssets'] as const)('Artifact removal transport (%s)', (sourceKind) => {
    it.each(['throw', 'http503', 'invalidJson'] as const)('retains a thrown hosted-link removal cause through real transport and administration into the private surface log (%s)', async (failureMode) => {
        const active = createLifetime();
        const scope = active.lifetime.scope;
        const slot = { contributionId: 'tasks-ui', artifactId: 'tasks-artifact', tier: 'hostedWeb' as const,
            platform: 'web' as const, artifactDigest: `sha256:${'c'.repeat(64)}` as const, hostUiApiRange: '^1.0.0' };
        const release = PluginReleaseFactsV1Schema.parse({ ...facts, uiSlots: sourceKind === 'hostedUi' ? [slot] : [],
            ...(sourceKind === 'packageAssets' ? {
                normalizedManifest: { ...facts.normalizedManifest, contributes: { resources: [
                    { id: 'brand', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
                ] } },
                packageAssetArchive: { ...facts.packageAssetArchive, resources: [{ resourceId: 'brand', path: 'assets/brand.png',
                    mimeType: 'image/png', byteSize: 3, digestSha256: `sha256:${'d'.repeat(64)}` }] },
            } : {}),
        });
        const intent = { pluginId, desiredVersion: targetVersion, enabled: true, offlineUiHosting: 'enabled' as const,
            writableCollections: [], revision: 'intent-current' };
        const reader = createPluginAccountAvailabilityReader({ scope, snapshot: {
            availabilityCursor: 4, materializations: [], snapshots: [], intentReads: [{ pluginId, response: {
                availabilityCursor: 4, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                intent, release,
                packageAssets: sourceKind === 'packageAssets' ? [{ release: release.ref,
                    artifactId: '00000000-0000-4000-8000-000000000001', descriptor: release.packageAssetArchive }] : [],
                uiArtifacts: sourceKind === 'hostedUi' ? [{ release: release.ref, ...slot,
                    accountArtifactId: '00000000-0000-4000-8000-000000000001' }] : [],
            } }],
        } });
        // Only request/response and captured environment are substituted; domain setters/removers remain real.
        const setter = createActivePluginAccountAvailabilityIntentSetter({ captureLifetime: () => active.lifetime,
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request: async () => new Response(JSON.stringify({
                intent: { ...intent, offlineUiHosting: 'disabled' },
            }), { status: 200 }) }),
        });
        const transport = {
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request: async () => {
                if (failureMode === 'throw') throw new TypeError('private malformed response payload');
                return new Response('private malformed response payload', { status: failureMode === 'http503' ? 503 : 200 });
            } }),
        };
        const remover = createActivePluginAccountHostedArtifactRemover(transport);
        const packageRemover = createActivePluginAccountPackageAssetsRemover(transport);
        const controller = createPluginAccountReleaseSelectionController({ captureLifetime: () => active.lifetime,
            setIntent: setter.set, removeHostedArtifact: remover.remove, removePackageAssets: packageRemover.remove });
        const result = await controller.disableAndRemoveHostedArtifacts({ pluginId, reader });
        expect(result).toEqual({ kind: 'unavailable' });
        const diagnostic = readActionOutputDiagnostic(result);
        expect(diagnostic).toMatchObject({ source: 'plugin_availability.artifact_remove', failureCause: {
            phase: 'plugin_availability.artifact_remove',
            errorClass: failureMode === 'throw' ? 'TypeError' : failureMode === 'invalidJson' ? 'SyntaxError' : 'UnknownThrownValue',
            errorCode: null, httpStatus: failureMode === 'http503' ? 503 : null,
        } });
        expect(JSON.stringify(diagnostic)).not.toContain('private malformed response payload');
        const logged = log.getLogs().at(-1);
        expect(logged).toContain('[plugin-ui-host-api] ');
        expect(JSON.parse(logged!.slice('[plugin-ui-host-api] '.length))).toMatchObject({ pluginId,
            diagnostic: { kind: 'artifact_removal_failed', failureDiagnostic: diagnostic } });
    });
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
    setIntent?: PluginAccountReleaseSelectionControllerDependencies['setIntent'];
    removeHostedArtifact?: PluginAccountReleaseSelectionControllerDependencies['removeHostedArtifact'];
    removeCachedArtifact?: PluginAccountReleaseSelectionControllerDependencies['removeCachedArtifact'];
    removePackageAssets?: PluginAccountReleaseSelectionControllerDependencies['removePackageAssets'];
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
            fetch: async () => null,
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
        setIntent: input.setIntent ?? (async () => Object.freeze({ kind: 'updated' as const, intent: {} as never })),
        removeHostedArtifact: input.removeHostedArtifact ?? (async () => Object.freeze({ kind: 'removed' as const })),
        removeCachedArtifact: input.removeCachedArtifact ?? (async () => {}),
        removePackageAssets: input.removePackageAssets ?? (async () => Object.freeze({ kind: 'removed' as const })),
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
    it.each([false, true])('offers explicit Account hosting and exact removal for an assets-only release (hosted=%s)', async (hosted) => {
        const active = createLifetime();
        const release = PluginReleaseFactsV1Schema.parse({
            ...facts,
            normalizedManifest: {
                ...facts.normalizedManifest,
                contributes: { resources: [{ id: 'brand', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }] },
            },
            packageAssetArchive: {
                ...facts.packageAssetArchive,
                resources: [{ resourceId: 'brand', path: 'assets/brand.png', mimeType: 'image/png', byteSize: 3, digestSha256: `sha256:${'d'.repeat(64)}` }],
            },
        });
        const intent = {
            pluginId, desiredVersion: targetVersion, enabled: true,
            offlineUiHosting: 'disabled' as const, writableCollections: [], revision: 'intent-current',
        };
        const reader = createPluginAccountAvailabilityReader({
            scope: active.lifetime.scope,
            snapshot: {
                availabilityCursor: 4, materializations: [], snapshots: [],
                intentReads: [{ pluginId, response: {
                    availabilityCursor: 4,
                    hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                    intent, release, uiArtifacts: [], packageAssets: hosted ? [{ release: release.ref, artifactId: '00000000-0000-4000-8000-000000000001', descriptor: release.packageAssetArchive }] : [],
                } }],
            },
        });
        const setIntent = vi.fn<PluginAccountReleaseSelectionControllerDependencies['setIntent']>(async (input) => ({ kind: 'updated' as const, intent: { ...intent, offlineUiHosting: input.offlineUiHosting } }));
        const removePackageAssets = vi.fn<PluginAccountReleaseSelectionControllerDependencies['removePackageAssets']>(async () => {
            expect(setIntent.mock.lastCall?.[0].offlineUiHosting).toBe('disabled');
            return { kind: 'removed' };
        });
        const controller = createPluginAccountReleaseSelectionController(dependencies({ lifetime: active.lifetime, setIntent, removePackageAssets }));
        expect(controller.readHostedArtifactStatus({ pluginId, reader })).toBe(hosted ? 'disabledHosted' : 'notOptedIn');
        expect(setIntent).not.toHaveBeenCalled();
        await expect(controller.setHostedArtifactsEnabled({ pluginId, reader, enabled: true })).resolves.toEqual({ kind: 'updated' });
        expect(setIntent).toHaveBeenCalledWith({ pluginId, desiredVersion: targetVersion, enabled: true, offlineUiHosting: 'enabled', writableCollections: [], expectedRevision: intent.revision });
        await expect(controller.disableAndRemoveHostedArtifacts({ pluginId, reader })).resolves.toEqual({ kind: 'updated' });
        if (hosted) {
            expect(removePackageAssets).toHaveBeenCalledWith({ accountLifetime: active.lifetime, target: { release: release.ref } });
        } else {
            expect(removePackageAssets).not.toHaveBeenCalled();
        }
    });
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
        const sourceRelease = PluginReleaseFactsV1Schema.parse({
            ...facts,
            ref: { pluginId, version: '1.0.0' },
            normalizedManifest: { ...facts.normalizedManifest, version: '1.0.0' },
        });
        const reader = createPluginAccountAvailabilityReader({
            scope: active.lifetime.scope,
            snapshot: {
                availabilityCursor: 4, materializations: [], snapshots: [],
                intentReads: [{ pluginId, response: {
                    availabilityCursor: 4, hostingCapability: { enabled: false },
                    intent: {
                        pluginId,
                        desiredVersion: '1.0.0',
                        enabled: true,
                        offlineUiHosting: 'enabled' as const,
                        writableCollections: [],
                        revision: 'intent-current',
                    },
                    release: sourceRelease, uiArtifacts: [], packageAssets: [],
                } }],
            },
        });
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
            },
            artifact: {
                artifactGraph: {},
                cacheIdentity: {},
                accountHosted: {},
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
            },
            artifact: {
                appExact: { kind: 'appExact' },
                accountHosted: {},
            },
        });
        expect(resolveAccountHostedTarget).toHaveBeenCalledExactlyOnceWith({
            accountLifetime: active.lifetime,
            isCurrent: expect.any(Function),
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

    it('records hosting intent through the exact intent CAS and never opts in against an unsupporting server', async () => {
        const active = createLifetime();
        const setIntent = vi.fn(async () => Object.freeze({ kind: 'updated' as const, intent: {} as never }));
        const slot = {
            contributionId: 'tasks-ui', tier: 'hostedWeb' as const, platform: 'web' as const,
            artifactDigest: `sha256:${'c'.repeat(64)}` as const,
            compatibility: { hostUiApiVersion: 1 },
        };
        const readerFor = (hostingEnabled: boolean) => ({
            readCurrentHostedArtifactAdministration: () => ({
                kind: 'available' as const,
                availabilityCursor: 4,
                hostingCapability: hostingEnabled
                    ? { enabled: true, maxArtifactBytes: 1, maxAccountBytes: 1, maxAccountArtifacts: 1 }
                    : { enabled: false },
                intent: { pluginId, desiredVersion: targetVersion, enabled: true, offlineUiHosting: 'disabled' as const, writableCollections: [], revision: 'intent-current' },
                release: { ref: { pluginId, version: targetVersion }, normalizedManifest: facts.normalizedManifest, uiSlots: [slot], packageAssetArchive: facts.packageAssetArchive },
                uiArtifacts: [],
                packageAssets: [],
            }),
        } as unknown as PluginAccountAvailabilityReader);
        const controller = createPluginAccountReleaseSelectionController(dependencies({
            lifetime: active.lifetime, setIntent,
        }));

        // Operator capability is a server fact; user intent can never claim it.
        expect(controller.readHostedArtifactStatus({ pluginId, reader: readerFor(false) })).toBe('unsupported');
        await expect(controller.setHostedArtifactsEnabled({
            pluginId, reader: readerFor(false), enabled: true,
        })).resolves.toEqual({ kind: 'unavailable' });
        expect(setIntent).not.toHaveBeenCalled();

        expect(controller.readHostedArtifactStatus({ pluginId, reader: readerFor(true) })).toBe('notOptedIn');
        await expect(controller.setHostedArtifactsEnabled({
            pluginId, reader: readerFor(true), enabled: true,
        })).resolves.toEqual({ kind: 'updated' });
        expect(setIntent).toHaveBeenCalledExactlyOnceWith({
            pluginId,
            desiredVersion: targetVersion,
            enabled: true,
            offlineUiHosting: 'enabled',
            writableCollections: [],
            expectedRevision: 'intent-current',
        });
    });

    it('disables hosting before removing every current qualified link and clears only exact current cache identities', async () => {
        const active = createLifetime();
        const setIntent = vi.fn(async () => Object.freeze({ kind: 'updated' as const, intent: {} as never }));
        const removeHostedArtifact = vi.fn(async () => Object.freeze({ kind: 'removed' as const }));
        const removeCachedArtifact = vi.fn(async () => {});
        const slot = {
            contributionId: 'tasks-ui', artifactId: 'tasks-ui-artifact', tier: 'reactNative' as const, platform: 'ios' as const,
            artifactDigest: `sha256:${'c'.repeat(64)}` as const,
            hostUiApiRange: '^1.0.0',
        };
        const reader = {
            readCurrentHostedArtifactAdministration: () => ({
                kind: 'available' as const,
                availabilityCursor: 4,
                hostingCapability: { enabled: true, maxArtifactBytes: 1, maxAccountBytes: 1, maxAccountArtifacts: 1 },
                intent: { pluginId, desiredVersion: targetVersion, enabled: true, offlineUiHosting: 'enabled' as const, writableCollections: [], revision: 'intent-current' },
                release: { ref: { pluginId, version: targetVersion }, normalizedManifest: facts.normalizedManifest, uiSlots: [slot], packageAssetArchive: facts.packageAssetArchive },
                uiArtifacts: [{ release: { pluginId, version: targetVersion }, contributionId: slot.contributionId, artifactId: slot.artifactId, tier: slot.tier, platform: slot.platform }],
                packageAssets: [],
            }),
        } as unknown as PluginAccountAvailabilityReader;
        const controller = createPluginAccountReleaseSelectionController(dependencies({
            lifetime: active.lifetime, setIntent, removeHostedArtifact, removeCachedArtifact,
        }));

        expect(controller.readHostedArtifactStatus({ pluginId, reader })).toBe('hosted');
        const hostedAdmin = reader.readCurrentHostedArtifactAdministration({ pluginId });
        if (hostedAdmin.kind !== 'available') throw new Error('Expected hosted Administration fixture');
        const disabledWithRetainedLink = {
            readCurrentHostedArtifactAdministration: () => ({
                ...hostedAdmin,
                intent: {
                    ...hostedAdmin.intent,
                    offlineUiHosting: 'disabled' as const,
                },
            }),
        } as unknown as PluginAccountAvailabilityReader;
        expect(controller.readHostedArtifactStatus({ pluginId, reader: disabledWithRetainedLink })).toBe('disabledHosted');

        await expect(controller.disableAndRemoveHostedArtifacts({ pluginId, reader })).resolves.toEqual({ kind: 'updated' });
        expect(setIntent).toHaveBeenCalledWith({
            pluginId, desiredVersion: targetVersion, enabled: true, offlineUiHosting: 'disabled', writableCollections: [], expectedRevision: 'intent-current',
        });
        expect(removeHostedArtifact).toHaveBeenCalledWith(expect.objectContaining({
            accountLifetime: active.lifetime,
            target: {
                release: { pluginId, version: targetVersion },
                contributionId: 'tasks-ui',
                artifactId: 'tasks-ui-artifact',
                tier: 'reactNative',
                platform: 'ios',
            },
        }));

        await expect(controller.clearHostedArtifactCache({ pluginId, reader })).resolves.toEqual({ kind: 'updated' });
        expect(removeCachedArtifact).toHaveBeenCalledWith({
            accountScope: active.lifetime.scope,
            artifactDigest: slot.artifactDigest,
        }, expect.any(Function));
    });
});
