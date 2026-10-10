import { describe, expect, it, vi } from 'vitest';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import {
    normalizePluginUiDestinationBindingV1,
    type PluginUiDestinationBindingInputV1,
} from '@happier-dev/protocol/plugins/ui';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';

import { normalizePluginUiProjection, EMPTY_PLUGIN_UI_PROJECTION } from './projection';
import { selectPluginSurfacePlacementsForBinding } from './surfacePlacementSelectors';
import {
    arePluginUiProjectionUnionMembersEquivalent,
    readPluginUiContributionOrigin,
    readPluginUiProjectionEntryExecutionOrigin,
    unionPluginUiProjections,
    mergeInstalledPluginUiProjections,
    readPluginUiContributionSupplies,
    readPluginUiExecutionOriginCandidates,
    type PluginUiProjectionUnionMember,
} from './projectionUnion';

it('retains proven installed declarations on a cold client without fabricating runtime identity', () => {
    const entry = { ...placementEntry({ pluginId: 'acme.channels', localId: 'channels', container: 'appPage' }), occurrenceId: undefined };
    const installed = { ...machineProjection({ generation: 1, entriesById: { [String(entry.id)]: entry } }), generation: null };
    const merged = mergeInstalledPluginUiProjections([installed], null);
    expect(merged?.surfacePlacementsById[String(entry.id)]).toMatchObject({ pluginId: 'acme.channels' });
    expect(merged?.surfacePlacementsById[String(entry.id)]?.occurrenceId).toBeUndefined();
    expect(merged?.generation).toBeNull();
    expect(mergeInstalledPluginUiProjections([], null)).toBeNull();
});

it('reuses the live occurrence for the same declared root without confusing runtime identity with content', () => {
    const pluginId = 'acme.channels';
    const entry = placementEntry({ pluginId, localId: 'channels', container: 'appPage' });
    const declarative = {
        identity: { pluginId, localId: 'inspector', qualifiedId: `${pluginId}/inspector` },
        visible: true, requiredHostMethods: [],
        declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
        root: { kind: 'text', path: 'root', order: 0, text: 'Channels' },
    };
    const declaredEntry = { ...entry, occurrenceId: undefined, renderer: { kind: 'declarative', contributionId: 'inspector', model: declarative } };
    const runtimeEntry = { ...entry, renderer: { kind: 'declarative', contributionId: 'inspector', model: {
        ...declarative, identity: { ...declarative.identity, occurrenceId: entry.occurrenceId },
    } } };
    const declared = { ...machineProjection({ generation: 1, entriesById: { [String(entry.id)]: declaredEntry } }), generation: null };
    const runtime = machineProjection({ generation: 7, entriesById: { [String(entry.id)]: runtimeEntry } });
    expect(mergeInstalledPluginUiProjections([declared], runtime)?.surfacePlacementsById[String(entry.id)])
        .toBe(runtime.surfacePlacementsById[String(entry.id)]);
    const changed = { ...declared, surfacePlacementsById: { ...declared.surfacePlacementsById,
        [String(entry.id)]: { ...declared.surfacePlacementsById[String(entry.id)]!, renderer: { ...declaredEntry.renderer,
            model: { ...declarative, root: { ...declarative.root, text: 'New content' } } } } } };
    expect(mergeInstalledPluginUiProjections([changed], runtime)?.surfacePlacementsById[String(entry.id)]?.occurrenceId).toBeUndefined();
});

it('retains the declaring installation default beside each exact contribution supply', () => {
    const pluginId = 'acme.channels';
    const entry = placementEntry({ pluginId, localId: 'channels', container: 'appPage' });
    const projection = unionPluginUiProjections([member({ machineId: 'machine-a', generation: 1,
        entriesById: { [String(entry.id)]: entry }, installedPackagesById: { [pluginId]: {
            id: pluginId, displayName: 'Channels', version: '1.0.0', enabled: true,
            source: { kind: 'bundled' }, executionTarget: { default: 'installation' },
        } } })]).pluginUiProjection;
    expect(readPluginUiContributionSupplies(projection?.surfacePlacementsById[String(entry.id)])[0])
        .toMatchObject({ executionTargetDefault: true });
});

