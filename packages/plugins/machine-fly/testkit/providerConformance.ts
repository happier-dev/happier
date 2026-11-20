import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Fly Machines REST + GraphQL boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, body, decode, text, name, privateBinding } = world;
    const foreignId = 'machine-foreign';
    let flyConfig: unknown = {};
    // Retain OS evidence for failed file writes without retaining private stdin.
    const execOutcomes: { command: string[]; stdinBytes: number; status: number | null; stderr: string }[] = [];
    const redact = (value: string) => value.replaceAll(privateBinding, '[redacted]');
    const guest = (argv: string[], stdin?: Uint8Array): PluginProcessResult => {
        const completed = world.guest(argv, stdin);
        execOutcomes.push({ command: argv.map(redact), stdinBytes: stdin?.byteLength ?? 0,
            status: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : null, stderr: redact(decode.decode(completed.stderr)) });
        return completed;
    };
    return {
        foreignId,
        launch: { app: { name, ownership: 'created', organizationSlug: 'test-org' }, region: 'ord', imageReference: 'ubuntu:24.04', guest: { cpuKind: 'shared', cpus: 1, memoryMb: 512 }, volume: { kind: 'create', sizeGb: 1 } },
        account: { environment: { FLY_ORGANIZATION: 'test-org' } },
        diagnostics: () => ({ execOutcomes }),
        http(request, { url, path, method, isForeign, targetPresent }) {
            if (url.hostname === 'api.fly.io' && String(body(request).query).includes('certificates')) return { value: { data: { app: { name, certificates: { totalCount: 0 }, ipAddresses: { totalCount: 0 }, egressIpAddresses: { totalCount: 0 }, addOns: { totalCount: 0 }, secrets: [], services: [], allocations: [], hasDeploymentSource: false } } } };
            if (url.hostname === 'api.fly.io') return { value: { data: { platform: { regions: [{ code: 'ord', name: 'Chicago', deprecated: false, requiresPaidPlan: false }],
                vmSizes: [{ name: 'shared-cpu-1x', cpuCores: 1, memoryMb: 256, maxMemoryMb: 2048, memoryIncrementsMb: [256], priceMonth: 2, priceSecond: 0.001 }] } } } };
            if (path === '/v1/apps' && method === 'GET') return { value: { total_apps: 0, apps: [] } };
            if (path === '/v1/apps' && method === 'POST') { s.owned.add('app'); return { value: { id: 'app-owned', name } }; }
            if (path.endsWith('/volumes') && method === 'GET') return { value: [] };
            if (path.endsWith('/volumes') && method === 'POST') { s.owned.add('volume'); return { value: { id: 'vol-owned', state: 'created', region: 'ord', attached_machine_id: null } }; }
            if (path.endsWith('/machines') && method === 'POST') { s.allocations++; s.present = true; flyConfig = body(request).config; return { value: { id: 'machine-owned', state: 'started', region: 'ord', config: flyConfig } }; }
            if (path.endsWith('/exec')) {
                const b = body(request); const completed = guest(b.command as string[], b.stdin === undefined ? undefined : text.encode(String(b.stdin)));
                return { value: { exit_code: completed.termination.observed.kind === 'exit' ? completed.termination.observed.exitCode : 1, stdout: decode.decode(completed.stdout), stderr: decode.decode(completed.stderr) } };
            }
            if (path.endsWith('/stop') || path.endsWith('/start')) { s.power = path.endsWith('/stop') ? 'stopped' : 'running'; return { value: {} }; }
            if (method === 'DELETE') {
                if (path.includes('/machines/')) world.remove(path.split('/').at(-1), 'machine-owned', () => { s.present = false; });
                else if (path.includes('/volumes/')) { if (!path.endsWith('/volumes/vol-owned')) throw new Error(`Unexpected Fly volume deletion: ${path}`); s.owned.delete('volume'); }
                else { if (!path.endsWith(`/apps/${name}`)) throw new Error(`Unexpected Fly app deletion: ${path}`); s.owned.delete('app'); }
                return { value: {} };
            }
            if (path.endsWith('/machines/machine-owned') || path.endsWith(`/machines/${foreignId}`)) return { status: targetPresent ? 200 : 404, value: { id: isForeign ? foreignId : 'machine-owned', state: s.power === 'running' ? 'started' : 'stopped', region: 'ord', config: flyConfig } };
            if (path.endsWith('/volumes/vol-owned')) return { status: s.owned.has('volume') ? 200 : 404, value: { id: 'vol-owned', state: 'created', region: 'ord', attached_machine_id: s.present ? 'machine-owned' : null } };
            if (path.endsWith('/machines')) return { value: [] };
            return { status: s.owned.has('app') ? 200 : 404, value: { id: 'app-owned', name } };
        },
    };
};
