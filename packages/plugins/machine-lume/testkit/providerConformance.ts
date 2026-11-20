import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Lume local HTTP service + CLI boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, result, body, name } = world;
    const foreignId = 'happier-foreign';
    return {
        foreignId,
        launch: { storage: 'external_disk', cpu: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 20 * 1024 ** 3, image: { kind: 'native-image', reference: 'registry.example/team/linux:prepared', privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'owner' } } },
        // The Lume VM listing proves exact absence of a deleted VM.
        facts: { provesAbsenceAfterDelete: true },
        process(_request, args) {
            if (args[0] === 'delete') world.remove(args.at(-1), name, () => { s.present = false; s.owned.delete('vm'); });
            return result(''); // native public-key installation over Lume SSH
        },
        http(request, { url, path, method, isForeign, targetPresent }) {
            const native = () => ({ name: isForeign ? foreignId : name, locationName: 'external_disk', status: s.power, os: 'linux', cpuCount: 2,
                memorySize: 4 * 1024 ** 3, diskSize: { allocated: 1024 ** 3, total: 20 * 1024 ** 3 }, ipAddress: '203.0.113.8', sshAvailable: true });
            if (url.hostname === 'ghcr.io' && path === '/token') return { value: { token: 'public-fixture-token' } };
            if (url.hostname === 'ghcr.io' && path.endsWith('/tags/list')) return { value: { name: path.slice('/v2/'.length, -'/tags/list'.length), tags: [] } };
            if (path.endsWith('/host/status')) return { value: { version: '0.6.1' } };
            if (path.endsWith('/config/locations')) return { value: [{ name: 'external_disk' }] };
            if (path.endsWith('/config')) return { value: { cachingEnabled: true } };
            if (path === '/lume/vms') return { value: [...(s.present ? [native()] : []), ...(s.foreignPresent ? [{ ...native(), name: foreignId }] : [])] };
            if (path.endsWith('/pull')) { s.allocations++; s.present = true; s.power = 'stopped'; s.owned.add('vm'); return { value: { name, image: body(request).image } }; }
            if (path.endsWith('/run')) { s.power = 'running'; return { value: {}, status: 202 }; }
            if (path.endsWith('/stop')) { s.power = 'stopped'; return { value: {} }; }
            if (method === 'DELETE') { world.remove(path.split('/').at(-1), name, () => { s.present = false; s.owned.delete('vm'); }); return { value: {} }; }
            if (method === 'PATCH') return { value: {} };
            return { status: targetPresent ? 200 : 400, value: targetPresent ? native() : { message: `Virtual machine not found: ${isForeign ? foreignId : name}` } };
        },
    };
};
