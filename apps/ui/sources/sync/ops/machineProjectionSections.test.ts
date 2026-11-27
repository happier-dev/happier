import { describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema, buildDeferredDaemonProjectionSections, DAEMON_PROJECTION_SECTION_FRAME_BYTES, DaemonProjectionSectionBodyResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { countTransportRequests } from '@/dev/testkit/performance/counts';
import { InvalidDaemonProjectionSection, packSectionReadIncludeDigests, readDeferredProjection } from './machineProjectionSections';

// Count probes at the hashing engines; both keep their real behaviour.
const hashing = vi.hoisted(() => ({ noble: 0, platform: 0, scramble: false }));
vi.mock('@noble/hashes/sha2', async importOriginal => {
    const actual = await importOriginal<typeof import('@noble/hashes/sha2')>();
    const sha256 = Object.assign((message: Uint8Array) => { hashing.noble += 1; return actual.sha256(message); }, actual.sha256);
    return { ...actual, sha256 };
});
vi.mock('@/platform/digest', async importOriginal => {
    const actual = await importOriginal<typeof import('@/platform/digest')>();
    return { ...actual, digest: async (algorithm: 'SHA-256' | 'SHA-512', data: Uint8Array) => {
        const call = ++hashing.platform;
        const out = await actual.digest(algorithm, data);
        // Later calls settle first, so a digest bound by completion order would mismatch.
        if (hashing.scramble) await new Promise(resolve => setTimeout(resolve, Math.max(0, 40 - call * 2)));
        return out;
    } };
});

// Frames the fixture needs at the 48 KiB bound; naming fewer peers must not add frames.
// 31 since each index part names its plugin (P03-PLUGIN-UI-SUMMARY): one more index page.
const READS_FOR_COLD_CATALOGUE = 31;

describe('deferred Machine projection demand', () => {
    it('reuses declaration bytes across Machines while reattaching each Machine binding', async () => {
        const pluginIds = Array.from({ length: 132 }, (_, index) => `qa.roster-${index}`);
        const roster = Array.from({ length: 16 }, (_, machine) => {
            const occurrenceId = (plugin: string) => `${plugin}:${machine}`;
            return {
                protocolVersion: 1 as const, projectionDigest: (machine + 1).toString(16).padStart(64, '0'),
                projection: PluginProjectionV2Schema.parse({
                    v: 2, generation: machine + 1,
                    installedPackagesById: Object.fromEntries(pluginIds.map(id => [id, {
                        id, displayName: id, enabled: true, occurrenceId: occurrenceId(id),
                        source: { kind: 'local', locator: `/machines/${machine}/plugins/${id}` },
                    }])),
                    actionsById: Object.fromEntries(pluginIds.flatMap(pluginId => Array.from({ length: 4 }, (_, index) => {
                        const id = `action-${index}`;
                        return [`${pluginId}/${id}`, { id, pluginId, occurrenceId: occurrenceId(pluginId),
                            title: id, description: ('Static declaration: ' + pluginId + ' ').repeat(80),
                            scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                            execution: { target: 'daemon' }, dangerLevel: 'safe', available: Boolean((machine + index) % 3) }];
                    }))),
                }),
            };
        });
        const measure = async (bindingOverlay: boolean) => {
            const shared = { bodies: new Map<string, readonly string[]>(), pendingReads: new Map() };
            const replies = new Set<string>();
            const indexes = new Set<string>();
            let replyCount = 0;
            let bytes = 0;
            const count = (value: unknown) => {
                const text = JSON.stringify(value);
                replies.add(text);
                replyCount++;
                bytes += Buffer.byteLength(text);
            };
            const hydrate = async (response: (typeof roster)[number]) => {
                const snapshot = buildDeferredDaemonProjectionSections(response, { bindingOverlay });
                count(snapshot.manifest);
                for (const [section, digest] of Object.entries(snapshot.manifest.sections)) {
                    if (section !== 'base') indexes.add(digest);
                }
                const hydrated = await readDeferredProjection({ manifest: snapshot.manifest, held: new Map(), shared,
                    sections: ['actionsById'], read: async (digest, offset, peers) => {
                        const page = snapshot.read(digest, offset, peers);
                        count(page);
                        return page;
                    } });
                expect(hydrated.projection).toEqual(response.projection);
            };
            for (const response of roster) await hydrate(response);
            const cold = { replyCount, uniqueReplies: replies.size, bytes, declarationIndexes: indexes.size };
            await hydrate(roster[0]!);
            return { ...cold, reopenSectionReplies: replyCount - cold.replyCount - 1 };
        };
        const before = await measure(false);
        const after = await measure(true);
        console.info('MACHINE_PROJECTION_ROSTER_COST', JSON.stringify({ machines: roster.length, pluginsPerMachine: pluginIds.length, before, after }));
        expect(after.declarationIndexes).toBeLessThan(before.declarationIndexes);
        expect(after.replyCount).toBeLessThan(before.replyCount);
        expect(after.bytes).toBeLessThan(before.bytes);
        expect(after.reopenSectionReplies).toBe(0);
    }, 45_000);

    it('reads only two provider Actions from 77 plugins and 616 Actions for scoped Search', async () => {
        const { PLUGIN_SEARCH_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
        const plugins = Array.from({ length: 77 }, (_, index) => `qa.paged-${index}`);
        const response = {
            protocolVersion: 1 as const, projectionDigest: '7'.repeat(64),
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
                installedPackagesById: Object.fromEntries(plugins.map(id => [id, { id, displayName: id,
                    enabled: true, source: { kind: 'local', locator: `/plugins/${id}` } }])),
                actionsById: Object.fromEntries(plugins.flatMap(pluginId => Array.from({ length: 8 }, (_, index) => {
                    const id = `action-${index}`;
                    return [`${pluginId}/${id}`, { id, pluginId, occurrenceId: `${pluginId}:7`, title: id,
                        description: 'Action documentation '.repeat(512), scopes: ['global'], surfaces: ['ui'],
                        placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true }];
                }))),
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(plugins.flatMap((pluginId, index) => [
                    [`irrelevant:${pluginId}`, { id: `irrelevant:${pluginId}`, pluginId, occurrenceId: `${pluginId}:7`, contributionKind: 'translations',
                        locales: ['en'], bundles: { en: { unused: 'unrelated UI declaration '.repeat(512) } } }],
                    ...(index < 2 ? [[`searchProvider:${pluginId}:search`, { id: `searchProvider:${pluginId}:search`,
                        pluginId, occurrenceId: `${pluginId}:7`, contributionKind: 'searchProvider', descriptorId: 'search',
                        identity: { pluginId, localId: 'search' }, action: { pluginId, localId: 'action-0' } }]] : []),
                ])) } },
            }),
        };
        const snapshot = buildDeferredDaemonProjectionSections(response);
        let pages = 0;
        let bytes = 0;
        const result = await readDeferredProjection({ manifest: snapshot.manifest, sections: PLUGIN_SEARCH_SECTIONS,
            held: new Map(), read: async (digest, offset, peers) => {
                const reply = snapshot.read(digest, offset, peers);
                pages += 1; bytes += new TextEncoder().encode(JSON.stringify(reply)).length;
                return reply;
            } });
        console.info('SCOPED_SEARCH_COST', JSON.stringify({ plugins: 77, actions: 616, providers: 2, pages, bytes,
            selectedActions: Object.keys(result.projection.actionsById).length }));
        expect.soft(Object.keys(result.projection.actionsById).sort()).toEqual(plugins.slice(0, 2).map(id => `${id}/action-0`));
        expect.soft(Object.keys(result.projection.familiesById.pluginUi!.entriesById)).toHaveLength(2);
        // One index frame, one frame for package admissions and at most one
        // per provider body at the existing 48 KiB bound; packing reduces this.
        expect.soft(pages).toBeLessThanOrEqual(4);
        expect(bytes).toBeLessThanOrEqual(4 * DAEMON_PROJECTION_SECTION_FRAME_BYTES);
    });

    it('reads only the Session plugins\' bodies for a Session demand of 77 plugins and 616 Actions', async () => {
        const { SESSION_MESSAGE_ACTION_PROJECTION_SECTIONS } = await import('@/sync/domains/plugins/ui/projectionSections');
        const plugins = Array.from({ length: 77 }, (_, index) => `qa.paged-${index}`);
        const response = {
            protocolVersion: 1 as const, projectionDigest: '7'.repeat(64),
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
                installedPackagesById: Object.fromEntries(plugins.map(id => [id, { id, displayName: id,
                    enabled: true, source: { kind: 'local', locator: `/plugins/${id}` } }])),
                actionsById: Object.fromEntries(plugins.flatMap((pluginId, plugin) => Array.from({ length: 8 }, (_, index) => {
                    const id = `action-${index}`;
                    // Two plugins present a Session/Message Action; the rest are palette Actions.
                    const scopes = plugin === 3 && index === 0 ? ['session'] : plugin === 9 && index === 0 ? ['message'] : ['global'];
                    return [`${pluginId}/${id}`, { id, pluginId, occurrenceId: `${pluginId}:7`, title: id,
                        description: 'Action documentation '.repeat(512), scopes, surfaces: ['ui'],
                        placementBindings: scopes[0] === 'message' ? ['message.menu'] : [], execution: { target: 'daemon' },
                        dangerLevel: 'safe', available: true }];
                }))),
            }),
        };
        const snapshot = buildDeferredDaemonProjectionSections(response);
        const cost = async (sections: readonly string[]) => {
            let pages = 0;
            let bytes = 0;
            const result = await readDeferredProjection({ manifest: snapshot.manifest, sections, held: new Map(),
                read: async (digest, offset, peers) => {
                    const reply = snapshot.read(digest, offset, peers);
                    pages += 1; bytes += new TextEncoder().encode(JSON.stringify(reply)).length;
                    return reply;
                } });
            return { pages, bytes, actions: Object.keys(result.projection.actionsById).length, loaded: result.deferredProjection.loadedSections };
        };
        const whole = await cost(['actionsById', 'familiesById.pluginUi', 'resourcesById']);
        const session = await cost(SESSION_MESSAGE_ACTION_PROJECTION_SECTIONS);
        console.info('SESSION_SLICE_COST', JSON.stringify({ whole: { ...whole, loaded: undefined }, session: { ...session, loaded: undefined } }));
        expect(snapshot.manifest.sessionPluginIds).toEqual(['qa.paged-3', 'qa.paged-9']);
        // The Session holds both plugins' 16 Actions, read in a bounded number of frames.
        expect(session.actions).toBe(16);
        expect(session.loaded).toContain('actionsById#qa.paged-3');
        expect(session.loaded).not.toContain('actionsById');
        expect(whole.actions).toBe(616);
        // Package and Action index frames, then two pages per selected ~85 KB plugin body at 48 KiB.
        expect(session.pages).toBeLessThanOrEqual(6);
        expect(session.pages * 10).toBeLessThan(whole.pages);
    });

    it.each([false, true])('keeps full inventories when Search and full UI sections share one demand (Search first: %s)', async searchFirst => {
        const provider = { id: 'searchProvider:qa.search:search', pluginId: 'qa.search', occurrenceId: 'qa.search:7',
            contributionKind: 'searchProvider', descriptorId: 'search', identity: { pluginId: 'qa.search', localId: 'search' },
            action: { pluginId: 'qa.search', localId: 'query' } };
        const snapshot = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: '7'.repeat(64),
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
                actionsById: Object.fromEntries(['query', 'unrelated'].map(id => [`qa.search/${id}`, {
                    id, pluginId: 'qa.search', occurrenceId: 'qa.search:7', title: id, scopes: ['global'], surfaces: ['ui'],
                    placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true }])),
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: { search: provider,
                    unrelated: { id: 'unrelated', pluginId: 'qa.search', occurrenceId: 'qa.search:7', contributionKind: 'translations' } } } },
            }),
        });
        const full = ['actionsById', 'familiesById.pluginUi'];
        const result = await readDeferredProjection({ manifest: snapshot.manifest,
            sections: searchFirst ? ['searchProviders', ...full] : [...full, 'searchProviders'], held: new Map(),
            read: async (digest, offset, peers) => snapshot.read(digest, offset, peers),
        });
        expect(Object.keys(result.projection.actionsById)).toHaveLength(2);
        expect(Object.keys(result.projection.familiesById.pluginUi!.entriesById)).toHaveLength(2);
    });

    it.each([false, true])('packs omitted peer bodies into later frames instead of reading each package separately (multi-page carrier: %s)', async multiPageCarrier => {
        // The loaded C controller published 77 packages. Each body fits beside
        // several peers, but their combined content exceeds one carrier frame.
        const packageCount = 77;
        const snapshot = (generation: number, enabled: boolean) => buildDeferredDaemonProjectionSections({
            protocolVersion: 1, projectionDigest: String(generation).repeat(64),
            projection: PluginProjectionV2Schema.parse({ v: 2, generation,
                installedPackagesById: Object.fromEntries(Array.from({ length: packageCount }, (_, index) => {
                    const id = `acme.plugin-${index}`;
                    return [id, { id, displayName: id, enabled: index === 0 ? enabled : true,
                        source: { kind: 'local', locator: `/plugins/${id}/${'x'.repeat(multiPageCarrier && index === 0
                            ? DAEMON_PROJECTION_SECTION_FRAME_BYTES * 2 : Math.floor(DAEMON_PROJECTION_SECTION_FRAME_BYTES / 8))}` } }];
                })),
            }),
        });
        let current = snapshot(7, true);
        const carrier = countTransportRequests(async (digest: string, offset: number, includeDigests: readonly string[]) =>
            current.read(digest, offset, includeDigests), (digest, offset) => `${digest}:${offset}`);
        const read = (held: ReadonlyMap<string, readonly string[]>) => readDeferredProjection({
            manifest: current.manifest,
            sections: ['familiesById.pluginUi', 'familiesById.machineProvisioners', 'familiesById.connectedAccounts', 'actionsById', 'resourcesById'],
            held, read: carrier.request,
        });
        const first = await read(new Map());
        expect(Object.keys(first.projection.installedPackagesById)).toHaveLength(packageCount);
        expect(first.projection.installedPackagesById['acme.plugin-0']?.enabled).toBe(true);
        console.info('FIVE_SECTION_HYDRATION_COST', JSON.stringify({ packageCount, multiPageCarrier,
            sectionReads: Object.keys(carrier.read()).length }));
        // This fixture needs one packed index plus eleven packed body frames.
        // The oversized first carrier adds two continuation frames, not one
        // singleton request for each of its 76 packable peers.
        expect(Object.keys(carrier.read())).toHaveLength(multiPageCarrier ? 14 : 12);
        current = snapshot(8, false);
        const changed = await read(first.sectionBodies);
        expect(changed.projection.installedPackagesById['acme.plugin-0']?.enabled).toBe(false);
    });

    it('starts independent omitted bodies after the first carrier page, sharing duplicate demand without a serial tail', async () => {
        const packageCount = 8;
        const snapshot = buildDeferredDaemonProjectionSections({
            protocolVersion: 1, projectionDigest: '7'.repeat(64),
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
                installedPackagesById: Object.fromEntries(Array.from({ length: packageCount }, (_, index) => {
                    const id = `acme.plugin-${index}`;
                    return [id, { id, displayName: id, enabled: true,
                        // Two pages per body, derived from the real carrier frame.
                        source: { kind: 'local', locator: `/plugins/${id}/${'x'.repeat(DAEMON_PROJECTION_SECTION_FRAME_BYTES)}` },
                    }];
                })),
            }),
        });
        const delay = 25;
        let active = 0;
        let peak = 0;
        const carrier = countTransportRequests(async (digest: string, offset: number, includeDigests: readonly string[]) => {
            active += 1;
            peak = Math.max(peak, active);
            try {
                await new Promise(resolve => setTimeout(resolve, delay));
                return snapshot.read(digest, offset, includeDigests);
            } finally { active -= 1; }
        }, (digest, offset) => `${digest}:${offset}`);
        const shared = { bodies: new Map<string, readonly string[]>(), pendingReads: new Map<string, Promise<readonly string[] | undefined>>() };
        vi.useFakeTimers();
        try {
            const startedAt = Date.now();
            const params = { manifest: snapshot.manifest, sections: ['installedPackagesById', 'installedPackagesById'],
                held: new Map<string, readonly string[]>(), shared, read: carrier.request };
            const first = readDeferredProjection(params);
            const duplicate = readDeferredProjection(params);
            // Index discovery takes one round. The first body page discloses
            // which peers fit; omitted bodies must not wait for its last page.
            await vi.advanceTimersByTimeAsync(delay * 2);
            expect(peak).toBe(packageCount);
            await vi.runAllTimersAsync();
            const [answer, same] = await Promise.all([first, duplicate]);
            expect(Object.keys(answer.projection.installedPackagesById)).toHaveLength(packageCount);
            expect(same.projection).toEqual(answer.projection);
            expect(Object.values(carrier.read()).every(count => count === 1)).toBe(true);
            // One packed index frame + two pages per independent package.
            expect(Object.keys(carrier.read())).toHaveLength(1 + packageCount * 2);
            expect(Date.now()).toBe(startedAt + delay * 4);
        } finally { vi.useRealTimers(); }
    });

    it('names only the peers a frame can carry, so a cold catalogue does not resend its digest list per frame', async () => {
        // Live (P03-FIX-OPEN-SEND, Muse bed): a cold Session open hydrated 1,490 bodies in ~60 serial
        // body frames, and every request named every unread digest (1,477 → 110): 3.0 MB upstream in
        // 66 KB requests for frames that each carried ~20 bodies.
        const pluginCount = 600;
        const snapshot = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: '7'.repeat(64),
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
                actionsById: Object.fromEntries(Array.from({ length: pluginCount }, (_, index) => {
                    const pluginId = `qa.cold-${index}`;
                    return [`${pluginId}/run`, { id: 'run', pluginId, occurrenceId: `${pluginId}:7`, title: 'Run',
                        description: `Action documentation ${index} `.repeat(70), scopes: ['global'], surfaces: ['ui'],
                        placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true }];
                })),
            }),
        });
        let reads = 0;
        let namedPeers = 0;
        const result = await readDeferredProjection({ manifest: snapshot.manifest, sections: ['actionsById'], held: new Map(),
            read: async (digest, offset, peers) => {
                reads += 1; namedPeers += peers.length;
                return snapshot.read(digest, offset, peers);
            } });
        expect(Object.keys(result.projection.actionsById)).toHaveLength(pluginCount);
        const bodies = result.sectionBodies.size;
        console.info('COLD_CATALOGUE_PEER_NAMES', JSON.stringify({ bodies, reads, namedPeers }));
        // Each body is named about once: beside the carrier that brings it, plus at most one
        // over-estimated peer per frame that the Machine declines and a later frame carries.
        expect({ reads, overNamed: namedPeers > bodies + reads }).toEqual({ reads: READS_FOR_COLD_CATALOGUE, overNamed: false });
    });

    it('gathers selected indexes before reading their bodies and carries a real package change', async () => {
        const snapshot = (generation: number, enabled: boolean) => buildDeferredDaemonProjectionSections({
            protocolVersion: 1, projectionDigest: String(generation).repeat(64),
            projection: PluginProjectionV2Schema.parse({ v: 2, generation,
                installedPackagesById: { 'acme.archive': { id: 'acme.archive', displayName: 'Archive', enabled,
                    source: { kind: 'local', locator: '/plugins/archive' } } },
                settingsById: {}, familiesById: {},
            }),
        });
        let current = snapshot(7, true);
        const reads: string[][] = [];
        const read = (held: ReadonlyMap<string, readonly string[]>) => readDeferredProjection({
            manifest: current.manifest, sections: ['agentsById', 'installedPackagesById'], held,
            read: async (digest, offset, includeDigests) => {
                reads.push([digest, ...includeDigests]);
                return current.read(digest, offset, includeDigests);
            },
        });
        const first = await read(new Map());
        expect(first.projection.installedPackagesById['acme.archive']?.enabled).toBe(true);
        // The manifest names indexes; only their admitted contents name bodies.
        // This fixture needs one index request and one body request.
        expect(reads).toHaveLength(2);
        expect(reads.flat()).not.toContain(current.manifest.sections.settingsById);
        current = snapshot(8, false);
        reads.length = 0;
        const changed = await read(first.sectionBodies);
        expect(changed.projection.installedPackagesById['acme.archive']?.enabled).toBe(false);
        expect(reads).toHaveLength(2);
        expect(reads.flat()).not.toContain(current.manifest.sections.settingsById);
    });
});