it('projects only a real current source occurrence for execution and retains its exact offline identity', () => {
    const pluginId = 'acme.local';
    const entry = placementEntry({ pluginId, localId: 'local', container: 'appPage' });
    const occurrenceId = String(entry.occurrenceId);
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'registered-root-a' };
    const source: PluginUiProjectionUnionMember = {
        machineId: 'machine-a', serverId: 'server-1', serverIdentityId: 'srv_test', phase: 'current', interactionEnabled: true,
        projection: machineProjection({ generation: 7, entriesById: { [String(entry.id)]: entry }, installedPackagesById: {
            [pluginId]: { id: pluginId, displayName: 'Local', version: '1.0.0', enabled: true, source: { kind: 'localPath' },
                occurrenceId, sourceCustody, executionTarget: { default: 'installation' } },
        } }),
    };
    const read = (member: PluginUiProjectionUnionMember) => readPluginUiExecutionOriginCandidates({
        projection: unionPluginUiProjections([member]).pluginUiProjection, pluginId,
    });
    expect(read(source).sourceCandidates).toEqual([expect.objectContaining({ source: {
        origin: { serverIdentityId: 'srv_test', sourceRef: { machineId: 'machine-a', pluginId, sourceCustody } },
        version: '1.0.0', occurrenceId, serverId: 'server-1', generation: 7,
    }, validation: { kind: 'admitted' } })]);
    expect(read(source).declaredDefaultOrigins).toEqual([read(source).sourceCandidates[0]!.source.origin]);
    expect(read({ ...source, phase: 'retainedOffline', interactionEnabled: false }).sourceCandidates[0])
        .toMatchObject({ source: { occurrenceId, origin: read(source).sourceCandidates[0]!.source.origin }, validation: { kind: 'rejected', reason: 'stale' } });
    const revoked: PluginMachineMaterializationV1 = { serverIdentityId: 'srv_test', machineId: 'machine-a',
        materializationId: 'source-observation', pluginId, version: '1.0.0', sourceClass: 'localPath',
        portableRelease: false, uiArtifacts: [], enabled: false, trustState: 'revoked', observedAt: 2 };
    expect(read({ ...source, materializationsByPluginId: { [pluginId]: revoked } }).sourceCandidates[0]?.validation.kind)
        .toBe('rejected');
});

function machineProjection(input: Readonly<{
    generation: number;
    entriesById: Readonly<Record<string, unknown>>;
    actionsById?: Readonly<Record<string, unknown>>;
    resourcesById?: Readonly<Record<string, unknown>>;
    inputTypesById?: Readonly<Record<string, unknown>>;
    installedPackagesById?: Readonly<Record<string, unknown>>;
}>) {
    return normalizePluginUiProjection({
        v: 2,
        generation: input.generation,
        installedPackagesById: input.installedPackagesById ?? {},
        agentsById: {},
        actionsById: input.actionsById ?? {},
        toolsById: {},
        commandsById: {},
        resourcesById: input.resourcesById ?? {},
        settingsById: {},
        familiesById: {
            pluginUi: { family: 'pluginUi', entriesById: input.entriesById },
            inputTypes: { family: 'inputTypes', entriesById: input.inputTypesById ?? {} },
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
}>) {
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
        occurrenceId: `${input.pluginId}:${input.localId}:occurrence`,
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
        occurrenceId: `${pluginId}:bundle:occurrence`,
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
            ...('materializationRef' in origin ? { materializationRef: origin.materializationRef }
                : { sourceCustody: origin.sourceRef.sourceCustody }),
        }];
    }));
}

