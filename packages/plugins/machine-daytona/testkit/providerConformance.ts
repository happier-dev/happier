import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Daytona REST + toolbox proxy boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, guest, body, decode, name, managedId } = world;
    const foreignId = 'sandbox-foreign';
    return {
        foreignId, launch: { snapshot: 'daytona-small' },
        facts: { nativeExpiry: 'with-evidence' },
        http(request, { url, path, method, isForeign, targetPresent }) {
            const native = () => ({ id: isForeign ? foreignId : 'sandbox-owned', name: isForeign ? 'foreign' : name, organizationId: 'org-one',
                state: s.power === 'running' ? 'started' : 'stopped', toolboxProxyUrl: 'https://proxy.app.daytona.io/toolbox',
                labels: { 'happier-managed-id': managedId }, autoStopInterval: 0, autoPauseInterval: 0, autoDeleteInterval: -1,
                ...(s.evidence ? { autoDestroyAt: new Date(world.nativeExpiry).toISOString() } : {}) });
            if (path === '/api/api-keys/current') return { value: { name: 'Conformance', organizationId: 'org-one', permissions: ['write:sandboxes', 'delete:sandboxes'] } };
            if (path === '/api/sandbox' && method === 'POST') { s.allocations++; s.present = true; s.owned.add('sandbox'); return { value: native() }; }
            if (path.endsWith('/process/execute')) {
                const output = guest(['sh', '-c', String(body(request).command)]);
                return { value: { exitCode: output.termination.observed.kind === 'exit' ? output.termination.observed.exitCode : 1,
                    result: decode.decode(output.stdout) + decode.decode(output.stderr) } };
            }
            if (path.endsWith('/files/upload-v2')) {
                const target = url.searchParams.get('path');
                if (!target) throw new Error('Missing Daytona file path');
                mkdirSync(join(target, '..'), { recursive: true });
                writeFileSync(target, request.body ?? new Uint8Array());
                return { value: { path: target } };
            }
            if (path.endsWith('/stop') || path.endsWith('/start')) { s.power = path.endsWith('/stop') ? 'stopped' : 'running'; return { value: native() }; }
            if (method === 'DELETE') { world.remove(path.split('/').at(-1), 'sandbox-owned', () => { s.present = false; s.owned.delete('sandbox'); }); return { value: { ...native(), id: path.split('/').at(-1), state: 'destroyed' } }; }
            return { status: targetPresent ? 200 : 404, value: targetPresent ? native() : { message: 'Sandbox not found' } };
        },
    };
};