describe('section digest verification', () => {
    const snapshot = (packages: number) => buildDeferredDaemonProjectionSections({
        protocolVersion: 1, projectionDigest: '7'.repeat(64),
        projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
            installedPackagesById: Object.fromEntries(Array.from({ length: packages }, (_, index) => {
                const id = `acme.plugin-${index}`;
                return [id, { id, displayName: `${id} ${'é😀'.repeat(index * 50)}`, enabled: true,
                    source: { kind: 'local', locator: `/plugins/${id}` } }];
            })),
            agentsById: {},
        }),
    });

    it('hashes on the platform digest only and binds each body to its own digest when digests settle out of order', async () => {
        const built = snapshot(12);
        const before = { ...hashing };
        hashing.scramble = true;
        try {
            const result = await readDeferredProjection({ manifest: built.manifest,
                sections: ['agentsById', 'installedPackagesById'], held: new Map(),
                read: async (digest, offset, peers) => built.read(digest, offset, peers) });
            expect(Object.keys(result.projection.installedPackagesById)).toHaveLength(12);
            expect(result.projection.installedPackagesById['acme.plugin-11']?.displayName).toContain('é😀');
            expect(hashing.noble - before.noble).toBe(0);
            expect(hashing.platform - before.platform).toBe(result.sectionBodies.size);
        } finally { hashing.scramble = false; }
    });

    it.each(['carrier', 'included'] as const)('still fails closed on a tampered %s body', async target => {
        const built = snapshot(3);
        const rejection = readDeferredProjection({ manifest: built.manifest, sections: ['installedPackagesById'], held: new Map(),
            read: async (digest, offset, peers) => {
                // Read as the consumer does: through the canonical reply schema (bodies are optional).
                const page = DaemonProjectionSectionBodyResponseSchema.parse(built.read(digest, offset, peers));
                if (target === 'included' && page.bodies?.length) {
                    return { ...page, bodies: page.bodies.map((extra, index) => index === 0 ? { ...extra, body: [...extra.body.slice(0, -1), `${extra.body.at(-1)} `] } : extra) };
                }
                if (target === 'carrier' && digest !== built.manifest.sections.installedPackagesById && offset === 0) {
                    return { ...page, chunk: page.chunk.replace('acme.plugin', 'acme.plugin-tampered') };
                }
                return page;
            } });
        await expect(rejection).rejects.toBeInstanceOf(InvalidDaemonProjectionSection);
        await expect(rejection).rejects.toMatchObject({ reason: target === 'included' ? 'included-section' : 'section-digest' });
    });
});