function member(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    generation?: number;
    entriesById?: Readonly<Record<string, unknown>>;
    actionsById?: Readonly<Record<string, unknown>>;
    resourcesById?: Readonly<Record<string, unknown>>;
    installedPackagesById?: Readonly<Record<string, unknown>>;
    producerOriginsByPluginId?: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
    phase?: PluginUiProjectionUnionMember['phase'];
    interactionEnabled?: boolean;
    archiveDigest?: `sha256:${string}`;
    uiArtifacts?: PluginMachineMaterializationV1['uiArtifacts'];
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
                resourcesById: input.resourcesById,
        }),
        phase: input.phase ?? (input.interactionEnabled === false ? 'retainedOffline' : 'current'),
        interactionEnabled: input.interactionEnabled ?? true,
        materializationsByPluginId: Object.fromEntries(Object.values(input.entriesById ?? input.actionsById ?? {})
            .flatMap(entry => {
                const value = entry as Readonly<Record<string, unknown>>;
                if (typeof value.pluginId !== 'string') return [];
                const pluginId = value.pluginId;
                const origin = input.producerOriginsByPluginId?.[pluginId] ?? selectedOrigin(pluginId, input.machineId);
                if (!('materializationRef' in origin)) return [];
                return [[pluginId, { ...origin.materializationRef, serverIdentityId: origin.serverIdentityId,
                    version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
                    archiveDigestSha256: input.archiveDigest ?? `sha256:${'a'.repeat(64)}`,
                    uiArtifacts: input.uiArtifacts ?? [], enabled: true, trustState: 'trusted', observedAt: 1 } satisfies PluginMachineMaterializationV1]];
            })),
    };
}

function selectedOrigin(pluginId: string, machineId: string): Extract<PluginMachineExecutionOriginV1, { materializationRef: unknown }> {
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
    return new Map(origins.map((origin) => [('materializationRef' in origin ? origin.materializationRef : origin.sourceRef).pluginId, origin]));
}

