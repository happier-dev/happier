import { afterEach, describe, expect, it } from 'vitest';

import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionInputV1Schema,
    PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionInputV1Schema,
    PluginAvailabilityMaterializationsReadActionInputV1Schema,
    PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability';
import {
    clearPluginAccountAvailabilityProjection,
    readPluginAccountAvailability,
} from '@/sync/domains/plugins/availability/projection';
import { refreshPluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/refreshProjection';

import { createActivePluginAccountAvailabilityProjectionHydrator } from './pluginAvailabilityProjection';

const scope = { serverId: 'srv-row-level', accountId: 'account-row-level' } as const;
const paths = {
    materializations: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
    intentsList: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
    intentRead: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'],
} as const;

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * The Home is the system boundary: it honours the canonical input schemas
 * (including the optional `pluginIds` materialization filter) and counts the
 * rows and bytes it serves, while hydration, merge and publication stay real.
 */
function createFakeHome(input: Readonly<{ machines: number; plugins: number }>) {
    let cursor = 10;
    const pluginIds = Array.from({ length: input.plugins }, (_, index) => `com.acme.p${String(index).padStart(2, '0')}`);
    const machineIds = Array.from({ length: input.machines }, (_, index) => `machine-${String(index).padStart(2, '0')}`);
    const rows = new Map<string, PluginMachineMaterializationV1[]>(machineIds.map(machineId => [machineId, pluginIds.map(pluginId => ({
        serverIdentityId: 'srv_identity', machineId, materializationId: `${machineId}:${pluginId}:1`, pluginId,
        version: '1.0.0', sourceClass: 'localPath', portableRelease: false, uiArtifacts: [], enabled: true,
        trustState: 'trusted', observedAt: 1,
    }))]));
    const intentResponse = (pluginId: string) => PluginAvailabilityIntentReadActionOutputV1Schema.parse({
        availabilityCursor: cursor, hostingCapability: { enabled: false },
        intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'disabled',
            writableCollections: [], revision: '1' },
        release: null, packageAssets: [], uiArtifacts: [],
    });
    const served = { fullMaterializationReads: 0, materializationRows: 0, intentListReads: 0, intentReads: 0, bytes: 0 };
    const respond = (body: unknown) => {
        const text = JSON.stringify(body);
        served.bytes += text.length;
        return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const request = async (path: string, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (path === paths.materializations) {
            const parsed = PluginAvailabilityMaterializationsReadActionInputV1Schema.parse(body);
            const filter = parsed.pluginIds ? new Set(parsed.pluginIds) : null;
            if (!filter) served.fullMaterializationReads += 1;
            const snapshots = [...rows.entries()].map(([machineId, machineRows]) => ({
                serverIdentityId: 'srv_identity', machineId,
                materializations: machineRows.filter(row => !filter || filter.has(row.pluginId)),
            }));
            served.materializationRows += snapshots.reduce((total, snapshot) => total + snapshot.materializations.length, 0);
            return respond({ availabilityCursor: cursor, snapshots, releases: [], inventoryComplete: true });
        }
        if (path === paths.intentsList) {
            const parsed = PluginAvailabilityIntentsListActionInputV1Schema.parse(body);
            if (parsed.pluginIds) {
                // An exact named read: only these plugins, one request.
                served.intentReads += 1;
                const named = [...parsed.pluginIds].sort();
                return respond({ availabilityCursor: cursor, failedPluginIds: [],
                    pluginIds: named.filter(pluginId => pluginIds.includes(pluginId)),
                    intentReads: named.map(pluginId => ({ pluginId, response: intentResponse(pluginId) })) });
            }
            served.intentListReads += 1;
            const ids = [...new Set([...pluginIds, ...(parsed.knownPluginIds ?? [])])].sort();
            return respond({ availabilityCursor: cursor, pluginIds: ids, nextCursor: null, failedPluginIds: [],
                intentReads: ids.map(pluginId => ({ pluginId, response: intentResponse(pluginId) })) });
        }
        if (path === paths.intentRead) {
            const parsed = PluginAvailabilityIntentReadActionInputV1Schema.parse(body);
            served.intentReads += 1;
            return respond(intentResponse(parsed.pluginId));
        }
        throw new Error(`Unexpected Availability path: ${path}`);
    };
    return {
        pluginIds,
        machineIds,
        served,
        request,
        resetCounts: () => Object.assign(served, { fullMaterializationReads: 0, materializationRows: 0, intentListReads: 0, intentReads: 0, bytes: 0 }),
        /** One Machine report that reinstalls `pluginId` on one Machine and removes it from another. */
        changePlugin: (pluginId: string, reinstalledOn: string, removedFrom: string) => {
            cursor += 1;
            rows.set(reinstalledOn, rows.get(reinstalledOn)!.map(row => row.pluginId === pluginId
                ? { ...row, materializationId: `${reinstalledOn}:${pluginId}:2`, version: '1.1.0', observedAt: 2 } : row));
            rows.set(removedFrom, rows.get(removedFrom)!.filter(row => row.pluginId !== pluginId));
            return { cursor, kind: 'pluginDomain', entityId: `pluginDomain/${pluginId}/availability`, changedAt: 2,
                hint: { pluginDomain: 'availability', pluginId } };
        },
    };
}

function createHydrator(home: ReturnType<typeof createFakeHome>) {
    return createActivePluginAccountAvailabilityProjectionHydrator({
        captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
        getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
        captureRequestAuthority: async () => ({ request: home.request }),
    });
}

/** Order-insensitive view of the published Account facts. */
function publishedFacts() {
    const admitted = readPluginAccountAvailability(scope).readMaterializations();
    if (admitted.kind !== 'available') throw new Error(`Availability not published: ${admitted.code}`);
    const byId = <T extends Readonly<{ materializationId: string }>>(left: T, right: T) =>
        left.materializationId < right.materializationId ? -1 : 1;
    return {
        availabilityCursor: admitted.availabilityCursor,
        // Each intent read carries the cursor it was read at (per-plugin
        // commits need no Account-wide cursor agreement), so compare facts.
        intentReads: [...admitted.intentReads].sort((left, right) => left.pluginId < right.pluginId ? -1 : 1)
            .map(({ response: { availabilityCursor: _readAt, ...response }, ...entry }) => ({ ...entry, response })),
        materializations: [...admitted.materializations].sort(byId),
        snapshots: [...admitted.snapshots].sort((left, right) => left.machineId < right.machineId ? -1 : 1)
            .map(snapshot => ({ ...snapshot, materializations: [...snapshot.materializations].sort(byId) })),
    };
}

afterEach(() => {
    clearPluginAccountAvailabilityProjection();
});

describe('row-level Account Availability refresh', () => {
    it('reads only the named plugin for a one-plugin change and publishes the same facts as a fresh full read', async () => {
        // Workload: 20 Machines × 30 plugins = 600 materializations; one plugin changes on two Machines.
        const home = createFakeHome({ machines: 20, plugins: 30 });
        const hydrator = createHydrator(home);
        await refreshPluginAccountAvailabilityProjection(hydrator);
        expect(home.served).toMatchObject({ fullMaterializationReads: 1, materializationRows: 600, intentListReads: 1 });
        const fullBytes = home.served.bytes;
        home.resetCounts();

        const changedPluginId = home.pluginIds[7]!;
        const change = home.changePlugin(changedPluginId, home.machineIds[3]!, home.machineIds[11]!);
        expect(hydrator.invalidate([change])).toEqual([changedPluginId]);
        await refreshPluginAccountAvailabilityProjection(hydrator);

        // The changed plugin is installed on 19 Machines now; nothing else is read.
        expect({
            fullMaterializationReads: home.served.fullMaterializationReads,
            materializationRows: home.served.materializationRows,
            intentListReads: home.served.intentListReads,
            intentReads: home.served.intentReads,
        }).toEqual({ fullMaterializationReads: 0, materializationRows: 19, intentListReads: 0, intentReads: 1 });
        expect(home.served.bytes).toBeLessThan(fullBytes / 10);
        const merged = publishedFacts();
        expect(merged.materializations).toHaveLength(599);

        clearPluginAccountAvailabilityProjection();
        const fresh = createHydrator(home);
        await refreshPluginAccountAvailabilityProjection(fresh);
        expect(merged).toEqual(publishedFacts());
    });

    it.each([1, 5, 90, 201])('reads %i hint-named plugins\' intents in one request per Availability page', async (named) => {
        // Workload: 2 Machines × 250 plugins; one materialization report names `named` plugins.
        const home = createFakeHome({ machines: 2, plugins: 250 });
        const hydrator = createHydrator(home);
        await refreshPluginAccountAvailabilityProjection(hydrator);
        home.resetCounts();

        const changes = home.pluginIds.slice(0, named)
            .map(pluginId => home.changePlugin(pluginId, home.machineIds[0]!, home.machineIds[1]!));
        expect(hydrator.invalidate(changes)).toHaveLength(named);
        await refreshPluginAccountAvailabilityProjection(hydrator);

        expect({ fullMaterializationReads: home.served.fullMaterializationReads, intentListReads: home.served.intentListReads,
            intentReads: home.served.intentReads }).toEqual({ fullMaterializationReads: 0, intentListReads: 0,
            intentReads: Math.ceil(named / PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE) });
        const merged = publishedFacts();
        clearPluginAccountAvailabilityProjection();
        await refreshPluginAccountAvailabilityProjection(createHydrator(home));
        expect(merged).toEqual(publishedFacts());
    });

    it('keeps a superseded row-level read\'s plugins for the trailing refresh', async () => {
        const home = createFakeHome({ machines: 3, plugins: 4 });
        const hydrator = createHydrator(home);
        await refreshPluginAccountAvailabilityProjection(hydrator);
        const first = home.changePlugin(home.pluginIds[1]!, home.machineIds[0]!, home.machineIds[2]!);
        hydrator.invalidate([first]);
        const inFlight = refreshPluginAccountAvailabilityProjection(hydrator);
        // A second plugin's hint lands while the first read is in flight and retires it.
        hydrator.invalidate([home.changePlugin(home.pluginIds[2]!, home.machineIds[1]!, home.machineIds[0]!)]);
        await expect(inFlight).rejects.toMatchObject({ name: 'ServerFetchReadSupersededError' });
        home.resetCounts();
        await refreshPluginAccountAvailabilityProjection(hydrator);
        // Both named plugins' intents in one exact request.
        expect(home.served).toMatchObject({ fullMaterializationReads: 0, intentListReads: 0, intentReads: 1, materializationRows: 4 });
        const merged = publishedFacts();
        clearPluginAccountAvailabilityProjection();
        await refreshPluginAccountAvailabilityProjection(createHydrator(home));
        expect(merged).toEqual(publishedFacts());
    });

    it('keeps the structural full read for a structural request even when a plugin change is pending', async () => {
        const home = createFakeHome({ machines: 3, plugins: 4 });
        const hydrator = createHydrator(home);
        await refreshPluginAccountAvailabilityProjection(hydrator);
        home.resetCounts();

        hydrator.invalidate([home.changePlugin(home.pluginIds[1]!, home.machineIds[0]!, home.machineIds[2]!)]);
        hydrator.requireFullRefresh();
        await refreshPluginAccountAvailabilityProjection(hydrator);
        expect(home.served).toMatchObject({ fullMaterializationReads: 1, materializationRows: 11, intentListReads: 1, intentReads: 1 });

        // The full census and exact declaration satisfied the structural request and named change.
        home.resetCounts();
        await refreshPluginAccountAvailabilityProjection(hydrator);
        expect(home.served).toMatchObject({ fullMaterializationReads: 1 });
    });
});
