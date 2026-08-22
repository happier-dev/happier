import { describe, expect, it } from 'vitest';
import {
    normalizePluginUiDestinationBindingV1,
    type PluginUiDestinationBindingInputV1,
} from '@happier-dev/protocol/plugins/ui';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';

import { normalizePluginUiProjection, EMPTY_PLUGIN_UI_PROJECTION } from './projection';
import { selectPluginSurfacePlacementsForBinding } from './surfacePlacementSelectors';
import {
    arePluginUiProjectionUnionMembersEquivalent,
    readPluginUiContributionOrigin,
    readPluginUiProjectionEntryExecutionOrigin,
    unionPluginUiProjections,
    type PluginUiProjectionUnionMember,
} from './projectionUnion';

function machineProjection(input: Readonly<{
    generation: number;
    entriesById: Readonly<Record<string, unknown>>;
    actionsById?: Readonly<Record<string, unknown>>;
    installedPackagesById?: Readonly<Record<string, unknown>>;
}>) {
    return normalizePluginUiProjection({
        v: 2,
        generation: input.generation,
        installedPackagesById: input.installedPackagesById ?? {},
        agentsById: {},
        backendsById: {},
        actionsById: input.actionsById ?? {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginUi: { family: 'pluginUi', entriesById: input.entriesById },
        },
        diagnostics: [],
    } as never);
}

function placementEntry(input: Readonly<{
    pluginId: string;
    localId: string;
    container?: PluginUiDestinationBindingInputV1['container'];
    target?: PluginUiDestinationBindingInputV1['target'];
    order?: number;
}>): Readonly<Record<string, unknown>> {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: input.pluginId,
        destinationId: input.localId,
        rendererId: 'inspector',
        container: input.container ?? 'rightSidebarTab',
        target: input.target ?? { kind: 'app' },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 destination binding');
    }
    return {
        id: `surfacePlacement:${input.pluginId}:${input.localId}`,
        pluginId: input.pluginId,
        contributionKind: 'surfacePlacement',
        descriptorId: input.localId,
        binding,
        target: binding.target,
        renderer: { kind: 'declarative', contributionId: 'inspector' },
        display: { developerFallback: input.localId },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        ...(input.order === undefined ? {} : { order: input.order }),
    };
}

function reactNativeBundleEntry(pluginId: string): Readonly<Record<string, unknown>> {
    return {
        id: `reactNativeBundle:${pluginId}:bundle`,
        pluginId,
        contributionKind: 'reactNativeBundle',
        contributionId: 'bundle',
    };
}

/** A direct producer stamp, as emitted by the V2 projection owner. */
function stampEntriesWithProducerOrigins(
    entriesById: Readonly<Record<string, unknown>>,
    machineId: string,
    originsByPluginId: Readonly<Record<string, PluginMachineExecutionOriginV1>> | undefined,
): Readonly<Record<string, unknown>> {
    return Object.fromEntries(Object.entries(entriesById).map(([id, entry]) => {
        const candidate = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? entry as Readonly<Record<string, unknown>>
            : null;
        const pluginId = typeof candidate?.pluginId === 'string' ? candidate.pluginId : null;
        if (!candidate || !pluginId) return [id, entry];
        const origin = originsByPluginId?.[pluginId] ?? selectedOrigin(pluginId, machineId);
        return [id, {
            ...candidate,
            serverIdentityId: origin.serverIdentityId,
            materializationRef: origin.materializationRef,
        }];
    }));
}

function member(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    generation?: number;
    entriesById?: Readonly<Record<string, unknown>>;
    actionsById?: Readonly<Record<string, unknown>>;
    installedPackagesById?: Readonly<Record<string, unknown>>;
    producerOriginsByPluginId?: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
    phase?: PluginUiProjectionUnionMember['phase'];
    interactionEnabled?: boolean;
}>): PluginUiProjectionUnionMember {
    return {
        machineId: input.machineId,
        serverId: input.serverId ?? 'server-1',
        projection: input.generation === undefined
            ? null
            : machineProjection({
                generation: input.generation,
                entriesById: stampEntriesWithProducerOrigins(
                    input.entriesById ?? {},
                    input.machineId,
                    input.producerOriginsByPluginId,
                ),
                actionsById: stampEntriesWithProducerOrigins(
                    input.actionsById ?? {},
                    input.machineId,
                    input.producerOriginsByPluginId,
                ),
                installedPackagesById: input.installedPackagesById,
        }),
        phase: input.phase ?? (input.interactionEnabled === false ? 'retainedOffline' : 'current'),
        interactionEnabled: input.interactionEnabled ?? true,
    };
}

