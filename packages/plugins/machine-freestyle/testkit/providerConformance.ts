import { writeFileSync } from 'node:fs';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Freestyle v5 REST / OpenAPI info 0.1.0, observed 2026-11-01. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, guest, body, decode, name, managedId } = world;
    const foreignId = 'vm-foreign';
    return {
        foreignId, launch: { snapshotId: 'freestyle/ubuntu' },
        facts: { nativeExpiry: 'with-evidence' },
        http(request, { url, path, method, isForeign, targetPresent }) {
            const native = () => ({ id: isForeign ? foreignId : 'vm-owned', slug: isForeign ? 'foreign' : name, state: s.power === 'running' ? 'running' : 'paused',
                resources: { cpu: 4, memory: 8192, storage: 32768 }, metadata: { 'happier-managed-id': managedId },
                createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
                autoDeleteSeconds: null, ttlSeconds: s.evidence ? (world.nativeExpiry - Date.parse('2026-11-01T00:00:00Z')) / 1000 : null });
            if (path === '/v5/vms' && method === 'GET') return { value: { vms: [], totalCount: 0, runningCount: 0, startingCount: 0, pausedCount: 0, stoppedCount: 0 } };
            if (path === '/v5/vms' && method === 'POST') { s.allocations++; s.present = true; s.owned.add('vm'); return { value: native(), status: 201 }; }
            if (path.endsWith('/exec-await')) {
                const b = body(request), output = guest(['sh', '-c', String(b.command)], typeof b.stdin === 'string' ? Buffer.from(b.stdin, 'base64') : undefined);
                return { value: { statusCode: output.termination.observed.kind === 'exit' ? output.termination.observed.exitCode : null,
                    stdout: decode.decode(output.stdout), stderr: decode.decode(output.stderr) } };
            }
            if (path.endsWith('/fs/write')) {
                const target = url.searchParams.get('path');
                if (!target) throw new Error('Missing Freestyle file path');
                writeFileSync(target, request.body!, { mode: Number(url.searchParams.get('mode') ?? 0o600) }); return { status: 204 };
            }
            if (path.endsWith('/pause') || path.endsWith('/start')) { s.power = path.endsWith('/pause') ? 'suspended' : 'running'; return { value: native() }; }
            if (method === 'DELETE') { world.remove(path.split('/').at(-1), 'vm-owned', () => { s.present = false; s.owned.delete('vm'); }); return { status: 204 }; }
            return targetPresent ? { value: native() } : { status: 404, value: { error: { code: 'NOT_FOUND' } } };
        },
    };
};
