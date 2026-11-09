import { describe, expect, it } from 'vitest';

import { normalizePluginInstalledUiDeclarations, type PluginUiProjectionModel } from './projection';
import { preparePluginUiProjectionOrigins } from './projectionOrigins';
import { createInstalledPluginUiProjectionPublication, createPluginUiProjectionUnionPublication,
    mergeInstalledPluginUiProjections, type PluginUiProjectionUnionMember } from './projectionUnion';

// PERF Account shape (P03-ROUTE-OPEN, agent-qa-perf #84): one Machine installs
// ~86 plugins; each installation contributes one per-plugin declaration model.
// Opening a plugin page (Zen → Triage) brings that plugin's and its sources'
// full manifests one at a time, so each arrival replaces one model in the list.

/** One installation's model, built like the Availability reader builds it. */
function installationModel(pluginId: string, declaredExecution: boolean): PluginUiProjectionModel {
    return preparePluginUiProjectionOrigins(normalizePluginInstalledUiDeclarations({}, undefined, {
        id: pluginId, displayName: pluginId, version: '1.0.0', enabled: true,
        source: { kind: 'bundledFirstParty', locator: `daemon-selected:${pluginId}` },
        declaredExecution: { daemonActions: declaredExecution, contributionPoints: false },
    }, [], [], []));
}

/** The Machine's daemon projection, published through the union like the app shell does. */
function runtimeFor(pluginIds: readonly string[]): PluginUiProjectionModel {
    const machineId = 'machine-perf';
    const member: PluginUiProjectionUnionMember = {
        machineId, serverId: 'home', serverIdentityId: 'srv_identity', phase: 'current', interactionEnabled: true,
        projection: preparePluginUiProjectionOrigins(normalizePluginInstalledUiDeclarations({}, undefined, undefined, [], [], [])),
        materializationsByPluginId: Object.fromEntries(pluginIds.map(pluginId => [pluginId, { serverIdentityId: 'srv_identity', machineId,
            materializationId: `daemon-selected:${pluginId}`, pluginId, version: '1.0.0', sourceClass: 'bundledFirstParty' as const,
            portableRelease: false, enabled: true, trustState: 'trusted' as const, observedAt: 1, uiArtifacts: [] }])),
    };
    return createPluginUiProjectionUnionPublication().publish([member]).pluginUiProjection!;
}

/** Native-operation probes forward unchanged behavior; no domain logic is mocked. */
function countWork<T>(run: () => T) {
    const natives = { entries: Object.entries, values: Object.values, keys: Object.keys, freeze: Object.freeze };
    let work = 0;
    const probe = <F extends (...args: never[]) => unknown>(target: F) => new Proxy(target, {
        apply(fn, receiver, args) { work++; return Reflect.apply(fn, receiver, args); },
    });
    Object.entries = probe(natives.entries);
    Object.values = probe(natives.values);
    Object.keys = probe(natives.keys);
    Object.freeze = probe(natives.freeze);
    try { return { value: run(), work }; }
    finally { Object.assign(Object, natives); }
}

function measureArrival(plugins: number, runtime: 'daemon' | 'none') {
    const ids = Array.from({ length: plugins }, (_, index) => `acme.arrival-${String(index).padStart(3, '0')}`);
    const live = runtime === 'daemon' ? runtimeFor(ids) : null;
    const owner = createInstalledPluginUiProjectionPublication();
    let installed = ids.map(pluginId => installationModel(pluginId, false));
    owner.publish(installed, live);
    // An earlier manifest already arrived; measure the next one.
    installed = installed.map((model, index) => index === 0 ? installationModel(ids[0]!, true) : model);
    owner.publish(installed, live);
    installed = installed.map((model, index) => index === 1 ? installationModel(ids[1]!, true) : model);
    const measured = countWork(() => owner.publish(installed, live));
    return { ...measured, installed, live, ids };
}

describe('installed projection work per plugin declaration arrival', () => {
    for (const runtime of ['daemon', 'none'] as const) {
        it(`re-derives only the arriving plugin, independent of how many plugins the Machine installs (runtime: ${runtime})`, () => {
            const small = measureArrival(20, runtime);
            const large = measureArrival(86, runtime);
            // One plugin's model changed. The other 66 plugins add no work.
            expect(large.work).toBeLessThanOrEqual(Math.ceil(small.work * 1.1));

            // The incremental result is the canonical merge.
            expect(large.value).toEqual(mergeInstalledPluginUiProjections(large.installed, large.live));
            expect(large.value?.installedPackagesById[large.ids[1]!]?.declaredExecution?.daemonActions).toBe(true);
            expect(large.value?.installedPackagesById[large.ids[2]!]?.declaredExecution?.daemonActions).toBe(false);
        });
    }
});
