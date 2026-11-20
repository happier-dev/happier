import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** Hetzner Cloud REST boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, managedId, decode } = world;
    const foreignId = '99';
    return {
        foreignId, launch: { serverTypeId: 'cx23', imageId: 'ubuntu-24.04', locationId: 'fsn1', publicNetworking: { ipv4: true, ipv6: false } },
        facts: {
            // Vendor JSON/cloud-init are the real external serialization boundary.
            allocationUserData: (calls: readonly HttpRequest[]) => calls.filter(call => call.method === 'POST' && new URL(call.url).pathname === '/v1/servers')
                .map(call => JSON.parse(String(JSON.parse(decode.decode(call.body)).user_data).replace(/^#cloud-config\n/u, ''))),
            // The image catalog carries two images whose descriptions are blank text.
            blankImageDescriptions: 2,
        },
        http(_request, { path, method, isForeign, targetPresent }) {
            const server = () => ({ id: isForeign ? Number(foreignId) : 41, status: s.power === 'running' ? 'running' : 'off', labels: { 'happier-managed': isForeign ? 'foreign-managed-id' : managedId }, volumes: [7], public_net: { ipv4: { id: 9, ip: '203.0.113.8' }, ipv6: null } });
            if (method === 'GET' && ['/v1/server_types', '/v1/images', '/v1/locations', '/v1/pricing'].includes(path)) {
                const pair = { net: '0.02', gross: '0.02' };
                return { value: { server_types: [{ id: 114, name: 'cx23', cores: 2, memory: 4, disk: 40, architecture: 'x86', locations: [{ name: 'fsn1', available: true, deprecation: null }], prices: [{ location: 'fsn1', price_hourly: pair, price_monthly: pair }] }],
                    images: [{ id: 1, name: 'ubuntu-24.04', description: '', architecture: 'x86', type: 'system', status: 'available', deprecated: null, os_flavor: 'ubuntu' }, { id: 2, name: 'ubuntu-22.04', description: '   ', architecture: 'x86', type: 'system', status: 'available', deprecated: null, os_flavor: 'ubuntu' }],
                    locations: [{ id: 1, name: 'fsn1', description: 'Falkenstein', country: null }], pricing: { currency: 'USD' }, meta: { pagination: { next_page: null } } } };
            }
            if (path === '/v1/servers' && method === 'POST') { s.allocations++; s.present = true; s.owned.add('/v1/primary_ips/9'); return { value: { server: server() }, status: 201 }; }
            if (path.includes('/actions/')) { if (method === 'POST') s.power = path.endsWith('/shutdown') ? 'stopped' : 'running'; return { value: { action: { id: 10, status: 'success', command: s.power === 'running' ? 'poweron' : 'shutdown', resources: [{ id: 41, type: 'server' }] } } }; }
            if (method === 'DELETE') {
                if (path.startsWith('/v1/servers/')) world.remove(path.split('/').at(-1), '41', () => { s.present = false; });
                else { if (!s.owned.has(path)) throw new Error(`Unexpected Hetzner owned-resource deletion: ${path}`); s.owned.delete(path); }
                return { value: { action: { id: 10, status: 'success' } } };
            }
            if (path === '/v1/servers/41' || path === `/v1/servers/${foreignId}`) return { value: targetPresent ? { server: server() } : { error: { code: 'not_found' } }, status: targetPresent ? 200 : 404 };
            const owned = s.owned.has(path);
            return { status: owned ? 200 : 404, value: owned ? { id: 7 } : { error: { code: 'not_found' } } };
        },
    };
};