describe('unionPluginUiProjections', () => {
    it('shows Channels on A and Triage on B before any execution or administration selection', () => {
        const union = unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 1, entriesById: {
                channels: placementEntry({ pluginId: 'happier.channels', localId: 'conversations', container: 'appPage' }),
            } }),
            member({ machineId: 'machine-b', generation: 2, entriesById: {
                triage: placementEntry({ pluginId: 'happier.triage', localId: 'triage', container: 'appPage' }),
            } }),
        ], new Map());
        expect(union.pluginUiProjection).not.toBeNull();
        expect(selectPluginSurfacePlacementsForBinding(union.pluginUiProjection!, {
            container: 'appPage', targetKind: 'app',
        }).map(entry => entry.pluginId)).toEqual(['happier.channels', 'happier.triage']);
    });

    it('keeps identical portable declarations visible without electing an execution origin', () => {
        const entries = { panel: placementEntry({ pluginId: 'acme.notes', localId: 'notes', container: 'appPage' }) };
        const union = unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 1, entriesById: entries }),
            member({ machineId: 'machine-b', generation: 2, entriesById: entries }),
        ], new Map());
        const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
        expect(placement).toBeDefined();
        expect(readPluginUiContributionOrigin(placement)).toBeNull();
        expect(placement?.hostSupplies).toHaveLength(2);
    });

    it('does not coalesce the same version with different content or renderer ABI', () => {
        const entries = { panel: placementEntry({ pluginId: 'acme.notes', localId: 'notes', container: 'appPage' }) };
        const a = member({ machineId: 'machine-a', generation: 1, entriesById: entries });
        const differingContent = member({ machineId: 'machine-b', generation: 2, entriesById: entries,
            archiveDigest: `sha256:${'b'.repeat(64)}` });
        const differingAbi = member({ machineId: 'machine-b', generation: 2, entriesById: entries,
            uiArtifacts: [{ contributionId: 'notes', artifactId: 'notes-web', tier: 'hostedWeb', platform: 'web',
                artifactDigest: `sha256:${'c'.repeat(64)}`, hostUiApiRange: '^2.0.0' }] });
        for (const b of [differingContent, differingAbi]) {
            const placement = unionPluginUiProjections([a, b]).pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
            expect(placement).toMatchObject({ hostCompatibility: 'conflict', availability: { state: 'blocked' } });
            expect(readPluginUiContributionOrigin(placement)).toBeNull();
            expect(readPluginUiProjectionEntryExecutionOrigin(placement)).toBeNull();
        }
    });

    it('retains visible declarations when a saved execution target is offline', () => {
        const union = unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 1, phase: 'retainedOffline', interactionEnabled: false,
                entriesById: { panel: placementEntry({ pluginId: 'acme.notes', localId: 'notes' }) } }),
        ], new Map());
        const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
        expect(placement).toBeDefined();
        expect(readPluginUiContributionOrigin(placement)).toMatchObject({ phase: 'retainedOffline', interactionEnabled: false });
    });

    it('lists divergent installed versions as a conflict instead of hiding or selecting one', () => {
        const pluginId = 'acme.notes';
        const replica = (machineId: string, version: string) => member({ machineId, generation: 1,
            entriesById: { panel: placementEntry({ pluginId, localId: 'notes', container: 'appPage' }) },
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Notes', version, enabled: true,
                source: { kind: 'marketplace', locator: pluginId } } },
        });
        const union = unionPluginUiProjections([replica('machine-a', '1.0.0'), replica('machine-b', '2.0.0')], new Map());
        const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
        expect(placement).toMatchObject({ hostCompatibility: 'conflict', availability: { state: 'blocked' } });
        expect(placement?.hostSupplies).toHaveLength(2);
        expect(readPluginUiContributionOrigin(placement)).toBeNull();
    });

    it('handles absent optional execution origins without allocating schema errors', () => {
        const source = { machineId: 'machine-a', serverId: 'server-1', phase: 'current', interactionEnabled: true,
            projection: machineProjection({ generation: 1, entriesById: {
                placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
            } }) } as const;
        // Call-through instrumentation: all present/invalid records still use the real schema.
        const parse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
        try {
            const union = unionPluginUiProjections([source], new Map());
            const placement = Object.values(union.pluginUiProjection?.surfacePlacementsById ?? {})[0];
            expect(placement).toBeDefined();
            expect(readPluginUiContributionOrigin(placement)).toMatchObject({ machineId: 'machine-a', executionOrigin: null });
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
        expect(readPluginUiProjectionEntryExecutionOrigin({ pluginId: 'acme.inspector', serverIdentityId: 'srv_test',
            materializationRef: { pluginId: 'acme.inspector' } })).toBeNull();
        expect(readPluginUiContributionOrigin({ hostOrigin: { machineId: 'machine-a', phase: 'current',
            executionOrigin: { serverIdentityId: 'srv_test', materializationRef: {} } } })?.executionOrigin).toBeNull();
        const valid = selectedOrigin('acme.inspector', 'machine-a');
        expect(readPluginUiProjectionEntryExecutionOrigin({ pluginId: 'acme.inspector', ...valid })).toEqual(valid);
    });

    it.runIf(process.env.HAPPIER_MEASURE_UI_HOT_LOOPS === '1')('measures 2,000 originless contributions', () => {
        const source = { machineId: 'machine-a', serverId: 'server-1', phase: 'current', interactionEnabled: true,
            projection: machineProjection({ generation: 1, entriesById: Object.fromEntries(
                Array.from({ length: 2_000 }, (_, index) => [`placement-${index}`,
                    placementEntry({ pluginId: 'acme.inspector', localId: `panel-${index}` })]),
            ) }) } as const;
        const start = performance.now();
        for (let index = 0; index < 5; index++) {
            const union = unionPluginUiProjections([source], new Map());
            expect(Object.keys(union.pluginUiProjection?.surfacePlacementsById ?? {})).toHaveLength(2_000);
        }
        console.log(JSON.stringify({ measurement: 'originless-projection', contributions: 2_000, unions: 5,
            elapsedMs: performance.now() - start }));
    });

    it('retains a schema-only input type from its selected serving occurrence without a UI sibling', () => {
        const pluginId = 'acme.types';
        const origin = selectedOrigin(pluginId, 'machine-a');
        const type = { id: `${pluginId}/repository`, pluginId, pluginVersion: '1.0.0', occurrenceId: 'current',
            definition: { id: 'repository', title: 'Repository', semantic: 'repository', valueSchema: { type: 'string' as const } },
            ...origin };
        const projection = machineProjection({ generation: 3, entriesById: {},
            inputTypesById: { [type.id]: type }, installedPackagesById: {
                [pluginId]: { id: pluginId, displayName: 'Types', version: '1.0.0', enabled: true,
                    occurrenceId: 'current', source: { kind: 'bundled', locator: pluginId } },
            } });
        const source = { machineId: 'machine-a', serverId: 'server-1', projection,
            phase: 'current', interactionEnabled: true } as const;
        const admitted = unionPluginUiProjections([source], selectedOrigins(origin)).pluginUiProjection?.inputTypesById[type.id];
        expect(admitted).toMatchObject({ occurrenceId: 'current', definition: type.definition });
        expect(readPluginUiContributionOrigin(admitted)).toMatchObject({ executionOrigin: origin, machineId: 'machine-a' });
        expect(unionPluginUiProjections([source], selectedOrigins({ ...origin,
            materializationRef: { ...origin.materializationRef, materializationId: 'another-materialization' },
        })).pluginUiProjection?.inputTypesById[type.id]).toBeUndefined();
        const retired = { ...projection, inputTypesById: { [type.id]: { ...type, occurrenceId: 'retired' } } };
        expect(unionPluginUiProjections([{ ...source, projection: retired }], selectedOrigins(origin))
            .pluginUiProjection?.inputTypesById[type.id]).toBeUndefined();
        const originless = { ...projection, inputTypesById: { [type.id]: { ...type,
            serverIdentityId: undefined, materializationRef: undefined } } };
        expect(unionPluginUiProjections([{ ...source, projection: originless }], new Map())
            .pluginUiProjection?.inputTypesById[type.id]).toMatchObject({ occurrenceId: 'current' });
    });
    it('admits a Resource-only plugin from its exact selected producer origin and current occurrence', () => {
        const pluginId = 'acme.data';
        const selected = selectedOrigin(pluginId, 'machine-a');
        const resource = (machineId: string, occurrenceId: string) => ({
            id: 'report', pluginId, resourceKind: 'config', scope: 'global',
            contentType: 'application/json', digest: null, occurrenceId,
            ...selectedOrigin(pluginId, machineId),
        });
        const source = (machineId: string, occurrenceId: string, resourceOccurrenceId = occurrenceId) => member({
            machineId, generation: machineId === 'machine-a' ? 3 : 99,
            resourcesById: { [`${pluginId}/report`]: resource(machineId, resourceOccurrenceId) },
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Data', version: '1.0.0',
                enabled: true, occurrenceId, source: { kind: 'bundled', locator: pluginId } } },
        });
        const union = unionPluginUiProjections([source('machine-b', 'b'), source('machine-a', 'a')], selectedOrigins(selected));
        const admitted = union.pluginUiProjection?.resourcesById[`${pluginId}/report`];
        expect(admitted).toMatchObject({ occurrenceId: 'a' });
        expect(readPluginUiContributionOrigin(admitted)).toMatchObject({ machineId: 'machine-a', executionOrigin: selected });
        expect(union.pluginUiProjection?.installedPackagesById[pluginId]).toMatchObject({ occurrenceId: 'a' });
        expect(union.pluginUiProjection?.surfacePlacementsById).toEqual({});
        expect(unionPluginUiProjections([source('machine-b', 'b')], selectedOrigins(selected)).pluginUiProjection).toBeNull();
        expect(unionPluginUiProjections([source('machine-a', 'a', 'retired')], selectedOrigins(selected)).pluginUiProjection).toBeNull();
        expect(unionPluginUiProjections([source('machine-a', 'a')], new Map()).pluginUiProjection).toBeNull();
    });
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

    it('retains Resources only from the same selected member as the plugin contribution', () => {
        const selected = selectedOrigin('acme.inspector', 'machine-a');
        const source = member({
            machineId: 'machine-a',
            generation: 3,
            entriesById: {
                placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
            },
        });
        if (!source.projection) throw new Error('fixture must produce a projection');

        const resource = {
            id: 'report', pluginId: 'acme.inspector', resourceKind: 'asset' as const,
            scope: 'global' as const, contentType: 'application/json',
        };
        const union = unionPluginUiProjections([{
            ...source,
            projection: {
                ...source.projection,
                resourcesById: {
                    'acme.inspector/report': resource,
                },
            },
        }, member({
            machineId: 'machine-b', generation: 99,
            entriesById: { placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }) },
            resourcesById: { 'acme.inspector/report': { ...resource, scope: 'session' } },
        })], selectedOrigins(selected));

        expect(union.pluginUiProjection?.resourcesById['acme.inspector/report']).toMatchObject(resource);
        expect(readPluginUiContributionOrigin(union.pluginUiProjection?.resourcesById['acme.inspector/report'])).toBeNull();
        expect(Object.isFrozen(union.pluginUiProjection?.resourcesById)).toBe(true);
        expect(union.pluginUiProjection?.surfacePlacementsById).not.toEqual({});
        const unavailableChoice = unionPluginUiProjections([source], selectedOrigins(selectedOrigin('acme.inspector', 'machine-b')));
        expect(unavailableChoice.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel']).toBeDefined();
        expect(readPluginUiContributionOrigin(unavailableChoice.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])).toBeNull();
        const originless = machineProjection({ generation: 4,
            entriesById: { placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }) },
            resourcesById: { 'acme.inspector/report': resource },
        });
        const originlessUnion = unionPluginUiProjections([{ ...source, projection: originless }], new Map());
        expect(originlessUnion.pluginUiProjection?.resourcesById['acme.inspector/report']).toMatchObject(resource);
        expect(readPluginUiContributionOrigin(originlessUnion.pluginUiProjection?.resourcesById['acme.inspector/report']))
            .toMatchObject({ machineId: 'machine-a', executionOrigin: null });
    });

    it('does not appoint a package brand or serving occurrence when installations conflict', () => {
        const pluginId = 'acme.inspector';
        const entries = { placement: placementEntry({ pluginId, localId: 'panel' }) };
        const union = unionPluginUiProjections(['machine-a', 'machine-b'].map((machineId, index) => member({
            machineId, generation: 3, entriesById: entries,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Inspector', version: String(index),
                enabled: true, source: { kind: 'bundled', locator: pluginId }, occurrenceId: machineId } },
        })), selectedOrigins(selectedOrigin(pluginId, 'machine-a')));
        expect(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])
            .toMatchObject({ hostCompatibility: 'conflict' });
        expect(union.pluginUiProjection?.installedPackagesById[pluginId]?.occurrenceId).toBeUndefined();
        expect(union.pluginUiProjection?.installedPackagesById[pluginId]?.enabled).toBe(false);
    });

    it('keeps nonidentical replicated declarations as a visible conflict before selection', () => {
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

        expect(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])
            .toMatchObject({ hostCompatibility: 'conflict', availability: { state: 'blocked' } });
    });

    it('retains a same-machine declaration without binding a replaced materialization', () => {
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
        expect(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel']).toBeDefined();
        expect(readPluginUiContributionOrigin(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])).toBeNull();
    });

    it('retains a declaration without binding a foreign server identity', () => {
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
        expect(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel']).toBeDefined();
        expect(readPluginUiContributionOrigin(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])).toBeNull();
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

    it('retains differing replica entries as conflict without choosing the selected producer', () => {
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
        expect(placements).toHaveLength(2);
        expect(placements.every(placement => placement.hostCompatibility === 'conflict')).toBe(true);
        expect(placements.every(placement => readPluginUiContributionOrigin(placement) === null)).toBe(true);

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
        expect(placements[0]?.hostCompatibility).toBe('conflict');
        expect(readPluginUiContributionOrigin(placements[0])).toBeNull();

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
            phase: 'current',
            hasEstablishingMembers: true,
            interactionEnabled: true,
        });
    });

    it('keeps an admitted current contribution usable while forty unrelated members are establishing', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-a',
                generation: 3,
                entriesById: {
                    selected: placementEntry({ pluginId: 'acme.selected', localId: 'panel' }),
                },
            }),
            ...Array.from({ length: 40 }, (_, index) => member({
                machineId: `offline-${index}`,
                generation: undefined,
                phase: 'establishing',
                interactionEnabled: false,
            })),
        ], selectedOrigins(selectedOrigin('acme.selected', 'machine-a')));

        // The admitted contribution owns its readiness. An offline Machine
        // with no current description cannot withhold that origin's catalog.
        expect(union).toMatchObject({
            phase: 'current',
            interactionEnabled: true,
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

    it('retains an unstamped declaration without granting the selected materialization authority', () => {
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

        const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.selected:panel'];
        expect(placement).toBeDefined();
        expect(readPluginUiContributionOrigin(placement)).toBeNull();

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
