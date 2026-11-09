import { describe, expect, it, vi } from 'vitest';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginMachineMaterializationV1Schema, PluginMachineUiArtifactV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { PluginProjectedResourceV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import * as sourceCustodyComparison from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import * as executionOriginComparison from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import * as strictJsonProjection from '@happier-dev/protocol/json/strictJsonValue';
import * as projectionOrigins from './projectionOrigins';
import { resolveAtmospherePictureCatalog } from '@/components/atmosphere/pictureCatalog';
import { EMPTY_PLUGIN_UI_PROJECTION, normalizePluginInstalledUiDeclarations, type PluginUiActionProjection } from './projection';
import { preparePluginUiProjectionOrigins, readPluginUiAccountExecutableOrigin } from './projectionOrigins';
import { createInstalledPluginUiProjectionPublication, createPluginUiExecutionOriginCandidatePublication, createPluginUiProjectionUnionPublication, mergeInstalledPluginUiProjections, readPluginUiContributionOrigin, readPluginUiContributionSupplies, readPluginUiExecutionOriginCandidates, readPluginUiProjectionEntryExecutionOrigin, unionPluginUiProjections, type PluginUiProjectionUnionMember } from './projectionUnion';

describe('execution-origin projection identity', () => {
    it('retains current materialization facts with linear work when observations are republished', () => {
        const measure = (size: number) => {
            let reads = 0;
            const members = Array.from({ length: size }, (_, index) => {
                const source = sourceMember(`retention-${index}`, 'acme.union', 'shared');
                const value = PluginMachineMaterializationV1Schema.parse({
                    serverIdentityId: 'srv_identity', machineId: source.machineId, materializationId: source.machineId,
                    pluginId: 'acme.union', version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
                    enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [],
                });
                const materialization = new Proxy(value, { get(target, key, receiver) {
                    if (key === 'portableRelease') reads++;
                    return Reflect.get(target, key, receiver);
                } });
                return { ...source, projection: { ...source.projection!, installedPackagesById: {
                    'acme.union': { ...source.projection!.installedPackagesById['acme.union']!, displayName: 'Union' },
                } }, materializationsByPluginId: { 'acme.union': materialization } };
            });
            const owner = createPluginUiProjectionUnionPublication();
            owner.publish(members);
            const updated = members.map(member => ({ ...member, materializationsByPluginId: {
                'acme.union': { ...member.materializationsByPluginId['acme.union'], observedAt: 2 },
            } }));
            reads = 0;
            owner.publish(updated);
            return reads;
        };
        const small = measure(32);
        const large = measure(64);
        if (process.env.UNION_CHURN_PROFILE) console.info('UNION_CHURN retention reads', { small, large });
        expect(large).toBeLessThanOrEqual(small * 2);
    });

    it('interns re-read native materialization facts per plugin instead of comparing them across every plugin', () => {
        // A Machine re-read publishes fresh materialization objects with equal
        // content for every plugin. Interning compares each manifest/artifact
        // only with content that can be equal, so the work grows with the
        // plugin count, not with its square (P03-SESSION-SETTLE: 85 plugins x
        // 3 Machines held one 15 s publication on Session open).
        const measure = (pluginCount: number) => {
            const machines = ['settle-a', 'settle-b', 'settle-c'];
            const materialize = (machineId: string, pluginId: string) => PluginMachineMaterializationV1Schema.parse({
                serverIdentityId: 'srv_identity', machineId, materializationId: machineId, pluginId, version: '1.0.0',
                sourceClass: 'localPath', portableRelease: false, enabled: true, trustState: 'trusted', observedAt: 1,
                declaredManifest: PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
                    displayName: 'Settle', runtime: { apiVersion: 1 }, contributes: { ui: {
                        renderers: [{ id: 'content', kind: 'declarative', root: { kind: 'text', text: 'Settle payload' } }],
                        views: [{ id: 'content', container: 'appPage', target: { kind: 'app' }, title: 'Settle', renderer: 'content' }],
                    } } }),
                uiArtifacts: ['a', 'b'].map(slot => ({ contributionId: 'content', artifactId: `${pluginId}-${slot}`, tier: 'hostedWeb',
                    platform: 'web', artifactDigest: `sha256:${slot.repeat(64)}`, hostUiApiRange: '^1.0.0' })),
            });
            const pluginIds = Array.from({ length: pluginCount }, (_, index) => `acme.settle-${index}`);
            const member = (machineId: string) => {
                const fragments = pluginIds.map(pluginId => sourceMember(machineId, pluginId, `${pluginId}-row`).projection!);
                return { ...sourceMember(machineId, pluginIds[0]!, `${pluginIds[0]}-row`), projection: preparePluginUiProjectionOrigins({
                    ...fragments[0]!,
                    installedPackagesById: Object.fromEntries(fragments.flatMap(fragment => Object.entries(fragment.installedPackagesById))
                        .map(([pluginId, installed]) => [pluginId, { ...installed, displayName: 'Settle' }])),
                    unknownEntriesById: Object.assign({}, ...fragments.map(fragment => fragment.unknownEntriesById)),
                }), materializationsByPluginId: Object.fromEntries(pluginIds.map(pluginId => [pluginId, materialize(machineId, pluginId)])) };
            };
            const owner = createPluginUiProjectionUnionPublication();
            owner.publish(machines.slice(0, 1).map(member));
            // The other Machines' projections settle: each re-read arrives as
            // fresh, equal-content materialization and projection objects.
            const keys = vi.spyOn(Object, 'keys');
            const same = vi.spyOn(strictJsonProjection, 'sameStrictJsonValue');
            try {
                owner.publish(machines.map(member));
                return { keys: keys.mock.calls.length, comparisons: same.mock.calls.length };
            } finally { keys.mockRestore(); same.mockRestore(); }
        };
        const small = measure(16);
        const large = measure(64);
        if (process.env.UNION_CHURN_PROFILE) console.info('UNION_CHURN materialization interning', { small, large });
        // Four times the plugins may cost about four times the work, never sixteen.
        expect(large.comparisons).toBeLessThanOrEqual(small.comparisons * 4 * 1.5);
        expect(large.keys).toBeLessThanOrEqual(small.keys * 4 * 1.5);
    });

    it('matches a plugin declaration only against that plugin\'s selectable origins when a Machine republishes them', () => {
        // A Machine's selectable list carries every plugin's origin. Fleet
        // agreement for one plugin must not compare each of its entries with
        // every other plugin's origin (P03-SESSION-SETTLE: about 4M origin
        // comparisons in the 15 s after a Session open on 85 plugins).
        const measure = (pluginCount: number) => {
            const pluginIds = Array.from({ length: pluginCount }, (_, index) => `acme.select-${index}`);
            const member = (machineId: string, payload: string) => {
                const fragments = pluginIds.map(pluginId => sourceMember(machineId, pluginId, `${pluginId}-row`).projection!);
                const projection = preparePluginUiProjectionOrigins({ ...fragments[0]!,
                    installedPackagesById: Object.fromEntries(fragments.flatMap(fragment => Object.entries(fragment.installedPackagesById))
                        .map(([pluginId, installed]) => [pluginId, { ...installed, displayName: 'Select' }])),
                    unknownEntriesById: Object.fromEntries(fragments.flatMap(fragment => Object.entries(fragment.unknownEntriesById))
                        .map(([key, entry]) => [key, { ...entry, payload }])),
                });
                return { ...sourceMember(machineId, pluginIds[0]!, `${pluginIds[0]}-row`), projection,
                    selectableExecutionOrigins: pluginIds.map(pluginId => projection.installedPackagesById[pluginId]!.executionOrigin!) };
            };
            // Different payloads make every plugin conflict-sensitive across the two Machines.
            const members = [member('select-a', 'first'), member('select-b', 'second')];
            const owner = createPluginUiProjectionUnionPublication();
            owner.publish(members);
            const republished = members.map(value => ({ ...value, selectableExecutionOrigins: [...value.selectableExecutionOrigins] }));
            const equal = vi.spyOn(executionOriginComparison, 'arePluginMachineExecutionOriginsEqual');
            try {
                owner.publish(republished);
                return equal.mock.calls.length;
            } finally { equal.mockRestore(); }
        };
        const small = measure(16);
        const large = measure(64);
        if (process.env.UNION_CHURN_PROFILE) console.info('UNION_CHURN selectable origin comparisons', { small, large });
        expect(large).toBeLessThanOrEqual(small * 4 * 1.5);
    });

    it('compares only changed suppliers instead of multiplying unrelated member reads by plugin count', () => {
        const measure = (pluginCount: number) => {
            let unrelatedInputReads = 0;
            const members = Array.from({ length: 148 }, (_, index) => {
                const member = sourceMember(`cost-${index}`, `acme.cost-${index % pluginCount}`);
                return index === 1 ? new Proxy(member, { get(target, key, receiver) {
                    if (key === 'projection') unrelatedInputReads++;
                    return Reflect.get(target, key, receiver);
                } }) : member;
            });
            const owner = createPluginUiProjectionUnionPublication();
            const initial = owner.publish(members);
            unrelatedInputReads = 0;
            const edited = { ...members[0]!, projection: { ...members[0]!.projection!, unknownEntriesById: {
                ...members[0]!.projection!.unknownEntriesById,
                'cost-0': { ...members[0]!.projection!.unknownEntriesById['cost-0'], title: 'Changed declaration' },
            } } };
            const next = owner.publish([edited, ...members.slice(1)]);
            expect(next.pluginUiProjection?.unknownEntriesById['cost-0']?.title).toBe('Changed declaration');
            expect(next.pluginUiProjection?.unknownEntriesById['cost-1']).toBe(initial.pluginUiProjection?.unknownEntriesById['cost-1']);
            return unrelatedInputReads;
        };
        // Same fleet and one changed supplier: adding unrelated plugin families
        // cannot multiply reads of an unchanged supplier's currentness.
        const small = measure(2);
        const large = measure(66);
        if (process.env.UNION_CHURN_PROFILE) console.info('UNION_CHURN unchanged supplier reads', { small, large });
        expect(large).toBe(small);
    });

    it('prepares only changed supplier rows in a 300-Action, 30-supplier publication', () => {
        const pluginId = 'acme.union-cost';
        const members = Array.from({ length: 30 }, (_, index) => {
            const member = sourceMember(`supplier-${index}`, pluginId);
            const actionsById = Object.fromEntries(Array.from({ length: 300 }, (_, row) => {
                const id = `action-${row}`;
                return [`${pluginId}/${id}`, { pluginId, id, title: id, scopes: ['session'],
                    surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                    available: true, execution: { target: 'daemon' as const },
                    occurrenceId: member.machineId,
                    executionOrigin: member.projection!.installedPackagesById[pluginId]!.executionOrigin } satisfies PluginUiActionProjection];
            }));
            return { ...member, projection: preparePluginUiProjectionOrigins({ ...member.projection!, actionsById }) };
        });
        const owner = createPluginUiProjectionUnionPublication();
        const initial = owner.publish(members);
        const rowId = `${pluginId}/action-0`;
        const initialSupplies = readPluginUiContributionSupplies(initial.pluginUiProjection?.actionsById[rowId]);
        let preparedKeys = 0;
        const add = Set.prototype.add;
        const set = Map.prototype.set;
        const stackTraceLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 30;
        const countPreparedKey = (value: unknown) => {
            if (typeof value === 'string' && value.startsWith(`${pluginId}/action-`)
                && new Error().stack?.includes('prepareUnionPublicationSource')) preparedKeys++;
        };
        // Count contribution-key work at preparation, not required output-list
        // assembly: a readiness change really changes each Action's supply list.
        const keys = vi.spyOn(Set.prototype, 'add').mockImplementation(function(this: Set<unknown>, value: unknown) {
            countPreparedKey(value);
            return add.call(this, value);
        });
        const counts = vi.spyOn(Map.prototype, 'set').mockImplementation(function(this: Map<unknown, unknown>, key: unknown, value: unknown) {
            countPreparedKey(key);
            return set.call(this, key, value);
        });
        const custody = vi.spyOn(PluginSourceCustodyV1Schema, 'safeParse');
        const publishSupply = vi.spyOn(projectionOrigins, 'publishPluginUiContributionSupplies');
        const changed = members.map((member, index) => index === 13
            ? { ...member, phase: 'establishing' as const, interactionEnabled: false,
                projection: { ...member.projection!, generation: 2 } } : member);
        try {
            const next = owner.publish(changed);
            const supplies = readPluginUiContributionSupplies(next.pluginUiProjection?.actionsById[rowId]);
            expect(supplies).toHaveLength(30);
            expect(supplies.find(supply => supply.machineId === members[13]!.machineId))
                .toMatchObject({ phase: 'establishing', interactionEnabled: false });
            for (const supply of supplies) if (supply.machineId !== members[13]!.machineId)
                expect(supply).toBe(initialSupplies.find(before => before.machineId === supply.machineId));
            expect.soft(preparedKeys).toBe(0); // No declaration key changed.
            const untouchedCustodies = new Set<unknown>(members.filter((_, index) => index !== 13)
                .map(member => member.projection!.installedPackagesById[pluginId]!.sourceCustody));
            expect(custody.mock.calls.filter(([value]) => untouchedCustodies.has(value))).toHaveLength(0);
            expect(custody.mock.calls.some(([value]) => value === members[13]!.projection!.installedPackagesById[pluginId]!.sourceCustody)).toBe(true);
            preparedKeys = 0;
            publishSupply.mockClear();
            custody.mockClear();
            for (let publication = 0; publication < 20; publication++) expect(owner.publish([...changed])).toBe(next);
            expect(preparedKeys).toBe(0);
            expect(publishSupply).not.toHaveBeenCalled();
            expect(custody).not.toHaveBeenCalled();
            const remaining = changed.filter((_, index) => index !== 13).reverse();
            const withdrawn = owner.publish(remaining);
            expect(Object.keys(withdrawn.pluginUiProjection!.actionsById)).toHaveLength(300);
            expect(readPluginUiContributionSupplies(withdrawn.pluginUiProjection!.actionsById[rowId])).toHaveLength(29);
            expect(preparedKeys).toBeGreaterThan(0);
            expect(preparedKeys).toBeLessThanOrEqual(300 * 3); // Only the removed supplier's keys.
            const cleared = owner.publish([]);
            expect(cleared.pluginUiProjection).toBeNull();
        } finally { keys.mockRestore(); counts.mockRestore(); custody.mockRestore(); publishSupply.mockRestore(); Error.stackTraceLimit = stackTraceLimit; }
    });

    it('does not strict-walk admitted declaration values during cold union preparation', () => {
        const members = Array.from({ length: 30 }, (_, index) => {
            const member = sourceMember(`admitted-${index}`, 'acme.admitted');
            return { ...member, projection: preparePluginUiProjectionOrigins({ ...member.projection!,
                unknownEntriesById: strictJsonProjection.projectNativeJsonValueForTransport(Object.fromEntries(
                    Array.from({ length: 300 }, (_, row) => [`row-${row}`, {
                        ...member.projection!.unknownEntriesById[member.machineId],
                        payload: { children: [{ text: `Row ${row}` }] },
                    }]),
                )) as Readonly<Record<string, Readonly<Record<string, unknown>>>>,
            }) };
        });
        const descriptor = Object.getOwnPropertyDescriptors;
        const stackTraceLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 30;
        let admittedComparisonWalks = 0;
        let ingressWalks = 0;
        const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors').mockImplementation(value => {
            const stack = new Error().stack ?? '';
            if (stack.includes('walkStrictPluginJsonValue')) {
                if (/readDeclarationComparisonSnapshot|readMaterializationDeclarationComparison/.test(stack)) admittedComparisonWalks++;
                else ingressWalks++;
            }
            return descriptor(value);
        });
        try {
            const owner = createPluginUiProjectionUnionPublication();
            expect(Object.keys(owner.publish(members).pluginUiProjection!.unknownEntriesById)).toHaveLength(300);
            expect(admittedComparisonWalks).toBe(0);
            // New raw supply envelopes still cross their real origin/custody
            // ingress. They must not inherit a declaration's admission proof.
            expect(ingressWalks).toBeGreaterThan(0);
        } finally { descriptors.mockRestore(); Error.stackTraceLimit = stackTraceLimit; }
    });

    it('publishes each supply once when a 148-Machine union selects a different origin', () => {
        const pluginId = 'acme.linear-supplies';
        const members = Array.from({ length: 148 }, (_, index) => sourceMember(`machine-${String(index).padStart(3, '0')}`, pluginId, 'row'));
        const owner = createPluginUiProjectionUnionPublication();
        const firstOrigin = members[0]!.projection!.installedPackagesById[pluginId]!.executionOrigin!;
        const nextOrigin = members.at(-1)!.projection!.installedPackagesById[pluginId]!.executionOrigin!;
        const before = owner.publish(members, new Map([[pluginId, firstOrigin]]));
        const publish = vi.spyOn(projectionOrigins, 'publishPluginUiContributionSupplies');
        let supplierComparisons = 0;
        const compare = executionOriginComparison.arePluginMachineExecutionOriginsEqual;
        // Observe the real predicate; do not substitute its equality decision.
        const comparisons = vi.spyOn(executionOriginComparison, 'arePluginMachineExecutionOriginsEqual').mockImplementation((left, right) => {
            if (new Error().stack?.includes('publishFirstAdmitted')) supplierComparisons++;
            return compare(left, right);
        });
        try {
            const after = owner.publish(members, new Map([[pluginId, nextOrigin]]));
            expect(readPluginUiContributionOrigin(after.pluginUiProjection?.unknownEntriesById.row)?.machineId).toBe(members.at(-1)!.machineId);
            expect(readPluginUiContributionSupplies(after.pluginUiProjection?.unknownEntriesById.row)).toHaveLength(members.length);
            expect(publish.mock.calls.reduce((count, [supplies]) => count + supplies.length, 0)).toBe(members.length);
            expect(after.pluginUiProjection?.unknownEntriesById.row?.hostSupplies)
                .toBe(before.pluginUiProjection?.unknownEntriesById.row?.hostSupplies);
            expect(supplierComparisons).toBeLessThanOrEqual(members.length);
            expect(supplierComparisons).toBeGreaterThan(0);
        } finally { publish.mockRestore(); comparisons.mockRestore(); }
    });

    it('retains only current projection roots across 24 replacements of a 66-plugin catalog', () => {
        const leaves = Array.from({ length: 66 }, (_, index) => sourceMember('inventory', `acme.retention${index}`, `row${index}`));
        const first = leaves[0]!;
        let member: PluginUiProjectionUnionMember = { ...first, projection: { ...first.projection!,
            installedPackagesById: Object.assign({}, ...leaves.map(leaf => leaf.projection!.installedPackagesById)),
            unknownEntriesById: Object.assign({}, ...leaves.map(leaf => leaf.projection!.unknownEntriesById)),
        } };
        const owner = createPluginUiProjectionUnionPublication();
        const retired = new Set<object>();
        owner.publish([member]);
        for (let publication = 0; publication < 24; publication++) {
            retired.add(member.projection!);
            member = { ...member, phase: publication % 2 ? 'current' : 'establishing',
                interactionEnabled: publication % 2 === 1,
                projection: { ...member.projection!, generation: publication + 2, diagnostics: [] } };
            // Observe the real owner's strong indexes, without replacing their logic
            // or relying on GC scheduling/heap-size thresholds for a retention test.
            const set = vi.spyOn(Map.prototype, 'set');
            let currentMaps: Map<unknown, unknown>[];
            try {
                owner.publish([member]);
                currentMaps = set.mock.calls.flatMap(([key], index) => {
                    const context: unknown = set.mock.contexts[index];
                    return key === member.projection && context instanceof Map ? [context] : [];
                });
            } finally { set.mockRestore(); }
            expect(currentMaps.length).toBeGreaterThan(0);
            for (const map of currentMaps) {
                expect(map.size).toBeLessThanOrEqual(67); // One current root plus its 66 plugin slices.
                expect([...retired].some(root => map.has(root))).toBe(false);
            }
            const reachable = new Set<object>();
            const visit = (value: unknown): void => {
                if (!value || typeof value !== 'object' || reachable.has(value)) return;
                reachable.add(value);
                if (value instanceof Map) for (const [key, child] of value) { visit(key); visit(child); }
                else if (value instanceof Set) for (const child of value) visit(child);
                else for (const key of Reflect.ownKeys(value)) visit(Reflect.get(value, key));
            };
            visit(owner.getSnapshot());
            expect([...retired].some(root => reachable.has(root))).toBe(false);
            expect(Object.keys(owner.getSnapshot().pluginUiProjection!.installedPackagesById)).toHaveLength(66);
        }
    });

    it('does not read stable published selections again and still applies changed selections', () => {
        const pluginId = 'acme.stable';
        const first = sourceMember('first', pluginId, 'row');
        const second = sourceMember('second', pluginId, 'row');
        let memberTraversals = 0;
        const members = new Proxy(Object.freeze([first, second]), {
            get(target, key, receiver) {
                if (key === Symbol.iterator || ['every', 'some', 'map', 'flatMap'].includes(String(key))) memberTraversals++;
                return Reflect.get(target, key, receiver);
            },
        });
        const firstOrigin = first.projection!.installedPackagesById[pluginId]!.executionOrigin!;
        const secondOrigin = second.projection!.installedPackagesById[pluginId]!.executionOrigin!;
        let selectionReads = 0;
        const selection: ReadonlyMap<string, typeof firstOrigin> = new Proxy(new Map([[pluginId, firstOrigin]]), {
            get(target, key) {
                selectionReads++;
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        const owner = createPluginUiProjectionUnionPublication();
        const initial = owner.publish(members, selection);
        expect(readPluginUiContributionOrigin(initial.pluginUiProjection?.unknownEntriesById.row)?.machineId).toBe('first');
        memberTraversals = 0;
        selectionReads = 0;
        for (let report = 0; report < 20; report++) {
            expect(owner.publish(members, selection)).toBe(initial);
        }
        expect(memberTraversals).toBe(0);
        expect(selectionReads).toBe(0);
        const changed = owner.publish(members, new Map([[pluginId, secondOrigin]]));
        expect(readPluginUiContributionOrigin(changed.pluginUiProjection?.unknownEntriesById.row)?.machineId).toBe('second');
        expect(memberTraversals).toBeGreaterThan(0);
        expect(owner.publish(members, new Map())).toEqual(unionPluginUiProjections(members, new Map()));
    });

    it('updates reporting-Machine provenance without deep-walking retained facts across a 56-Machine catalog', () => {
        const pluginId = 'acme.streaming';
        const payload = Object.freeze({ sections: Object.freeze([Object.freeze({ title: 'Retained declaration',
            children: Object.freeze([Object.freeze({ text: 'Unchanged authored payload' })]) })]) });
        const otherPayload = Object.freeze({ sections: Object.freeze([Object.freeze({ title: 'Retained declaration',
            children: Object.freeze([Object.freeze({ text: 'Conflicting authored payload' })]) })]) });
        const nativeManifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
            displayName: 'Retained native manifest', runtime: { apiVersion: 1 }, contributes: { ui: {
                renderers: [{ id: 'content', kind: 'declarative', root: { kind: 'text', text: 'Native manifest comparison payload' } }],
                views: [{ id: 'content', container: 'appPage', target: { kind: 'app' }, title: 'Native manifest comparison', renderer: 'content' }],
            } } });
        let materializationReads = 0;
        let members = Array.from({ length: 56 }, (_, index) => {
            const member = sourceMember(`stream-${String(index).padStart(2, '0')}`, pluginId, 'row');
            const projection = preparePluginUiProjectionOrigins({ ...member.projection!, installedPackagesById: {
                [pluginId]: { ...member.projection!.installedPackagesById[pluginId]!, displayName: 'Streaming' },
            }, unknownEntriesById: {
                row: Object.freeze({ ...member.projection!.unknownEntriesById.row!, payload: index < 28 ? payload : otherPayload }),
            } });
            const slots = ['native-slot-a', 'native-slot-b'].map((artifactId, at) => ({ contributionId: 'content', artifactId,
                tier: 'hostedWeb' as const, platform: 'web' as const, artifactDigest: `sha256:${(at ? 'b' : 'a').repeat(64)}`, hostUiApiRange: '^1.0.0' }));
            const materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId: 'srv_identity', machineId: member.machineId,
                materializationId: member.machineId, pluginId, version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
                enabled: true, trustState: 'trusted', observedAt: 1,
                declaredManifest: index % 2 ? { ...nativeManifest, displayName: 'Conflicting native manifest' } : nativeManifest,
                uiArtifacts: index % 2 ? slots.reverse() : slots });
            const materializationsByPluginId = new Proxy({ [pluginId]: materialization }, {
                get(target, key, receiver) {
                    if (key === pluginId) materializationReads++;
                    return Reflect.get(target, key, receiver);
                },
            });
            return { ...member, projection, materializationsByPluginId,
                selectableExecutionOrigins: [projection.installedPackagesById[pluginId]!.executionOrigin!] } satisfies PluginUiProjectionUnionMember;
        });
        const selections = new Map([[pluginId, members[0]!.projection.installedPackagesById[pluginId]!.executionOrigin!]]);
        const account = accountDeclarationModel();
        const union = createPluginUiProjectionUnionPublication();
        const installed = createInstalledPluginUiProjectionPublication();
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        const publish = () => {
            const runtime = union.publish(members, selections).pluginUiProjection;
            const merged = installed.publish([account], runtime, undefined, selections)!;
            candidates.publish(merged, members, [pluginId]);
            return merged;
        };
        let projection = publish();
        expect(materializationReads).toBeGreaterThan(0);
        materializationReads = 0;
        for (let report = 0; report < members.length; report++) {
            members = members.map(member => ({ ...member, selectableExecutionOrigins: [...member.selectableExecutionOrigins] }));
            expect(publish()).toBe(projection);
        }
        const unchangedMaterializationReads = materializationReads;
        expect.soft(unchangedMaterializationReads).toBe(0);
        materializationReads = 0;
        const retainedFacts = new Set<object>();
        const remember = (value: unknown): void => {
            if (!value || typeof value !== 'object' || retainedFacts.has(value)) return;
            retainedFacts.add(value);
            for (const child of Object.values(value)) remember(child);
        };
        remember(projection.unknownEntriesById.row!.hostSupplies);
        remember(payload);
        const sourceRows = new Set(members.map(member => member.projection.unknownEntriesById.row));
        const entries = vi.spyOn(Object, 'entries');
        const keys = vi.spyOn(Object, 'keys');
        const custody = vi.spyOn(PluginSourceCustodyV1Schema, 'safeParse');
        const compareCustody = vi.spyOn(sourceCustodyComparison, 'pluginSourceCustodyV1Equal');
        const projectJson = vi.spyOn(strictJsonProjection, 'projectNativeJsonValueForTransport');
        const sourceManifests = new Set<unknown>(members.map(member => member.materializationsByPluginId[pluginId]!.declaredManifest));
        materializationReads = 0;
        let untouchedSupplierPreparations = 0;
        let reportingSupplierPreparations = 0;
        let untouchedSupplierComparisons = 0;
        try {
            for (let index = 0; index < members.length; index++) {
                const before = readPluginUiContributionSupplies(projection.unknownEntriesById.row);
                const member = members[index]!;
                const firstPreparation = custody.mock.calls.length;
                const firstComparison = compareCustody.mock.calls.length;
                const reportingCustody = member.projection.installedPackagesById[pluginId]!.sourceCustody;
                const untouchedCustodies = new Set<unknown>(members.filter((_, at) => at !== index)
                    .map(value => value.projection.installedPackagesById[pluginId]!.sourceCustody));
                const phase = index % 2 ? 'retainedOffline' as const : 'establishing' as const;
                members = members.map((value, at) => at === index
                    ? { ...member, phase, interactionEnabled: false, projection: { ...member.projection, generation: 2 } } : value);
                projection = publish();
                const untouchedFacts = new Set(before.filter((_, at) => at !== index).map(supply => supply.sourceCustody));
                untouchedSupplierComparisons += compareCustody.mock.calls.slice(firstComparison)
                    .filter(([left, right]) => untouchedFacts.has(left) || untouchedFacts.has(right)).length;
                for (const [value] of custody.mock.calls.slice(firstPreparation)) {
                    if (untouchedCustodies.has(value)) untouchedSupplierPreparations++;
                    if (value === reportingCustody) reportingSupplierPreparations++;
                }
                const after = readPluginUiContributionSupplies(projection.unknownEntriesById.row);
                expect(after[index]).toMatchObject({ machineId: member.machineId, phase, interactionEnabled: false });
                for (let other = 0; other < members.length; other++) if (other !== index) expect(after[other]).toBe(before[other]);
                expect(projection.unknownEntriesById.row!.payload).toBe(payload);
                remember(after);
            }
            expect.soft(keys.mock.calls.filter(([value]) => retainedFacts.has(value))).toHaveLength(0);
            expect.soft(untouchedSupplierPreparations).toBe(0);
            expect.soft(untouchedSupplierComparisons).toBe(0);
            expect(reportingSupplierPreparations).toBeGreaterThan(0);
            expect(materializationReads).toBeGreaterThan(0);
            // Comparison snapshots own cloned portable JSON. Checking only
            // original payload identities misses equality walks over those
            // unchanged copies during currentness-only publications.
            const deepDeclarationEqualityWalks = keys.mock.calls.filter(([value]) =>
                Object.getOwnPropertyDescriptor(value, 'title')?.value === 'Retained declaration'
                || Object.getOwnPropertyDescriptor(value, 'text')?.value === 'Unchanged authored payload').length;
            expect.soft(deepDeclarationEqualityWalks).toBe(0);
            const nativeManifestProjections = projectJson.mock.calls.filter(([value]) => sourceManifests.has(value)).length;
            const nativeCorrespondenceWalks = keys.mock.calls.filter(([value]) =>
                Object.getOwnPropertyDescriptor(value, 'displayName')?.value === 'Retained native manifest'
                || ['native-slot-a', 'native-slot-b'].includes(Object.getOwnPropertyDescriptor(value, 'artifactId')?.value)).length;
            expect.soft(nativeManifestProjections).toBe(0);
            expect.soft(nativeCorrespondenceWalks).toBe(0);
            const sourceDeclarationTraversals = entries.mock.results.filter(result => result.type === 'return'
                && result.value.some(([, value]) => sourceRows.has(value))).length;
            // Canonical fleet agreement and row assembly still inspect the
            // affected plugin's sources; this is not a zero-total-work claim.
            expect(sourceDeclarationTraversals).toBeGreaterThan(0);
        } finally { entries.mockRestore(); keys.mockRestore(); custody.mockRestore(); compareCustody.mockRestore(); projectJson.mockRestore(); }
        const first = { ...members[0]!, phase: 'current' as const, interactionEnabled: true };
        members = [{ ...first, phase: 'establishing', interactionEnabled: false }, ...members.slice(1)];
        projection = publish();
        expect(readPluginUiContributionOrigin(projection.unknownEntriesById.row)).toMatchObject({
            phase: 'establishing', interactionEnabled: false });
        members = [{ ...first, unavailableReasonCode: 'plugin_source_not_ready', interactionEnabled: false }, ...members.slice(1)];
        projection = publish();
        expect(readPluginUiContributionOrigin(projection.unknownEntriesById.row)).toMatchObject({
            unavailableReasonCode: 'plugin_source_not_ready', interactionEnabled: false });
        const edited = Object.freeze({ sections: Object.freeze([Object.freeze({ title: 'Changed declaration' })]) });
        members = [{ ...first, projection: { ...first.projection, unknownEntriesById: {
            row: { ...first.projection.unknownEntriesById.row!, payload: edited },
        } } }, ...members.slice(1)];
        projection = publish();
        expect(projection.unknownEntriesById.row!.payload).toEqual(edited);
        expect(readPluginUiContributionOrigin(projection.unknownEntriesById.row)?.interactionEnabled).toBe(true);
        const materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId: 'srv_identity', machineId: first.machineId,
            materializationId: first.machineId, pluginId, version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
            enabled: true, trustState: 'revoked', observedAt: 1, uiArtifacts: [] });
        members = [{ ...first, materializationsByPluginId: { [pluginId]: materialization } }, ...members.slice(1)];
        expect(readPluginUiContributionOrigin(publish().unknownEntriesById.row)?.interactionEnabled).toBe(false);
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'replacement-source' };
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_identity', sourceRef: {
            machineId: first.machineId, pluginId, sourceCustody,
        } });
        const replaced = { ...first, projection: preparePluginUiProjectionOrigins({ ...first.projection,
            installedPackagesById: { [pluginId]: { ...first.projection.installedPackagesById[pluginId]!, sourceCustody, executionOrigin } },
            unknownEntriesById: { row: { ...first.projection.unknownEntriesById.row!, executionOrigin } },
        }) };
        selections.set(pluginId, executionOrigin);
        members = [replaced, ...members.slice(1)];
        expect(readPluginUiContributionSupplies(publish().unknownEntriesById.row)[0]).toMatchObject({ sourceCustody, executionOrigin,
            interactionEnabled: true });
        members = members.slice(1);
        expect(readPluginUiContributionSupplies(publish().unknownEntriesById.row).some(supply => supply.machineId === first.machineId)).toBe(false);
        members = [];
        expect(publish().unknownEntriesById.row).toBeUndefined();
        members = [replaced];
        expect(readPluginUiContributionOrigin(publish().unknownEntriesById.row)).toMatchObject({ executionOrigin, interactionEnabled: true });
    });

    it('publishes a fresh empty Account through absent, native-only, UI, pending, clearing and reacquired inputs', () => {
        const visible = sourceMember('visible');
        const nativeSource = sourceMember('native');
        const native = { ...nativeSource, projection: { ...nativeSource.projection!, unknownEntriesById: {} } };
        const installation = PluginMachineMaterializationV1Schema.parse({ serverIdentityId: 'srv_identity', machineId: 'native',
            materializationId: 'native-installation', pluginId: 'acme.native', version: '1.0.0', sourceClass: 'localPath',
            portableRelease: false, enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [] });
        const pending: PluginUiProjectionUnionMember = { ...native, projection: null, phase: 'establishing', interactionEnabled: false,
            materializationsByPluginId: { 'acme.native': installation } };
        const selected = new Map([['acme.visible', visible.projection!.installedPackagesById['acme.visible']!.executionOrigin!]]);
        const publications: readonly (readonly PluginUiProjectionUnionMember[])[] = [[], [], [native], [pending],
            [visible, native], [visible, pending], [visible, native],
            [{ ...visible, phase: 'establishing', interactionEnabled: false }, native],
            [{ ...visible, projection: { ...visible.projection!, generation: 2 } }, native],
            [], [native], [visible], []];
        const ids = ['acme.native', 'acme.visible', 'acme.account'];
        for (const declarations of [[], [EMPTY_PLUGIN_UI_PROJECTION], [accountDeclarationModel()]]) {
            const union = createPluginUiProjectionUnionPublication();
            const installed = createInstalledPluginUiProjectionPublication();
            const candidates = createPluginUiExecutionOriginCandidatePublication();
            expect(union.getSnapshot().pluginUiProjection).toBeNull();
            expect(installed.getSnapshot()).toBeNull();
            expect(candidates.getSnapshot().size).toBe(0);
            for (const members of publications) {
                const actual = union.publish(members, selected);
                expect(actual).toEqual(unionPluginUiProjections(members, selected));
                const merged = installed.publish(declarations, actual.pluginUiProjection, undefined, selected);
                expect(merged).toEqual(mergeInstalledPluginUiProjections(declarations, actual.pluginUiProjection, undefined, selected));
                const facts = candidates.publish(merged, members, ids);
                for (const pluginId of ids) expect(facts.get(pluginId)).toEqual(readPluginUiExecutionOriginCandidates({
                    projection: merged, members, pluginId,
                }));
            }
            // Direct one-shot/raw callers have no owned runtime index and no
            // previous output. They use the same total publication boundary.
            const rawInstalled = createInstalledPluginUiProjectionPublication();
            for (const runtime of [null, EMPTY_PLUGIN_UI_PROJECTION, native.projection, visible.projection, null, visible.projection]) {
                expect(rawInstalled.publish(declarations, runtime, undefined, selected))
                    .toEqual(mergeInstalledPluginUiProjections(declarations, runtime, undefined, selected));
            }
        }
    });

    it('does not reread a retained Resource-only sibling while another Machine changes currentness', () => {
        const source = sourceMember('resource-only');
        const other = sourceMember('other-ui');
        const origin = source.projection!.installedPackagesById['acme.resource-only']!.executionOrigin!;
        const resource = PluginProjectedResourceV2Schema.parse({ id: 'asset', pluginId: 'acme.resource-only',
            resourceKind: 'asset', scope: 'global', contentType: 'application/json' });
        const model = { ...source.projection!, unknownEntriesById: {}, resourcesById: {
            asset: { ...resource, occurrenceId: source.machineId, executionOrigin: origin },
        } };
        const member = { ...source, projection: model };
        const selections = new Map([['acme.resource-only', origin]]);
        const owner = createPluginUiProjectionUnionPublication();
        owner.publish([member, other], selections);
        const values = vi.spyOn(Object, 'values');
        try {
            const actual = owner.publish([member, { ...other, phase: 'establishing', interactionEnabled: false }], selections);
            expect(actual.pluginUiProjection?.resourcesById.asset).toBeDefined();
            expect(values.mock.calls.filter(([value]) => value === model.resourcesById)).toHaveLength(0);
            const replacement = { ...member, projection: { ...model, generation: 2, resourcesById: {} } };
            expect(owner.publish([replacement, other], selections)).toEqual(unionPluginUiProjections([replacement, other], selections));
            expect(owner.getSnapshot().pluginUiProjection?.resourcesById.asset).toBeUndefined();
        } finally { values.mockRestore(); }
    });

    it('matches the canonical union through currentness, source, materialization and topology publications', () => {
        const first = sourceMember('first');
        const other = sourceMember('other');
        const installation = PluginMachineMaterializationV1Schema.parse({ serverIdentityId: 'srv_identity', machineId: 'first',
            materializationId: 'first-installation', pluginId: 'acme.first', version: '1.0.0', sourceClass: 'localPath',
            portableRelease: false, enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [] });
        const publication = createPluginUiProjectionUnionPublication();
        const check = (members: readonly PluginUiProjectionUnionMember[]) => expect(publication.publish(members)).toEqual(unionPluginUiProjections(members));
        check([]);
        check([{ ...first, projection: null, phase: 'establishing', interactionEnabled: false,
            materializationsByPluginId: { 'acme.first': installation } }]);
        check([first, other]);
        check([{ ...first, phase: 'establishing', interactionEnabled: false,
            materializationsByPluginId: { 'acme.first': installation } }, other]);
        check([{ ...first, phase: 'retainedOffline', interactionEnabled: false, unavailableReasonCode: 'plugin_machine_unreachable' }, other]);
        check([{ ...first, projection: { ...first.projection!, generation: 2 } }, other]);
        check([{ ...first, materializationsByPluginId: { 'acme.first': { ...installation, enabled: false } } }, other]);
        check([{ ...first, materializationsByPluginId: { 'acme.first': { ...installation, trustState: 'untrusted' } } }, other]);
        check([{ ...first, projection: { ...first.projection!, unknownEntriesById: {
            first: { ...first.projection!.unknownEntriesById.first!, payload: 'same-generation changed declaration' },
        } } }, other]);
        check([other]);
        check([{ ...first, projection: null, phase: 'unavailable', unavailableReasonCode: 'plugin_daemon_unsupported' }]);
        check([]);
    });

    it('does not accept copied publication metadata as proof for another shallow-frozen runtime snapshot', () => {
        const source = sourceMember('copied');
        const runtime = createPluginUiProjectionUnionPublication().publish([source]).pluginUiProjection!;
        const publication = createInstalledPluginUiProjectionPublication();
        publication.publish([EMPTY_PLUGIN_UI_PROJECTION], runtime);
        const copied = { ...runtime, unknownEntriesById: { copied: { ...runtime.unknownEntriesById.copied, payload: 'new raw input' } } };
        for (const symbol of Object.getOwnPropertySymbols(runtime)) {
            const descriptor = Object.getOwnPropertyDescriptor(runtime, symbol);
            if (descriptor) Object.defineProperty(copied, symbol, descriptor);
        }
        expect(publication.publish([EMPTY_PLUGIN_UI_PROJECTION], Object.freeze(copied))?.unknownEntriesById.copied?.payload)
            .toBe('new raw input');
    });

    it('updates only the affected plugin through union, nonempty Account declarations and candidate publication', () => {
        const account = accountDeclarationModel();
        const members = Array.from({ length: 11 }, (_, index) => sourceMember(`stage${index}`));
        const ids = members.map((_, index) => `acme.stage${index}`);
        const union = createPluginUiProjectionUnionPublication();
        const installed = createInstalledPluginUiProjectionPublication();
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        const initial = installed.publish([account], union.publish(members).pluginUiProjection)!;
        const initialFacts = candidates.publish(initial, members, ids);
        const origin = members[0]!.projection!.installedPackagesById[ids[0]!]!.executionOrigin!;
        const runtime = union.publish(members, new Map([[ids[0]!, origin]])).pluginUiProjection!;
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        try {
            const next = installed.publish([account], runtime)!;
            const facts = candidates.publish(next, members, ids);
            expect(readPluginUiContributionOrigin(next.unknownEntriesById.stage0)?.executionOrigin).toEqual(origin);
            expect(next.surfacePlacementsById).toBe(initial.surfacePlacementsById);
            expect(Object.keys(next.surfacePlacementsById)).toContain('surfacePlacement:acme.account:page');
            for (let index = 1; index < 11; index++) {
                expect(next.unknownEntriesById[`stage${index}`]).toBe(initial.unknownEntriesById[`stage${index}`]);
                expect(facts.get(ids[index]!)).toBe(initialFacts.get(ids[index]!));
            }
            expect({ runtimeFamilyScans: entries.mock.calls.filter(([value]) => value === runtime.unknownEntriesById).length,
                candidateFamilyScans: values.mock.calls.filter(([value]) => value === next.unknownEntriesById).length })
                .toEqual({ runtimeFamilyScans: 0, candidateFamilyScans: 0 });
        } finally { entries.mockRestore(); values.mockRestore(); }
    });

    it('publishes a first runtime without traversing declaration payloads that have no previous value', () => {
        const source = sourceMember('first');
        let payloadWalks = 0;
        const payload = new Proxy({ shared: { schema: { type: 'object', properties: {} } } }, {
            ownKeys(target) { payloadWalks++; return Reflect.ownKeys(target); },
        });
        const runtime = { ...source.projection!, unknownEntriesById: {
            ...source.projection!.unknownEntriesById,
            first: { ...source.projection!.unknownEntriesById.first!, payload },
        } };
        const owner = createInstalledPluginUiProjectionPublication();
        expect(owner.publish([], runtime)).toBe(runtime);
        expect(owner.getSnapshot()).toBe(runtime);
        expect(payloadWalks).toBe(0);
    });

    it('preserves the actual picture picker catalog order when a selected picture source changes', () => {
        const pluginId = 'acme.pictures';
        const alpha = sourceMember('machine-a', pluginId, 'declaration');
        const beta = sourceMember('machine-b', pluginId, 'declaration');
        const other = sourceMember('machine-a', 'acme.other', 'other');
        const picture = (id: string, source: PluginUiProjectionUnionMember, stamped = true) => ({
            id: `${id}`, pluginId: id.slice(0, id.indexOf('/')), pluginVersion: '1.0.0', occurrenceId: source.machineId,
            ...(stamped ? { executionOrigin: source.projection!.installedPackagesById[pluginId]!.executionOrigin! } : {}),
            definition: { id: id.slice(id.indexOf('/') + 1), title: id, kind: 'photo' as const,
                credit: { author: 'Fixture', source: 'Fixture', url: 'https://example.test', licence: 'CC0' },
                src: { full: 'https://example.test/full.jpg', thumb: 'https://example.test/thumb.jpg' },
                horizon: {}, focus: {}, hour: 12, grades: { light: 1, dusk: 1, night: 1 }, dark: 'night' as const, look: {} },
        });
        const members: readonly PluginUiProjectionUnionMember[] = [{ ...alpha, projection: { ...alpha.projection!, unknownEntriesById: {}, installedPackagesById: {
            ...alpha.projection!.installedPackagesById, ...other.projection!.installedPackagesById,
        }, atmospherePicturesById: { 'acme.pictures/b': picture('acme.pictures/b', alpha), 'acme.other/mid': picture('acme.other/mid', other, false) } } },
        { ...beta, projection: { ...beta.projection!, unknownEntriesById: {}, atmospherePicturesById: {
            'acme.pictures/a': picture('acme.pictures/a', beta), 'acme.pictures/b': picture('acme.pictures/b', beta),
        } } }];
        const publication = createPluginUiProjectionUnionPublication();
        const ids = (projection: Parameters<typeof resolveAtmospherePictureCatalog>[0]) => resolveAtmospherePictureCatalog(projection)
            .filter(picture => picture.id.startsWith('acme.')).map(picture => picture.id);
        for (const member of [beta, alpha, beta]) {
            const selections = new Map([[pluginId, member.projection!.installedPackagesById[pluginId]!.executionOrigin!]]);
            expect(ids(publication.publish(members, selections).pluginUiProjection))
                .toEqual(ids(unionPluginUiProjections(members, selections).pluginUiProjection));
        }
    });

    it('matches canonical Resource-only admission, aggregate metadata and removal after reports', () => {
        const pluginId = 'acme.resources';
        const alpha = sourceMember('machine-a', pluginId, 'declaration');
        const beta = sourceMember('machine-b', pluginId, 'declaration');
        const alphaOrigin = alpha.projection!.installedPackagesById[pluginId]!.executionOrigin!;
        const betaOrigin = beta.projection!.installedPackagesById[pluginId]!.executionOrigin!;
        const resource = (id: string) => PluginProjectedResourceV2Schema.parse({
            id, pluginId, resourceKind: 'asset', scope: 'global', contentType: 'application/json',
        });
        const unrelated = sourceMember('machine-a', 'acme.unrelated', 'unrelated');
        const first = { ...alpha, projection: { ...alpha.projection!, unknownEntriesById: unrelated.projection!.unknownEntriesById, resourcesById: {
            'acme.resources/b': { ...resource('b'), occurrenceId: 'machine-a', executionOrigin: alphaOrigin },
        } } };
        const second = { ...beta, projection: { ...beta.projection!, generation: 20, resourcesById: {
            'acme.resources/a': resource('a'), 'acme.resources/b': resource('b'),
        } } };
        const publication = createPluginUiProjectionUnionPublication();
        const check = (members: readonly PluginUiProjectionUnionMember[], origin: typeof alphaOrigin | null) => {
            const selections = origin ? new Map([[pluginId, origin]]) : new Map<string, typeof alphaOrigin>();
            const actual = publication.publish(members, selections);
            const expected = unionPluginUiProjections(members, selections);
            expect(actual).toEqual(expected);
        };
        check([first, second], betaOrigin);
        check([first, second], alphaOrigin);
        check([first, second], betaOrigin);
        check([first, second], null);
        check([first], alphaOrigin);
        check([first], null);
    });

    it('does not rescan candidate package inputs for selection-only member reports over an unchanged union', () => {
        const member = sourceMember('candidate');
        const projection = unionPluginUiProjections([member]).pluginUiProjection;
        const publisher = createPluginUiExecutionOriginCandidatePublication();
        const initial = publisher.publish(projection, [member], ['acme.candidate']);
        const origin = member.projection!.installedPackagesById['acme.candidate']!.executionOrigin!;
        const keys = vi.spyOn(Object, 'keys');
        try {
            for (let index = 0; index < 100; index++) {
                expect(publisher.publish(projection, [{ ...member, selectableExecutionOrigins: index % 2 ? [origin] : [] }], ['acme.candidate'])).toBe(initial);
            }
            expect(keys.mock.calls.filter(([value]) => value === member.projection!.installedPackagesById)).toHaveLength(0);
        } finally { keys.mockRestore(); }
    });

    it('updates eleven UI origin reports by affected plugin without rereading other declarations', () => {
        let active = '';
        let unrelatedReads = 0;
        const members = Array.from({ length: 11 }, (_, index) => {
            const id = `plugin${index}`;
            const source = sourceMember(id);
            const entry = new Proxy(source.projection!.unknownEntriesById[id]!, {
                get(target, key, receiver) {
                    if (active && id !== active && key === 'pluginId') unrelatedReads++;
                    return Reflect.get(target, key, receiver);
                },
            });
            return { ...source, projection: { ...source.projection!, unknownEntriesById: { [id]: entry } } };
        });
        const publication = createPluginUiProjectionUnionPublication();
        let previous = publication.publish(members);
        const selections = new Map<string, NonNullable<ReturnType<typeof readPluginUiProjectionEntryExecutionOrigin>>>();
        for (const [index, source] of members.entries()) {
            active = `plugin${index}`;
            const pluginId = `acme.${active}`;
            const origin = source.projection.installedPackagesById[pluginId]!.executionOrigin!;
            selections.set(pluginId, origin);
            const next = publication.publish(members, new Map(selections));
            expect(readPluginUiContributionOrigin(next.pluginUiProjection?.unknownEntriesById[active])?.executionOrigin).toEqual(origin);
            for (let other = 0; other < 11; other++) if (other !== index) {
                expect(next.pluginUiProjection?.unknownEntriesById[`plugin${other}`])
                    .toBe(previous.pluginUiProjection?.unknownEntriesById[`plugin${other}`]);
            }
            previous = next;
        }
        expect(unrelatedReads).toBe(0);
        active = 'all-agree';
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        try {
            for (const source of members) {
                const pluginId = Object.keys(source.projection.installedPackagesById)[0]!;
                const origin = source.projection.installedPackagesById[pluginId]!.executionOrigin!;
                const selectable = members.map(member => member === source ? { ...member, selectableExecutionOrigins: [origin] } : member);
                expect(publication.publish(selectable, new Map(selections))).toBe(previous);
            }
            expect(entries).not.toHaveBeenCalled();
            expect(values).not.toHaveBeenCalled();
        } finally { entries.mockRestore(); values.mockRestore(); }
        active = '';
        const conflicting = members.flatMap((source, index) => [source,
            sourceMember(`replica${index}`, `acme.plugin${index}`, `plugin${index}`)]);
        const pinned = publication.publish(conflicting, selections);
        const pinnedEntries = vi.spyOn(Object, 'entries');
        const pinnedValues = vi.spyOn(Object, 'values');
        try {
            for (let index = 0; index < 11; index++) {
                const reports = conflicting.map((member, memberIndex) => memberIndex === index * 2 + 1
                    ? { ...member, selectableExecutionOrigins: [member.projection!.installedPackagesById[`acme.plugin${index}`]!.executionOrigin!] }
                    : member);
                expect(publication.publish(reports, selections)).toBe(pinned);
            }
            expect(pinnedEntries).not.toHaveBeenCalled();
            expect(pinnedValues).not.toHaveBeenCalled();
        } finally { pinnedEntries.mockRestore(); pinnedValues.mockRestore(); }
    });

    it('ignores native-only selection feedback while real declaration origin changes remain current', () => {
        const source = sourceMember('first');
        const native = { serverIdentityId: 'srv_identity', sourceRef: {
            machineId: 'first', pluginId: 'acme.native', sourceCustody: { kind: 'development' as const, registeredRootId: 'native' },
        } };
        const member = { ...source, selectableExecutionOrigins: [native] };
        const publication = createPluginUiProjectionUnionPublication();
        const initial = publication.publish([member]);
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        try {
            for (let index = 0; index < 100; index++) {
                expect(publication.publish([{ ...member, selectableExecutionOrigins: index % 2 ? [native] : [] }],
                    index % 2 ? new Map([['acme.native', native]]) : new Map())).toBe(initial);
            }
            expect(entries).not.toHaveBeenCalled();
            expect(values).not.toHaveBeenCalled();
        } finally { entries.mockRestore(); values.mockRestore(); }
        const selected = source.projection!.installedPackagesById['acme.first']!.executionOrigin!;
        const changed = publication.publish([member], new Map([['acme.first', selected]]));
        expect(changed).not.toBe(initial);
        expect(readPluginUiContributionOrigin(changed.pluginUiProjection?.unknownEntriesById.first)?.executionOrigin).toEqual(selected);
    });

    it('does not rederive declarations for observedAt-only materialization reports while trust changes stay fresh', () => {
        const source = sourceMember('first');
        const materialization = PluginMachineMaterializationV1Schema.parse({
            serverIdentityId: 'srv_identity', machineId: 'first', materializationId: 'first',
            pluginId: 'acme.first', version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
            enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [],
        });
        const member = (report: typeof materialization) => ({ ...source, materializationsByPluginId: { 'acme.first': report } });
        const reports = Array.from({ length: 100 }, (_, index) => ({
            ...PluginMachineMaterializationV1Schema.parse({ ...materialization, observedAt: index + 2 }),
            // The immutable acquisition owner retains unchanged nested facts.
            uiArtifacts: materialization.uiArtifacts,
        }));
        const union = createPluginUiProjectionUnionPublication();
        const initial = union.publish([member(materialization)]);
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        const serialize = vi.spyOn(JSON, 'stringify');
        try {
            for (const report of reports) expect(union.publish([member(report)])).toBe(initial);
            expect(entries).not.toHaveBeenCalled();
            expect(values).not.toHaveBeenCalled();
            expect(serialize).not.toHaveBeenCalled();
        } finally { entries.mockRestore(); values.mockRestore(); serialize.mockRestore(); }
        const revoked = union.publish([member(PluginMachineMaterializationV1Schema.parse({ ...materialization, trustState: 'revoked' }))]);
        expect(readPluginUiContributionSupplies(revoked.pluginUiProjection?.unknownEntriesById.first)[0]?.interactionEnabled).toBe(false);
        expect(revoked).not.toBe(initial);
    });

    it('compares portable declarations without serializing them and preserves disagreement refusal', () => {
        const left = sourceMember('first', 'acme.shared', 'shared');
        const right = sourceMember('second', 'acme.shared', 'shared');
        const member = (source: PluginUiProjectionUnionMember, payload: unknown): PluginUiProjectionUnionMember => ({
            ...source,
            materializationsByPluginId: { 'acme.shared': {
                serverIdentityId: 'srv_identity', machineId: source.machineId, materializationId: source.machineId,
                pluginId: 'acme.shared', version: '1.0.0', sourceClass: 'versionedArchive', portableRelease: true,
                archiveDigestSha256: `sha256:${'a'.repeat(64)}`, uiArtifacts: [],
                enabled: true, trustState: 'trusted', observedAt: 1,
            } },
            selectableExecutionOrigins: [source.projection!.installedPackagesById['acme.shared']!.executionOrigin!],
            projection: { ...source.projection!, installedPackagesById: {
                'acme.shared': { ...source.projection!.installedPackagesById['acme.shared']!, displayName: 'Shared' },
            }, unknownEntriesById: { shared: { ...source.projection!.unknownEntriesById.shared, payload } } },
        });
        const publication = createPluginUiProjectionUnionPublication();
        const first = member(left, { title: 'Shared', nested: { count: 1, enabled: true } });
        const second = member(right, { nested: { enabled: true, count: 1 }, title: 'Shared' });
        const serialize = vi.spyOn(JSON, 'stringify');
        try {
            const agreed = publication.publish([first, second]);
            expect(agreed.pluginUiProjection?.unknownEntriesById.shared).toMatchObject({ hostCompatibility: 'compatible' });
            expect(serialize).not.toHaveBeenCalled();
            const changedSecond = member(right, { title: 'Changed', nested: { count: 1, enabled: true } });
            const changed = publication.publish([first, changedSecond]);
            expect(changed.pluginUiProjection?.unknownEntriesById.shared).toMatchObject({
                hostCompatibility: 'conflict', hostOrigin: null,
                executionOrigin: undefined, occurrenceId: undefined,
            });
            const convergedFirst = member(left, { nested: { enabled: true, count: 1 }, title: 'Changed' });
            const converged = publication.publish([
                { ...convergedFirst, projection: { ...convergedFirst.projection!, generation: 2 } },
                { ...changedSecond, projection: { ...changedSecond.projection!, generation: 2 } },
            ]);
            expect(converged.pluginUiProjection?.unknownEntriesById.shared).toMatchObject({ hostCompatibility: 'compatible' });
            expect(serialize).not.toHaveBeenCalled();
        } finally { serialize.mockRestore(); }
    });

    it('keeps native manifest and artifact correspondence fresh and bounded to current materializations', () => {
        const pluginId = 'acme.native';
        const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
            displayName: 'Native', runtime: { apiVersion: 1 }, contributes: {} });
        const slots = ['a', 'b'].map(artifactId => PluginMachineUiArtifactV1Schema.parse({ contributionId: 'content', artifactId,
            tier: 'hostedWeb', platform: 'web', artifactDigest: `sha256:${artifactId.repeat(64)}`, hostUiApiRange: '^1.0.0' }));
        const member = (machineId: string) => {
            const source = sourceMember(machineId, pluginId, 'shared');
            return { ...source, projection: { ...source.projection!, installedPackagesById: {
                [pluginId]: { ...source.projection!.installedPackagesById[pluginId]!, displayName: 'Native' },
            } }, selectableExecutionOrigins: [source.projection!.installedPackagesById[pluginId]!.executionOrigin!],
                materializationsByPluginId: { [pluginId]: PluginMachineMaterializationV1Schema.parse({
                    serverIdentityId: 'srv_identity', machineId, materializationId: machineId, pluginId, version: '1.0.0',
                    sourceClass: 'localPath', portableRelease: false, enabled: true, trustState: 'trusted', observedAt: 1,
                    declaredManifest: manifest, uiArtifacts: slots,
                }) } };
        };
        let left = member('left');
        let right = member('right');
        const retired = right.materializationsByPluginId[pluginId]!;
        const owner = createPluginUiProjectionUnionPublication();
        const compatibility = () => {
            const members = [left, right];
            const actual = owner.publish(members);
            expect(actual).toEqual(unionPluginUiProjections(members));
            return actual.pluginUiProjection?.unknownEntriesById.shared?.hostCompatibility;
        };
        expect(compatibility()).toBe('compatible');
        right = { ...right, materializationsByPluginId: { [pluginId]: { ...retired, uiArtifacts: [...retired.uiArtifacts].reverse() } } };
        expect(compatibility()).toBe('compatible');
        right = { ...right, materializationsByPluginId: { [pluginId]: PluginMachineMaterializationV1Schema.parse({
            ...retired, declaredManifest: { ...manifest, displayName: 'Changed native manifest' },
        }) } };
        expect(compatibility()).toBe('conflict');
        left = { ...left, materializationsByPluginId: { [pluginId]: PluginMachineMaterializationV1Schema.parse({
            ...left.materializationsByPluginId[pluginId], declaredManifest: { ...manifest, displayName: 'Changed native manifest' },
        }) } };
        expect(compatibility()).toBe('compatible');
        right = { ...right, materializationsByPluginId: { [pluginId]: PluginMachineMaterializationV1Schema.parse({
            ...right.materializationsByPluginId[pluginId], uiArtifacts: [{ ...slots[0]!, artifactDigest: `sha256:${'c'.repeat(64)}` }, slots[1]],
        }) } };
        expect(compatibility()).toBe('conflict');
        right = { ...right, materializationsByPluginId: { [pluginId]: { ...right.materializationsByPluginId[pluginId]!,
            uiArtifacts: [slots[0]!, slots[0]!],
        } } };
        expect(compatibility()).toBe('conflict'); // Equal length is not equal artifact multiplicity.
        right = { ...right, materializationsByPluginId: { [pluginId]: PluginMachineMaterializationV1Schema.parse({
            ...right.materializationsByPluginId[pluginId], uiArtifacts: slots,
        }) } };
        const current = right.materializationsByPluginId[pluginId]!;
        const set = vi.spyOn(Map.prototype, 'set');
        try {
            expect(compatibility()).toBe('compatible');
            const currentMaps = set.mock.calls.flatMap(([key], index) => {
                const context = set.mock.contexts[index];
                return key === current && context instanceof Map ? [context] : [];
            });
            expect(currentMaps.length).toBeGreaterThan(0);
            expect(currentMaps.every(map => !map.has(retired))).toBe(true);
        } finally { set.mockRestore(); }
        // Unowned one-shot inputs are normalized again, even if a caller
        // mutates a shallow-frozen carrier's nested manifest between reads.
        const mutableManifest = { ...manifest, displayName: 'Changed native manifest' };
        const raw = { ...right, materializationsByPluginId: { [pluginId]: Object.freeze({ ...current, declaredManifest: mutableManifest }) } };
        expect(unionPluginUiProjections([left, raw]).pluginUiProjection?.unknownEntriesById.shared?.hostCompatibility).toBe('compatible');
        mutableManifest.displayName = 'Mutated unowned native manifest';
        expect(unionPluginUiProjections([left, raw]).pluginUiProjection?.unknownEntriesById.shared?.hostCompatibility).toBe('conflict');
    });

    it('performs no scans, parsing or serialization over unchanged publications, sibling owners and snapshot reads', () => {
        const source = sourceMember('first');
        const publication = createPluginUiProjectionUnionPublication();
        const sibling = createPluginUiProjectionUnionPublication();
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        const members = [source];
        const ids = ['acme.first'];
        const initial = publication.publish(members);
        const other = sibling.publish([{ ...source, phase: 'retainedOffline', interactionEnabled: false }]);
        const facts = candidates.publish(initial.pluginUiProjection, members, ids);
        const iterateIds = vi.spyOn(ids, Symbol.iterator);
        try {
            for (let index = 0; index < 100; index++) expect(candidates.publish(initial.pluginUiProjection, members, ids)).toBe(facts);
            expect(iterateIds).not.toHaveBeenCalled();
        } finally { iterateIds.mockRestore(); }
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        const serialize = vi.spyOn(JSON, 'stringify');
        const parse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
        try {
            for (let index = 0; index < 100; index++) {
                expect(publication.getSnapshot()).toBe(initial);
                expect(publication.publish([source], new Map())).toBe(initial);
                expect(sibling.getSnapshot()).toBe(other);
                expect(candidates.getSnapshot()).toBe(facts);
                expect(candidates.publish(initial.pluginUiProjection, [source], ['acme.first'])).toBe(facts);
            }
            expect(entries).not.toHaveBeenCalled();
            expect(values).not.toHaveBeenCalled();
            expect(serialize).not.toHaveBeenCalled();
            expect(parse).not.toHaveBeenCalled();
        } finally { entries.mockRestore(); values.mockRestore(); serialize.mockRestore(); parse.mockRestore(); }
        expect(publication.publish([]).pluginUiProjection).toBeNull();
        expect(publication.publish([source]).pluginUiProjection?.unknownEntriesById.first).toBeDefined();
    });

    it('retains unaffected candidate slices and withdraws source facts on same-generation publication', () => {
        const members = [sourceMember('first'), sourceMember('second')];
        const union = createPluginUiProjectionUnionPublication();
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        const ids = ['acme.first', 'acme.second'];
        const initial = candidates.publish(union.publish(members).pluginUiProjection, members, ids);
        expect(initial.get('acme.second')?.sourceCandidates[0]?.validation.kind).toBe('admitted');
        const changed = [members[0]!, { ...members[1]!, phase: 'retainedOffline' as const,
            interactionEnabled: false, unavailableReasonCode: 'plugin_machine_unreachable' }];
        const next = candidates.publish(union.publish(changed).pluginUiProjection, changed, ids);
        expect(next.get('acme.first')).toBe(initial.get('acme.first'));
        expect(next.get('acme.second')?.sourceCandidates[0]?.validation).toEqual({ kind: 'rejected', reason: 'home_unreachable' });
        expect(next.get('acme.second')).toEqual(readPluginUiExecutionOriginCandidates({
            projection: union.getSnapshot().pluginUiProjection, members: changed, pluginId: 'acme.second',
        }));
        expect(candidates.publish(null, [], ['acme.second']).get('acme.second')?.sourceCandidates).toEqual([]);
        expect(candidates.publish(null, [], []).size).toBe(0);
    });

    it('preserves unrelated declaration rows and maps when one supplying Machine changes', () => {
        const members: readonly PluginUiProjectionUnionMember[] = ['first', 'second'].map((id) => ({
            machineId: id, serverId: 'server', phase: 'current', interactionEnabled: true,
            projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
                unknownEntriesById: { [id]: { pluginId: `acme.${id}`, contributionKind: 'unknown', occurrenceId: id } } },
        }));
        const publication = createPluginUiProjectionUnionPublication();
        const initial = publication.publish(members);
        const changed = publication.publish([members[0]!, { ...members[1]!, interactionEnabled: false, phase: 'retainedOffline' }]);
        expect(changed.pluginUiProjection?.unknownEntriesById.first).toBe(initial.pluginUiProjection?.unknownEntriesById.first);
        expect(changed.pluginUiProjection?.settingsPagesById).toBe(initial.pluginUiProjection?.settingsPagesById);
        expect(readPluginUiContributionSupplies(changed.pluginUiProjection?.unknownEntriesById.second)[0])
            .toMatchObject({ interactionEnabled: false, phase: 'retainedOffline' });
    });

    it('reconciles shared immutable supply facts once when another Machine changes currentness', () => {
        const first = sourceMember('first');
        const declaration = first.projection!.unknownEntriesById.first!;
        const source = { ...first, projection: preparePluginUiProjectionOrigins({ ...first.projection!,
            unknownEntriesById: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`first-${index}`, declaration])),
        }) };
        const second = sourceMember('second');
        const publication = createPluginUiProjectionUnionPublication();
        const initial = publication.publish([source, second]);
        const firstEntry = initial.pluginUiProjection!.unknownEntriesById['first-0'];
        const custody = readPluginUiContributionSupplies(firstEntry)[0]!.sourceCustody;
        expect(custody).toEqual({ kind: 'development', registeredRootId: 'first' });
        const keys = vi.spyOn(Object, 'keys');
        let changed: ReturnType<typeof publication.publish>;
        let custodyWalks: number;
        try {
            changed = publication.publish([source, { ...second, interactionEnabled: false, phase: 'retainedOffline' }]);
            custodyWalks = keys.mock.calls.filter(([value]) => value === custody).length;
        } finally { keys.mockRestore(); }
        expect(changed.pluginUiProjection!.unknownEntriesById['first-0']).toBe(firstEntry);
        expect(readPluginUiContributionSupplies(changed.pluginUiProjection!.unknownEntriesById.second)[0])
            .toMatchObject({ interactionEnabled: false, phase: 'retainedOffline' });
        // A shared immutable source is one graph node, not one deep walk per row.
        expect(custodyWalks).toBeLessThanOrEqual(1);
    });

    it('preserves authored property names and ordering while sharing unchanged payload fields', () => {
        const source = sourceMember('first');
        const publication = createPluginUiProjectionUnionPublication();
        // JSON.parse represents an authored own __proto__ data property, unlike
        // JavaScript's special object-literal prototype syntax.
        const first: unknown = JSON.parse('{"__proto__":{"label":"safe"},"stable":{"same":true},"title":"old"}');
        const next: unknown = JSON.parse('{"__proto__":{"label":"safe"},"stable":{"same":true},"title":"new"}');
        const publish = (payload: unknown) => publication.publish([{ ...source, projection: { ...source.projection!,
            unknownEntriesById: { first: { ...source.projection!.unknownEntriesById.first, payload } } } }]).pluginUiProjection!;
        const initial = publish(first).unknownEntriesById.first!.payload;
        const changed = publish(next).unknownEntriesById.first!.payload;
        expect(changed).toEqual(next);
        expect(Object.getOwnPropertyDescriptor(changed, '__proto__')?.value).toEqual({ label: 'safe' });
        if (!changed || typeof changed !== 'object' || !initial || typeof initial !== 'object') throw new Error('Expected published payloads');
        expect(Object.keys(changed)).toEqual(['__proto__', 'stable', 'title']);
        expect(Object.getOwnPropertyDescriptor(changed, 'stable')?.value).toBe(Object.getOwnPropertyDescriptor(initial, 'stable')?.value);
    });

    it('does not promote mutable arbitrary supply facts into the producer validation proof during sharing', () => {
        const first = sourceMember('first');
        const second = sourceMember('second', 'acme.first', 'first');
        const union = createPluginUiProjectionUnionPublication();
        const mounted = createInstalledPluginUiProjectionPublication();
        const initial = union.publish([first]).pluginUiProjection!;
        const mutableCustody = { kind: 'development' as const, registeredRootId: 'first' };
        const mutableSupply = { ...readPluginUiContributionSupplies(initial.unknownEntriesById.first)[0]!, sourceCustody: mutableCustody };
        mounted.publish([], { ...initial, unknownEntriesById: {
            first: { ...initial.unknownEntriesById.first, hostSupplies: [mutableSupply] },
        } });
        const next = mounted.publish([], union.publish([first, second]).pluginUiProjection)!;
        expect(readPluginUiContributionSupplies(next.unknownEntriesById.first)).toHaveLength(2);
        mutableCustody.registeredRootId = 'changed-after-publication';
        expect(readPluginUiContributionSupplies(next.unknownEntriesById.first)[0]?.sourceCustody)
            .toEqual({ kind: 'development', registeredRootId: 'first' });
    });

    it('reads published direct and contribution origins without reparsing while raw frozen inputs still validate', () => {
        const source = sourceMember('first');
        const selected = source.projection!.installedPackagesById['acme.first']!.executionOrigin!;
        const selections = new Map([['acme.first', selected]]);
        const publication = createPluginUiProjectionUnionPublication();
        const entry = publication.publish([source], selections).pluginUiProjection!.unknownEntriesById.first;
        const direct = readPluginUiProjectionEntryExecutionOrigin(entry);
        const contribution = readPluginUiContributionOrigin(entry);
        expect(direct).toEqual(selected);
        expect(contribution).toMatchObject({ phase: 'current', interactionEnabled: true, executionOrigin: selected });
        const parse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
        try {
            const directReads = Array.from({ length: 100 }, () => readPluginUiProjectionEntryExecutionOrigin(entry));
            const contributionReads = Array.from({ length: 100 }, () => readPluginUiContributionOrigin(entry));
            expect(parse.mock.calls.length).toBe(0);
            expect(directReads.every(value => value === direct)).toBe(true);
            expect(contributionReads.every(value => value === contribution)).toBe(true);
        } finally { parse.mockRestore(); }
        const withdrawn = publication.publish([{ ...source, phase: 'retainedOffline', interactionEnabled: false }], selections)
            .pluginUiProjection!.unknownEntriesById.first;
        expect(readPluginUiContributionOrigin(withdrawn)).toMatchObject({ phase: 'retainedOffline', interactionEnabled: false });
        const withdrawnParse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
        try {
            for (let index = 0; index < 100; index++) {
                readPluginUiContributionOrigin(withdrawn);
                readPluginUiProjectionEntryExecutionOrigin(withdrawn);
            }
            expect(withdrawnParse).not.toHaveBeenCalled();
        } finally { withdrawnParse.mockRestore(); }
        const custody = { kind: 'development', registeredRootId: 'raw' };
        const raw = { serverIdentityId: 'srv_identity', sourceRef: { machineId: 'first', pluginId: 'acme.first', sourceCustody: custody } };
        const arbitrary = Object.freeze({ pluginId: 'acme.first', executionOrigin: raw,
            hostOrigin: Object.freeze({ machineId: 'first', serverId: 'server', phase: 'current', interactionEnabled: true, executionOrigin: raw }) });
        expect(readPluginUiProjectionEntryExecutionOrigin(arbitrary)).not.toBeNull();
        expect(readPluginUiContributionOrigin(arbitrary)?.executionOrigin).not.toBeNull();
        custody.kind = 'invalid';
        expect(readPluginUiProjectionEntryExecutionOrigin(arbitrary)).toBeNull();
        expect(readPluginUiContributionOrigin(arbitrary)?.executionOrigin).toBeNull();
    });

    it('prepares immutable producer origins without changing input fields, ordering or raw-input validation', () => {
        const executionOrigin = { sourceRef: { sourceCustody: { registeredRootId: 'first', kind: 'development' },
            pluginId: 'acme.first', machineId: 'first' }, serverIdentityId: 'srv_identity' };
        const hostOrigin = { machineId: 'first', serverId: 'server', phase: 'current', interactionEnabled: true, executionOrigin };
        const hostAccountOrigin = { custodyId: 'account-custody', serverId: 'server', sourceCustody: {
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`, version: '1.0.0', pluginId: 'acme.first', kind: 'account_release',
        }, accountId: 'account' };
        const entry = { pluginId: 'acme.first', executionOrigin, hostOrigin, hostAccountOrigin };
        const model = { ...EMPTY_PLUGIN_UI_PROJECTION, unknownEntriesById: { entry } };
        const prepared = preparePluginUiProjectionOrigins(model);
        expect(JSON.stringify(prepared)).toBe(JSON.stringify(model));
        expect(preparePluginUiProjectionOrigins(prepared)).toBe(prepared);
        const accountCarrier = prepared.unknownEntriesById.entry!.hostAccountOrigin;
        expect(Object.keys(accountCarrier!)).toEqual(Object.keys(hostAccountOrigin));
        const accountOrigin = readPluginUiAccountExecutableOrigin(prepared.unknownEntriesById.entry);
        expect(accountOrigin?.sourceCustody).toMatchObject({ version: '1.0.0' });
        expect(readPluginUiAccountExecutableOrigin({ ...prepared.unknownEntriesById.entry, pluginId: 'other.plugin' })).toBeNull();
        if (!accountCarrier || typeof accountCarrier !== 'object' || !('sourceCustody' in accountCarrier)
            || !accountCarrier.sourceCustody || typeof accountCarrier.sourceCustody !== 'object') throw new Error('Expected owned Account origin');
        expect(Reflect.set(accountCarrier.sourceCustody, 'version', 'changed-through-carrier')).toBe(false);
        const carrier = prepared.unknownEntriesById.entry!.executionOrigin;
        if (!carrier || typeof carrier !== 'object' || !('sourceRef' in carrier)
            || !carrier.sourceRef || typeof carrier.sourceRef !== 'object') throw new Error('Expected owned source origin');
        expect(Reflect.set(carrier.sourceRef, 'machineId', 'changed-through-carrier')).toBe(false);
        const parse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
        try {
            for (let index = 0; index < 100; index++) {
                expect(readPluginUiProjectionEntryExecutionOrigin(prepared.unknownEntriesById.entry)).not.toBeNull();
                expect(readPluginUiContributionOrigin(prepared.unknownEntriesById.entry)?.phase).toBe('current');
                expect(readPluginUiAccountExecutableOrigin(prepared.unknownEntriesById.entry)).toBe(accountOrigin);
            }
            expect(parse).not.toHaveBeenCalled();
        } finally { parse.mockRestore(); }
        executionOrigin.sourceRef.sourceCustody.registeredRootId = 'changed';
        hostOrigin.phase = 'retainedOffline';
        hostOrigin.interactionEnabled = false;
        hostAccountOrigin.sourceCustody.version = '2.0.0';
        const next = preparePluginUiProjectionOrigins(model);
        expect(readPluginUiContributionOrigin(next.unknownEntriesById.entry)).toMatchObject({ phase: 'retainedOffline', interactionEnabled: false });
        expect(readPluginUiContributionOrigin(prepared.unknownEntriesById.entry)?.phase).toBe('current');
        expect(readPluginUiAccountExecutableOrigin(next.unknownEntriesById.entry)?.sourceCustody).toMatchObject({ version: '2.0.0' });
        expect(accountOrigin?.sourceCustody).toMatchObject({ version: '1.0.0' });
        executionOrigin.sourceRef.pluginId = 'other.plugin';
        expect(readPluginUiProjectionEntryExecutionOrigin(entry)).toBeNull();
        expect(readPluginUiProjectionEntryExecutionOrigin(preparePluginUiProjectionOrigins(model).unknownEntriesById.entry)).toBeNull();
    });

    it('retains unchanged facts across union publications and invalidates source withdrawal', () => {
        const pluginId = 'example.identity';
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'identity-source' };
        const origin = { serverIdentityId: 'srv_identity', sourceRef: { pluginId, machineId: 'machine', sourceCustody } };
        const source: PluginUiProjectionUnionMember = {
            machineId: 'machine', serverId: 'srv_identity', serverIdentityId: 'srv_identity', phase: 'current', interactionEnabled: true,
            projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1, installedPackagesById: {
                [pluginId]: { id: pluginId, displayName: 'Identity', version: '1.0.0', enabled: true,
                    source: { kind: 'localPath', locator: '/identity' }, occurrenceId: 'occurrence', sourceCustody, executionOrigin: origin },
            } },
        };
        const read = (member: PluginUiProjectionUnionMember, previous?: ReturnType<typeof readPluginUiExecutionOriginCandidates>) =>
            readPluginUiExecutionOriginCandidates({ pluginId, members: [member],
                projection: unionPluginUiProjections([member]).pluginUiProjection, previous });
        const initial = read(source);
        expect(initial.sourceCandidates[0]?.validation).toEqual({ kind: 'admitted' });
        const repeated = read({ ...source }, initial);
        expect(repeated).toBe(initial);
        const withdrawn = read({ ...source, phase: 'retainedOffline', interactionEnabled: false }, initial);
        expect(withdrawn).not.toBe(initial);
        expect(withdrawn.sourceCandidates[0]?.validation).toEqual({ kind: 'rejected', reason: 'stale' });
        expect(read(source, withdrawn).sourceCandidates[0]?.validation).toEqual({ kind: 'admitted' });
        const successor = { ...source, projection: { ...source.projection!, installedPackagesById: {
            [pluginId]: { ...source.projection!.installedPackagesById[pluginId]!, occurrenceId: 'successor-occurrence' },
        } } };
        expect(read(successor, initial).sourceCandidates[0]?.source.occurrenceId).toBe('successor-occurrence');
    });
});

function sourceMember(id: string, pluginId = `acme.${id}`, localId = id): PluginUiProjectionUnionMember {
    const sourceCustody = { kind: 'development' as const, registeredRootId: id };
    const executionOrigin = { serverIdentityId: 'srv_identity', sourceRef: { machineId: id, pluginId, sourceCustody } };
    return { machineId: id, serverId: 'server', serverIdentityId: 'srv_identity', phase: 'current', interactionEnabled: true,
        projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: id, version: '1.0.0', enabled: true,
                source: { kind: 'localPath', locator: `/${id}` }, occurrenceId: id, sourceCustody, executionOrigin } },
            unknownEntriesById: { [localId]: { pluginId, contributionKind: 'unknown', occurrenceId: id, executionOrigin } } },
    };
}

function accountDeclarationModel() {
    const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'acme.account', version: '1.0.0',
        displayName: 'Account', runtime: { apiVersion: 1 }, contributes: { ui: {
            renderers: [{ id: 'page', kind: 'declarative', root: { kind: 'text', text: 'Account page' } }],
            views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, title: 'Account page', renderer: 'page' }],
        } } });
    return normalizePluginInstalledUiDeclarations(projectPluginPortableUiDeclarationsV1(manifest), 'web', {
        id: manifest.id, displayName: 'Account', version: manifest.version, enabled: true,
        source: { kind: 'bundled', locator: '@happier-dev/account-fixture' },
    });
}
