import { writeFileSync } from 'node:fs';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** E2B OpenAPI 0.1.0 + envd 0.1.3 / process.proto, 2026-11-01. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, guest, object, decode, managedId, privateBinding } = world;
    const foreignId = 'e2b-foreign';
    return {
        foreignId, launch: { templateId: 'base', timeoutSeconds: 300 },
        account: { headers: { 'x-api-key': privateBinding } },
        // The sandbox read always carries its native end time.
        facts: { nativeExpiry: 'always' },
        http(request, { url, path, method, isForeign, targetPresent }) {
            const sandbox = () => ({ sandboxID: isForeign ? foreignId : 'e2b-owned', templateID: 'base', clientID: 'team-fixture', envdVersion: '0.5.3',
                envdAccessToken: privateBinding, domain: 'e2b.app', startedAt: '2026-11-01T00:00:00Z', endAt: new Date(world.nativeExpiry).toISOString(),
                cpuCount: 2, memoryMB: 512, diskSizeMB: 1024, state: s.power === 'running' ? 'running' : 'paused',
                metadata: { 'happier-managed-id': managedId }, lifecycle: { autoResume: false, onTimeout: 'pause' } });
            if (url.hostname !== 'api.e2b.app') {
                if (path === '/files') { writeFileSync(url.searchParams.get('path')!, request.body!); return { value: [{ name: 'file', type: 'file', path: url.searchParams.get('path') }] }; }
                if (path === '/process.Process/Start') {
                    const envelope = request.body!;
                    const start = object(JSON.parse(decode.decode(envelope.subarray(5))));
                    const config = object(start.process);
                    const completed = guest([String(config.cmd), ...(config.args as string[] ?? [])]);
                    const frame = (payload: unknown, flag = 0) => {
                        const bytes = Buffer.from(JSON.stringify(payload)); const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(bytes.length, 1); return Buffer.concat([header, bytes]);
                    };
                    return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/connect+json' }, body: Buffer.concat([
                        frame({ event: { start: { pid: 42 } } }), frame({ event: { data: { stdout: Buffer.from(completed.stdout).toString('base64') } } }),
                        frame({ event: { data: { stderr: Buffer.from(completed.stderr).toString('base64') } } }),
                        frame({ event: { end: { exited: true, exitCode: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1 } } }), frame({}, 2),
                    ]) };
                }
                throw new Error(`Unexpected E2B guest HTTP ${method} ${path}`);
            }
            if (path === '/v2/sandboxes' && method === 'POST') { s.allocations++; s.present = true; s.owned.add('sandbox'); return { value: sandbox(), status: 201 }; }
            if (path === '/v2/sandboxes') return { value: [...(s.present ? [sandbox()] : []), ...(s.foreignPresent ? [{ ...sandbox(), sandboxID: foreignId, metadata: { 'happier-managed-id': 'foreign-managed-id' } }] : [])] };
            if (path.endsWith('/pause')) { s.power = 'suspended'; return { status: 204 }; }
            if (path.endsWith('/connect')) { s.power = 'running'; return { value: sandbox(), status: 201 }; }
            if (method === 'DELETE') { world.remove(path.split('/').at(-1), 'e2b-owned', () => { s.present = false; s.owned.delete('sandbox'); }); return { status: 204 }; }
            return { value: sandbox(), status: targetPresent ? 200 : 404 };
        },
    };
};
