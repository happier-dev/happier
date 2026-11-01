import { describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema, buildDeferredDaemonProjectionSections, DAEMON_PROJECTION_SECTION_FRAME_BYTES } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { countTransportRequests } from '@/dev/testkit/performance/counts';
import { readDeferredProjection } from './machineProjectionSections';

describe('deferred Machine projection demand', () => {
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