describe('section-read peer packing', () => {
    it('sizes the request once and admits each peer by its own bytes, exactly at the frame budget', () => {
        const base = { method: 'describe', sectionRead: { digest: 'a'.repeat(64), offset: 0 } };
        const bytesOf = (peers: readonly string[]) => new TextEncoder().encode(JSON.stringify({
            ...base, sectionRead: { ...base.sectionRead, includeDigests: peers } })).length;
        const candidates = Array.from({ length: 800 }, (_, index) => index.toString(16).padStart(64, '0'));
        const budget = bytesOf(candidates.slice(0, 700));
        let sized = 0;
        const included = packSectionReadIncludeDigests(peers => { sized += 1; return bytesOf(peers); }, candidates, budget);
        // The longest prefix whose complete request fits: one byte less drops the last peer.
        expect(included).toEqual(candidates.slice(0, 700));
        expect(packSectionReadIncludeDigests(bytesOf, candidates, budget - 1)).toEqual(candidates.slice(0, 699));
        expect(packSectionReadIncludeDigests(bytesOf, candidates, bytesOf([]))).toEqual([]);
        expect(sized).toBe(1);
    });

    it('admits a frame of peers without serializing or encoding any of them', () => {
        // A Machines open hydrates many Machines; every omitted-peer read offers up to a frame of
        // peers again, so per-peer sizing multiplied into seconds of main-thread work (2.9 s live).
        // Section digests are fixed-width lowercase hex (the request schema rejects anything else),
        // so the fit is arithmetic on the request's own size, measured once.
        const base = { method: 'describe', sectionRead: { digest: 'a'.repeat(64), offset: 0 } };
        const bytesOf = (peers: readonly string[]) => new TextEncoder().encode(JSON.stringify({
            ...base, sectionRead: { ...base.sectionRead, includeDigests: peers } })).length;
        const candidates = Array.from({ length: 800 }, (_, index) => index.toString(16).padStart(64, '0'));
        const baseBytes = bytesOf([]);
        const budget = bytesOf(candidates.slice(0, 700));
        const stringify = vi.spyOn(JSON, 'stringify');
        const encode = vi.spyOn(TextEncoder.prototype, 'encode');
        try {
            const included = packSectionReadIncludeDigests(() => baseBytes, candidates, budget);
            expect(included).toEqual(candidates.slice(0, 700));
            expect(stringify.mock.calls.length + encode.mock.calls.length).toBe(0);
        } finally { stringify.mockRestore(); encode.mockRestore(); }
        // Exact at each boundary for the protocol's digests, including no room at all.
        for (let fit = 0; fit <= 3; fit += 1) {
            expect(packSectionReadIncludeDigests(bytesOf, candidates, bytesOf(candidates.slice(0, fit)))).toEqual(candidates.slice(0, fit));
            expect(packSectionReadIncludeDigests(bytesOf, candidates, bytesOf(candidates.slice(0, fit + 1)) - 1)).toEqual(candidates.slice(0, fit));
        }
        expect(packSectionReadIncludeDigests(bytesOf, candidates, baseBytes - 1)).toEqual([]);
    });
});
