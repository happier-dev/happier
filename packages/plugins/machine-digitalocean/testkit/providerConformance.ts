import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';

/** DigitalOcean REST v2 boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const { state: s, managedId, name, body, decode } = world;
    const foreignId = '43';
    return {
        foreignId, launch: { regionSlug: 'nyc3', sizeSlug: 's-1vcpu-1gb', imageId: 1, publicNetworking: { ipv6: false } },
        facts: {
            // Vendor JSON/cloud-init are the real external serialization boundary.
            allocationUserData: (calls: readonly HttpRequest[]) => calls.filter(call => call.method === 'POST' && new URL(call.url).pathname === '/v2/droplets')
                .map(call => JSON.parse(String(JSON.parse(decode.decode(call.body)).user_data).replace(/^#cloud-config\n/u, ''))),
            // The image catalog carries two images whose descriptions are blank text.
            blankImageDescriptions: 2,
        },
        http(request, { path, method, isForeign, targetPresent }) {
            const droplet = () => ({ id: isForeign ? Number(foreignId) : 42, name: isForeign ? 'foreign' : name, status: s.power === 'running' ? 'active' : 'off', volume_ids: ['owned'], tags: [isForeign ? 'foreign-managed-id' : managedId], networks: { v4: [{ type: 'public', ip_address: '203.0.113.8' }], v6: [] } });
            if (method === 'GET' && ['/v2/sizes', '/v2/images', '/v2/regions'].includes(path)) return { value: {
                sizes: [{ slug: 's-1vcpu-1gb', memory: 1024, vcpus: 1, disk: 25, transfer: 1, price_hourly: 0.02, regions: ['nyc3'], available: true }],
                regions: [{ slug: 'nyc3', name: 'New York 3', available: true, sizes: ['s-1vcpu-1gb'] }], images: [{ id: 1, name: 'Ubuntu', description: '', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }, { id: 2, name: 'Ubuntu second', description: '   ', distribution: 'Ubuntu', regions: ['nyc3'], status: 'available', type: 'base' }], links: {} } };
            if (path === '/v2/droplets' && method === 'POST') { s.allocations++; s.present = true; return { value: { droplet: droplet() }, status: 202 }; }
            if (path.endsWith('/actions') && method === 'POST') { s.power = body(request).type === 'shutdown' ? 'stopped' : 'running'; return { value: { action: { type: body(request).type, id: 10, status: 'completed', resource_id: 42, resource_type: 'droplet' } }, status: 201 }; }
            if (path === '/v2/actions/10') return { value: { action: { type: s.power === 'running' ? 'power_on' : 'shutdown', id: 10, status: 'completed', resource_id: 42, resource_type: 'droplet' } } };
            if (path.endsWith('/actions')) return { value: { actions: [] } };
            if (method === 'DELETE') {
                if (path.startsWith('/v2/droplets/')) world.remove(path.split('/').at(-1), '42', () => { s.present = false; });
                else { if (!s.owned.has(path)) throw new Error(`Unexpected DigitalOcean owned-resource deletion: ${path}`); s.owned.delete(path); }
                return { status: 204 };
            }
            if (path === '/v2/droplets/42' || path === `/v2/droplets/${foreignId}`) return { status: targetPresent ? 200 : 404, value: { droplet: droplet() } };
            return { status: s.owned.has(path) ? 200 : 404, value: { volume: { id: 'owned', droplet_ids: [] } } };
        },
    };
};