function selectedOrigin(pluginId: string, machineId: string): PluginMachineExecutionOriginV1 {
    return {
        serverIdentityId: 'srv_test',
        materializationRef: {
            machineId,
            materializationId: `${machineId}:${pluginId}`,
            pluginId,
        },
    };
}

function selectedOrigins(...origins: readonly PluginMachineExecutionOriginV1[]): ReadonlyMap<string, PluginMachineExecutionOriginV1> {
    return new Map(origins.map((origin) => [origin.materializationRef.pluginId, origin]));
}

describe('unionPluginUiProjections', () => {
    it('keeps Composer maps empty in the app union instead of becoming a Composer catalog owner', () => {
        const selected = selectedOrigin('acme.inspector', 'machine-a');
        const source = member({
            machineId: 'machine-a',
            generation: 3,
            entriesById: {
                placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
            },
        });
        if (!source.projection) throw new Error('fixture must produce a projection');

        const union = unionPluginUiProjections([{
            ...source,
            projection: {
                ...source.projection,
                // Opaque fixture values are intentional: App scope must not
                // inspect or select any Composer contribution.
                composerAttachmentsById: { 'acme.inspector/attachment': { id: 'attachment' } as never },
                composerControlsById: { 'acme.inspector/control': { id: 'control' } as never },
                composerRegionsById: { 'acme.inspector/region': { id: 'region' } as never },
            },
        }], selectedOrigins(selected));

        expect(union.pluginUiProjection?.composerAttachmentsById).toEqual({});
        expect(union.pluginUiProjection?.composerControlsById).toEqual({});
        expect(union.pluginUiProjection?.composerRegionsById).toEqual({});
    });

    it('keeps a package brand fact from the Administration-selected materialization', () => {
        const selected = selectedOrigin('acme.inspector', 'machine-a');
        const entries = {
            placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
            reactNativeBundle: reactNativeBundleEntry('acme.inspector'),
        };
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-a',
                generation: 3,
                entriesById: entries,
                installedPackagesById: {
                    'acme.inspector': {
                        id: 'acme.inspector',
                        displayName: 'Inspector A',
                        version: '1.0.0',
                        enabled: true,
                        source: { kind: 'bundled', locator: 'acme.inspector' },
                        brand: {
                            state: 'available',
                            resource: { pluginId: 'acme.inspector', localId: 'brand-a' },
                            width: 64,
                            height: 64,
                            digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        },
                    },
                },
            }),
            member({
                machineId: 'machine-b',
                generation: 4,
                entriesById: entries,
                installedPackagesById: {
                    'acme.inspector': {
                        id: 'acme.inspector',
                        displayName: 'Inspector B',
                        version: '2.0.0',
                        enabled: true,
                        source: { kind: 'bundled', locator: 'acme.inspector' },
                        brand: {
                            state: 'available',
                            resource: { pluginId: 'acme.inspector', localId: 'brand-b' },
                            width: 64,
                            height: 64,
                            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                        },
                    },
                },
            }),
        ], selectedOrigins(selected));

        // The union may not take a package fact from a newer or richer replica:
        // the selected materialization owns its artifact and brand identity.
        expect(union.pluginUiProjection?.installedPackagesById['acme.inspector']).toMatchObject({
            displayName: 'Inspector A',
            brand: {
                state: 'available',
                resource: { pluginId: 'acme.inspector', localId: 'brand-a' },
            },
        });
    });

    it('withholds a replicated plugin until Administration supplies its exact origin', () => {
        const replicaEntries = {
            placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
            reactNativeBundle: reactNativeBundleEntry('acme.inspector'),
        };

        const union = unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 3, entriesById: replicaEntries }),
            // This replica deliberately contains more entries. The app shell
            // must not turn that into an implicit election.
            member({
                machineId: 'machine-b',
                generation: 4,
                entriesById: {
                    ...replicaEntries,
                    extra: placementEntry({ pluginId: 'acme.inspector', localId: 'extra' }),
                },
            }),
        ], new Map());

        expect(union.pluginUiProjection).toBeNull();
    });

    it('withholds a same-machine replica when its producer materialization differs from the selected origin', () => {
        const pluginId = 'acme.inspector';
        const selected = selectedOrigin(pluginId, 'machine-a');
        const staleSameMachine: PluginMachineExecutionOriginV1 = {
            ...selected,
            materializationRef: {
                ...selected.materializationRef,
                materializationId: 'machine-a:acme.inspector:stale-install',
            },
        };

        const union = unionPluginUiProjections([member({
            machineId: 'machine-a',
            generation: 3,
            entriesById: { placement: placementEntry({ pluginId, localId: 'panel' }) },
            producerOriginsByPluginId: { [pluginId]: staleSameMachine },
        })], selectedOrigins(selected));

        // A machine id match alone used to admit this entry. The direct V2
        // producer stamp has a different install/materialization identity, so
        // its page/panel must be unavailable rather than silently elected.
        expect(union.pluginUiProjection).toBeNull();
    });

    it('withholds a same-machine entry when its producer server identity differs from the selected origin', () => {
        const pluginId = 'acme.inspector';
        const selected = selectedOrigin(pluginId, 'machine-a');
        const foreignServer = {
            ...selected,
            serverIdentityId: 'srv_other',
        } satisfies PluginMachineExecutionOriginV1;

        const union = unionPluginUiProjections([member({
            machineId: 'machine-a',
            generation: 3,
            entriesById: { placement: placementEntry({ pluginId, localId: 'panel' }) },
            producerOriginsByPluginId: { [pluginId]: foreignServer },
        })], selectedOrigins(selected));

        // The materialization key is scoped by server identity. Keeping the
        // same machine/plugin/install coordinates is still not enough to make
        // bytes from another server a selected App contribution.
        expect(union.pluginUiProjection).toBeNull();
    });

    it('keeps every machine\'s contributions and stamps each with its own origin', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-b',
                generation: 4,
                entriesById: { b: placementEntry({ pluginId: 'acme.beta', localId: 'panel' }) },
                interactionEnabled: false,
            }),
            member({
                machineId: 'machine-a',
                generation: 3,
                entriesById: { a: placementEntry({ pluginId: 'acme.alpha', localId: 'panel' }) },
            }),
        ], selectedOrigins(
            selectedOrigin('acme.alpha', 'machine-a'),
            selectedOrigin('acme.beta', 'machine-b'),
        ));

        const placements = union.pluginUiProjection
            ? selectPluginSurfacePlacementsForBinding(union.pluginUiProjection, {
                container: 'rightSidebarTab',
                targetKind: 'app',
            })
            : [];
        expect(placements.map((entry) => entry.id)).toEqual([
            'surfacePlacement:acme.alpha:panel',
            'surfacePlacement:acme.beta:panel',
        ]);
        expect(readPluginUiContributionOrigin(placements[0])).toEqual({
            machineId: 'machine-a',
            serverId: 'server-1',
            generation: 3,
            interactionEnabled: true,
            phase: 'current',
            executionOrigin: selectedOrigin('acme.alpha', 'machine-a'),
        });
        // Executable authority is per origin: machine-b's stale projection does
        // not inherit machine-a's currentness.
        expect(readPluginUiContributionOrigin(placements[1])).toEqual({
            machineId: 'machine-b',
            serverId: 'server-1',
            generation: 4,
            interactionEnabled: false,
            phase: 'retainedOffline',
            executionOrigin: selectedOrigin('acme.beta', 'machine-b'),
        });
        // Several members means there is no single app machine, and none is invented.
        expect(union.machineId).toBeNull();
    });

    it('follows the exact selected origin even when another replica projects more entries', () => {
        const replicaEntries = {
            placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
            reactNativeBundle: reactNativeBundleEntry('acme.inspector'),
        };
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-z',
                generation: 99,
                entriesById: {
                    ...replicaEntries,
                    extra: placementEntry({ pluginId: 'acme.inspector', localId: 'extra' }),
                },
            }),
            member({ machineId: 'machine-a', generation: 2, entriesById: replicaEntries }),
        ], selectedOrigins(selectedOrigin('acme.inspector', 'machine-a')));

        const placements = union.pluginUiProjection
            ? selectPluginSurfacePlacementsForBinding(union.pluginUiProjection, {
                container: 'rightSidebarTab',
                targetKind: 'app',
            })
            : [];
        expect(placements).toHaveLength(1);
        expect(readPluginUiContributionOrigin(placements[0])?.machineId).toBe('machine-a');
        // The generated V2 React Native bundle comes from the SAME machine and
        // generation as its placement, so its cache identity can never be
        // checked against a different machine's generation.
        const bundle = union.pluginUiProjection?.reactNativeBundlesById['reactNativeBundle:acme.inspector:bundle'];
        expect(readPluginUiContributionOrigin(bundle)).toEqual({
            machineId: 'machine-a',
            serverId: 'server-1',
            generation: 2,
            interactionEnabled: true,
            phase: 'current',
            executionOrigin: selectedOrigin('acme.inspector', 'machine-a'),
        });
        expect(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:extra'])
            .toBeUndefined();
    });

    it('carries a client Action only from its exact selected producer and preserves its execution target', () => {
        const pluginId = 'acme.client-action';
        const actionId = `${pluginId}/open-preview`;
        const outputSchema = {
            type: 'object',
            properties: {
                summary: { type: 'string' },
            },
            required: ['summary'],
            additionalProperties: false,
        } as const;
        const action = {
            id: 'open-preview',
            pluginId,
            title: 'Open preview',
            scopes: ['session'],
            surfaces: ['ui'],
            placementBindings: ['detailsPanel'],
            dangerLevel: 'safe',
            available: true,
            execution: {
                target: 'client',
                client: {
                    artifactId: 'client-runtime',
                    modulePath: './clientRuntime',
                    exportName: 'activate',
                },
                platforms: ['web'],
            },
            outputSchema,
        };
        const selected = selectedOrigin(pluginId, 'machine-a');

        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-b',
                generation: 4,
                actionsById: { [actionId]: action },
            }),
            member({
                machineId: 'machine-a',
                generation: 3,
                actionsById: { [actionId]: action },
            }),
        ], selectedOrigins(selected));

        const projected = union.pluginUiProjection?.actionsById[actionId];
        expect(projected).toMatchObject({
            ...action,
            execution: action.execution,
            outputSchema,
        });
        expect(readPluginUiContributionOrigin(projected)).toEqual({
            machineId: 'machine-a',
            serverId: 'server-1',
            generation: 3,
            interactionEnabled: true,
            phase: 'current',
            executionOrigin: selected,
        });
    });

    it('does not let an older replica of a plugin hide the machine that actually has its app surface', () => {
        const union = unionPluginUiProjections([
            // machine-a sorts first, but its copy of the plugin predates the
            // `app.rightSidebarTab` contribution entirely.
            member({
                machineId: 'machine-a',
                generation: 8,
                entriesById: {
                    session: placementEntry({
                        pluginId: 'acme.inspector',
                        localId: 'session',
                        container: 'rightSidebarTab',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                    }),
                },
            }),
            member({
                machineId: 'machine-b',
                generation: 9,
                entriesById: {
                    session: placementEntry({
                        pluginId: 'acme.inspector',
                        localId: 'session',
                        container: 'rightSidebarTab',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                    }),
                    app: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
                    reactNativeBundle: reactNativeBundleEntry('acme.inspector'),
                },
            }),
        ], selectedOrigins(selectedOrigin('acme.inspector', 'machine-b')));

        const placements = union.pluginUiProjection
            ? selectPluginSurfacePlacementsForBinding(union.pluginUiProjection, {
                container: 'rightSidebarTab',
                targetKind: 'app',
            })
            : [];
        expect(placements.map((entry) => entry.id)).toEqual(['surfacePlacement:acme.inspector:panel']);
        expect(readPluginUiContributionOrigin(placements[0])?.machineId).toBe('machine-b');
        // The whole plugin follows its owner: no half from each machine.
        expect(Object.keys(union.pluginUiProjection?.surfacePlacementsById ?? {}).sort()).toEqual([
            'surfacePlacement:acme.inspector:panel',
            'surfacePlacement:acme.inspector:session',
        ]);
        expect(readPluginUiContributionOrigin(
            union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:session'],
        )?.machineId).toBe('machine-b');
    });

    it('publishes the sole member\'s machine and generation unchanged', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-only',
                generation: 11,
                entriesById: { a: placementEntry({ pluginId: 'acme.alpha', localId: 'panel' }) },
            }),
        ], selectedOrigins(selectedOrigin('acme.alpha', 'machine-only')));
        expect(union.machineId).toBe('machine-only');
        expect(union.serverId).toBe('server-1');
        expect(union.pluginUiProjection?.generation).toBe(11);
    });

    it('changes the model generation when any member generation changes, and only then', () => {
        const build = (betaGeneration: number) => unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 3, entriesById: { a: placementEntry({ pluginId: 'acme.alpha', localId: 'panel' }) } }),
            member({ machineId: 'machine-b', generation: betaGeneration, entriesById: { b: placementEntry({ pluginId: 'acme.beta', localId: 'panel' }) } }),
        ], selectedOrigins(
            selectedOrigin('acme.alpha', 'machine-a'),
            selectedOrigin('acme.beta', 'machine-b'),
        ));
        const first = build(4).pluginUiProjection?.generation;
        expect(build(4).pluginUiProjection?.generation).toBe(first);
        expect(build(5).pluginUiProjection?.generation).not.toBe(first);
        expect(Number.isInteger(first)).toBe(true);
        expect(first as number).toBeGreaterThanOrEqual(0);
    });

    it('reports a current empty catalog only after members have settled their describes', () => {
        const settledEmpty = unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 3 }),
        ], new Map());
        expect(settledEmpty.pluginUiProjection).toBeNull();
        expect(settledEmpty.phase).toBe('current');
        expect(unionPluginUiProjections([
            {
                machineId: 'machine-a',
                serverId: 'server-1',
                projection: EMPTY_PLUGIN_UI_PROJECTION,
                phase: 'retainedOffline',
                interactionEnabled: false,
            },
            {
                machineId: 'machine-b',
                serverId: 'server-1',
                projection: EMPTY_PLUGIN_UI_PROJECTION,
                phase: 'retainedOffline',
                interactionEnabled: false,
            },
        ], new Map()).pluginUiProjection).toBeNull();
    });

    it('keeps an absent first description explicitly establishing instead of turning it into a tombstone', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-a',
                generation: undefined,
                phase: 'establishing',
                interactionEnabled: false,
            }),
        ], new Map());

        expect(union).toMatchObject({
            pluginUiProjection: null,
            phase: 'establishing',
            interactionEnabled: false,
            machineId: 'machine-a',
        });
    });

    it('keeps a selected origin pending while its first describe is establishing despite an unrelated current member', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-a',
                generation: 3,
                entriesById: {
                    unrelated: placementEntry({ pluginId: 'acme.unrelated', localId: 'panel' }),
                },
            }),
            member({
                machineId: 'machine-b',
                generation: undefined,
                phase: 'establishing',
                interactionEnabled: false,
            }),
        ], selectedOrigins(selectedOrigin('acme.pending', 'machine-b')));

        // `machine-a` cannot prove that `acme.pending` is absent from the
        // selected machine. A restored page for that plugin must remain
        // unresolved until machine-b's first describe settles.
        expect(union).toMatchObject({
            pluginUiProjection: null,
            phase: 'establishing',
            interactionEnabled: false,
        });
    });

    it('keeps the coarse union inert while another member is establishing', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-a',
                generation: 3,
                entriesById: {
                    selected: placementEntry({ pluginId: 'acme.selected', localId: 'panel' }),
                },
            }),
            member({
                machineId: 'machine-b',
                generation: undefined,
                phase: 'establishing',
                interactionEnabled: false,
            }),
        ], selectedOrigins(selectedOrigin('acme.selected', 'machine-a')));

        // Exact mounts retain machine-a's stamped current authority, but a
        // generic consumer of the aggregate cannot execute while the catalog
        // itself is still incomplete.
        expect(union).toMatchObject({
            phase: 'establishing',
            interactionEnabled: false,
        });
        expect(readPluginUiContributionOrigin(
            union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.selected:panel'],
        )).toMatchObject({
            phase: 'current',
            interactionEnabled: true,
        });
    });

    it('admits an unmaterialized contribution by structure, for a bundled and an external plugin alike', () => {
        // The producer stamps an entry only when it knows a materialization for
        // that plugin. A plugin the Account can never materialize — one shipped
        // inside the host binary, and equally an externally authored plugin the
        // daemon loaded from a source root — therefore has nothing to stamp and
        // nothing for Administration to select. Requiring a selected origin
        // there is fail-always, not fail-closed, and the discriminator is the
        // missing stamp, never the plugin's provenance.
        const installedPackage = (pluginId: string, kind: string) => ({
            id: pluginId,
            displayName: pluginId,
            version: '1.0.0',
            enabled: true,
            source: { kind, locator: pluginId },
        });
        const unstampedMember: PluginUiProjectionUnionMember = {
            machineId: 'machine-a',
            serverId: 'server-1',
            projection: machineProjection({
                generation: 7,
                entriesById: {
                    bundled: placementEntry({
                        pluginId: 'happier.triage',
                        localId: 'triage',
                        container: 'appPage',
                    }),
                    external: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
                },
                installedPackagesById: {
                    'happier.triage': installedPackage('happier.triage', 'bundled'),
                    'acme.inspector': installedPackage('acme.inspector', 'marketplace'),
                },
            }),
            phase: 'current',
            interactionEnabled: true,
        };

        const union = unionPluginUiProjections([unstampedMember], new Map());

        const bundled = union.pluginUiProjection
            ?.surfacePlacementsById['surfacePlacement:happier.triage:triage'];
        const external = union.pluginUiProjection
            ?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'];
        expect(bundled).toBeDefined();
        // C1: the external plugin in the identical structural position is
        // admitted on identical terms. A `source.kind` branch here would give
        // the bundled copy a capability the external one cannot reach.
        expect(external).toBeDefined();
        expect(union.pluginUiProjection?.installedPackagesById['happier.triage']).toBeDefined();
        expect(union.pluginUiProjection?.installedPackagesById['acme.inspector']).toBeDefined();
        expect(union.interactionEnabled).toBe(true);
        // The exact origin is absent because no materialization exists — every
        // consumer that needs one (launch input, mounted action caller) keeps
        // failing closed on its own rather than on a fabricated identity.
        for (const admitted of [bundled, external]) {
            expect(readPluginUiContributionOrigin(admitted)).toMatchObject({
                machineId: 'machine-a',
                phase: 'current',
                executionOrigin: null,
            });
        }
    });

    it('still withholds an unstamped contribution wherever a selection exists for that plugin', () => {
        // The fail-closed half that must survive the re-key: once the Account
        // holds a selection for a plugin id, only the exact producer stamp
        // admits it. A daemon that lost its execution-origin context publishes
        // unstamped entries, and those must not slip in through the
        // unmaterialized arm.
        const unstampedMember: PluginUiProjectionUnionMember = {
            machineId: 'machine-a',
            serverId: 'server-1',
            projection: machineProjection({
                generation: 7,
                entriesById: {
                    selected: placementEntry({ pluginId: 'acme.selected', localId: 'panel' }),
                },
                installedPackagesById: {},
            }),
            phase: 'current',
            interactionEnabled: true,
        };

        const union = unionPluginUiProjections(
            [unstampedMember],
            selectedOrigins(selectedOrigin('acme.selected', 'machine-a')),
        );

        expect(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.selected:panel'])
            .toBeUndefined();
        expect(union.pluginUiProjection?.installedPackagesById['acme.selected']).toBeUndefined();
    });

    it('treats an authority flip as a member change and an unchanged snapshot as none', () => {
        const alpha = member({ machineId: 'machine-a', generation: 3 });
        expect(arePluginUiProjectionUnionMembersEquivalent([alpha], [{ ...alpha }])).toBe(true);
        expect(arePluginUiProjectionUnionMembersEquivalent([alpha], [{ ...alpha, interactionEnabled: false }])).toBe(false);
        expect(arePluginUiProjectionUnionMembersEquivalent(
            [alpha],
            [{ ...alpha, projection: machineProjection({ generation: 3, entriesById: {} }) }],
        )).toBe(false);
        expect(arePluginUiProjectionUnionMembersEquivalent([alpha], [])).toBe(false);
    });

    it('reads no origin from a single-machine projection entry', () => {
        const scoped = machineProjection({
            generation: 5,
            entriesById: { a: placementEntry({ pluginId: 'acme.alpha', localId: 'panel' }) },
        });
        expect(readPluginUiContributionOrigin(
            scoped.surfacePlacementsById['surfacePlacement:acme.alpha:panel'],
        )).toBeNull();
        expect(readPluginUiContributionOrigin({ hostOrigin: { machineId: '  ' } })).toBeNull();
        expect(readPluginUiContributionOrigin({
            hostOrigin: {
                machineId: 'machine-a',
                interactionEnabled: true,
            },
        })).toBeNull();
        expect(readPluginUiContributionOrigin(null)).toBeNull();
    });

    it('reads only the exact paired producer execution origin from a direct entry', () => {
        const origin = selectedOrigin('acme.alpha', 'machine-a');
        const entry = {
            ...placementEntry({ pluginId: 'acme.alpha', localId: 'panel' }),
            serverIdentityId: origin.serverIdentityId,
            materializationRef: origin.materializationRef,
        };

        expect(readPluginUiProjectionEntryExecutionOrigin(entry)).toEqual(origin);
        expect(readPluginUiProjectionEntryExecutionOrigin({
            ...entry,
            materializationRef: { ...origin.materializationRef, pluginId: 'acme.other' },
        })).toBeNull();
        expect(readPluginUiProjectionEntryExecutionOrigin({
            ...entry,
            materializationRef: undefined,
        })).toBeNull();
    });
});
