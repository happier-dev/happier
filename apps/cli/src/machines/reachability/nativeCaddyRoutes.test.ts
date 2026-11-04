import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { materializeCaddyDomainRouteV1, type CaddyDomainRouteInput } from '@/deployments/targets/ownServer/caddyRouteMaterialization';
import { caddyPublicHttpServerId, materializeCaddyInitialConfigV1 } from '@/deployments/targets/ownServer/caddyRouteMaterialization';
import { nativeCaddyDomainRouteIdsV1, DeploymentDomainNetworkExposureV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createNativeCaddyRoutes, verifyNativeCaddyRemoval, type NativeCaddyAdminExchange,
    type NativeCaddyRoutePlacement } from './nativeCaddyRoutes';
import { createNativeCaddyStartFirstRoutes } from './nativeCaddyStartFirst';
import type { NativeComposeRoutingGeneration } from '@/daemon/local/services/launch/nativeComposeStartFirst';

const route: CaddyDomainRouteInput = {
    domainId: 'domain-a', domain: { hostname: 'app.example.test',
        target: { service: 'web', containerPort: 3000 }, healthCheck: { path: '/healthz', expectStatus: 200 } },
    listener: 'privateOrigin', upstreams: { kind: 'replicas', containerNames: ['app-web-1', 'app-web-2'] },
    privateSourceRanges: ['100.98.0.0/24'], peerOrigins: ['100.98.0.3:8080'],
};
const placement: NativeCaddyRoutePlacement = {
    serverId: 'home', accountId: 'owner', environmentId: 'environment', targetLinkId: 'link', domainId: 'domain-a',
    machineId: 'machine-a', installationId: 'installation-a', actionOperationId: 'operation', requestId: 'request',
    nativeServer: 'happier_private',
};

/** Caddy HTTP is the system boundary. Domain codec, owner, signing and lifecycle stay real. */
function caddyBoundary() {
    const foreign = { '@id': 'foreign-route', match: [{ host: ['foreign.example.test'] }],
        handle: [{ handler: 'static_response', status_code: 200 }] };
    const server = { routes: [foreign] as unknown[], errors: { routes: [] as unknown[] }, tls_connection_policies: [] as unknown[] };
    const http = { routes: [] as unknown[] };
    const tls = { certificates: { load_pem: [] as unknown[] }, automation: { policies: [] as unknown[] } };
    const writes: string[] = [];
    const reads: string[] = [];
    let version = 1, loseNextWrite = false, refuseNextWrite = false, unavailableNextWrite = false;
    const base = '/config/apps/http/servers/happier_private';
    const findSlot = (value: unknown, wanted: string): { parent: unknown[] | Record<string, unknown>; key: string | number } | undefined => {
        if (value === null || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (child !== null && typeof child === 'object' && '@id' in child && child['@id'] === wanted) {
                return { parent: value as unknown[] | Record<string, unknown>, key: Array.isArray(value) ? Number(key) : key };
            }
            const nested = findSlot(child, wanted);
            if (nested) return nested;
        }
        return undefined;
    };
    const exchange: NativeCaddyAdminExchange = async request => {
        request.signal?.throwIfAborted();
        const lists = [server.routes, server.errors.routes, server.tls_connection_policies, http.routes, tls.certificates.load_pem, tls.automation.policies];
        const ownedId = request.path.startsWith('/id/') ? decodeURIComponent(request.path.slice(4)) : undefined;
        const ownedList = ownedId ? lists.find(items => items.some(item => item !== null && typeof item === 'object' && '@id' in item && item['@id'] === ownedId)) : undefined;
        const root = request.path.startsWith('/config/apps/tls') || ownedList === tls.certificates.load_pem || ownedList === tls.automation.policies ? tls
            : request.path.startsWith(`${base}_http`) || ownedList === http.routes ? http : server;
        const etag = JSON.stringify(root);
        if (request.method === 'GET') { reads.push(request.path); return { status: 200, value: structuredClone(root), etag }; }
        writes.push(`${request.method} ${request.path}`);
        if (unavailableNextWrite) { unavailableNextWrite = false; return { status: 503 }; }
        if (refuseNextWrite || request.etag !== etag) { refuseNextWrite = false; return { status: 412 }; }
        const collection = request.path.includes('/errors/routes') ? server.errors.routes
            : request.path.includes('/tls_connection_policies') ? server.tls_connection_policies
                : request.path.includes('/certificates/load_pem') ? tls.certificates.load_pem
                    : request.path.includes('/automation/policies') ? tls.automation.policies
                        : root === http ? http.routes : server.routes;
        if (request.method === 'PUT') collection.unshift(structuredClone(request.value));
        else if (request.path.startsWith('/id/')) {
            const id = decodeURIComponent(request.path.slice('/id/'.length));
            const slot = findSlot(root, id);
            if (!slot) return { status: 404 };
            if (request.method === 'DELETE' && Array.isArray(slot.parent) && typeof slot.key === 'number') slot.parent.splice(slot.key, 1);
            else if (Array.isArray(slot.parent) && typeof slot.key === 'number') slot.parent[slot.key] = structuredClone(request.value);
            else if (!Array.isArray(slot.parent) && typeof slot.key === 'string') slot.parent[slot.key] = structuredClone(request.value);
            else throw new Error('Unexpected Caddy object slot');
        } else throw new Error('Unexpected native write path');
        version++;
        if (loseNextWrite) { loseNextWrite = false; throw new Error('Native reply lost after effect'); }
        return { status: 200 };
    };
    const keys = tweetnacl.sign.keyPair();
    const owner = createNativeCaddyRoutes({ machineId: placement.machineId, installationId: placement.installationId,
        privateKey: keys.secretKey, exchange });
    return { owner, keys, server, foreign, writes, reads,
        loseNextWrite: () => { loseNextWrite = true; }, refuseNextWrite: () => { refuseNextWrite = true; },
        unavailableNextWrite: () => { unavailableNextWrite = true; } };
}

describe('native Caddy Domain placement owner', () => {
    it('projects only installed listener and local/fallback facts through a finite read', async () => {
        const native = caddyBoundary();
        const observed = { status: 'ready' as const, containerId: 'private-container', containerName: 'happier-caddy',
            adminSocketPath: '/private/admin.sock', networkNames: ['private-network'],
            servers: [{ serverId: placement.nativeServer, listen: ['[fd00::2]:8080'], tls: false, automaticHttpsDisabled: true,
                endpoints: [{ hostAddress: '100.98.0.2', hostPort: 8080, containerPort: 8080 },
                    { hostAddress: '127.0.0.1', hostPort: 8081, containerPort: 8080 },
                    { hostAddress: 'fd00::2', hostPort: 8082, containerPort: 8080 }] }],
            containerOrigins: [{ serverId: placement.nativeServer, networkName: 'private-network', service: 'http://happier-caddy:8080' }],
            privateOrigins: [{ serverId: placement.nativeServer, endpoint: '100.98.0.2:8080', network: {
                provider: { kind: 'builtin' as const, id: 'tailscale' }, networkIdentity: 'tailnet-a', displayName: null,
                dnsName: null, addresses: ['100.98.0.2'], interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'],
                magicDnsEnabled: null, state: 'ready' as const } }] };
        const activated = await native.owner.activate({ placement, route, captureExposure: observed });
        expect(activated).toMatchObject({ kind: 'active', networkExposure: { kind: 'ready', localOrigin: true, fallback: true } });
        expect(DeploymentDomainNetworkExposureV1Schema.parse('networkExposure' in activated ? activated.networkExposure : undefined))
            .toMatchObject({ kind: 'ready', listener: 'privateOrigin' });
        const before = native.writes.length;
        const readsBefore = native.reads.length;
        const request = { placement, route: { domainId: route.domainId, domain: route.domain, listener: route.listener }, caddy: observed };
        const result = await native.owner.readExposure(request);
        expect(result).toEqual({ kind: 'ready', listener: 'privateOrigin',
            listeners: [{ tls: false, automaticHttpsDisabled: true,
                endpoints: [{ audience: 'privateNetwork', hostPort: 8080, containerPort: 8080, protocol: 'tcp' },
                    { audience: 'loopback', hostPort: 8081, containerPort: 8080, protocol: 'tcp' },
                    { audience: 'other', hostPort: 8082, containerPort: 8080, protocol: 'tcp' }] }],
            localOrigin: true, fallback: true });
        expect(activated).toMatchObject({ kind: 'active', networkExposure: result });
        for (const projection of [result, activated]) expect(JSON.stringify(projection))
            .not.toMatch(/private-container|admin\.sock|private-network|happier-caddy|100\.98\.0\.2|127\.0\.0\.1|fd00::2|hostAddress|"listen"/);
        expect(native.writes).toHaveLength(before);
        expect(native.reads.slice(readsBefore)).toEqual(['/config/apps/http/servers/happier_private']);
        native.server.routes = [native.foreign];
        native.server.errors.routes = [];
        expect(await native.owner.readExposure(request)).toEqual({ kind: 'unavailable', reason: 'route_absent' });
        const missingBefore = native.reads.length;
        expect(await native.owner.readExposure({ ...request, caddy: { status: 'needs_setup' } }))
            .toEqual({ kind: 'unavailable', reason: 'required_fact_unavailable' });
        expect(native.reads).toHaveLength(missingBefore);
        const edge = caddyBoundary();
        const edgeRoute: CaddyDomainRouteInput = { ...route,
            upstreams: { kind: 'privateOrigins', endpoints: ['100.98.0.3:8080'] }, peerOrigins: [] };
        expect(await edge.owner.activate({ placement, route: edgeRoute })).toEqual({ kind: 'active' });
        expect(await edge.owner.readExposure(request)).toMatchObject({ kind: 'ready', localOrigin: false, fallback: false });
    });

    it('removes captured intent without live topology, refuses changed fixed intent, and resumes partial or complete absence', async () => {
        const native = caddyBoundary();
        expect((await native.owner.activate({ placement, route })).kind).toBe('active');
        const captured = { domainId: route.domainId, domain: route.domain, listener: route.listener };
        const changedGeneration: CaddyDomainRouteInput = { ...route,
            upstreams: { kind: 'replicas', containerNames: ['candidate-web-1', 'candidate-web-2', 'candidate-web-3'] },
            peerOrigins: ['100.98.0.9:8080'] };
        expect((await native.owner.activate({ placement, route: changedGeneration, expected: materializeCaddyDomainRouteV1(route) })).kind).toBe('active');
        const beforeObserve = native.writes.length;
        expect(await native.owner.observe({ placement, route: captured })).toEqual({ kind: 'active' });
        expect(await native.owner.observe({ placement, route })).toEqual({ kind: 'conflict', reason: 'route_conflict' });
        expect(native.writes).toHaveLength(beforeObserve);
        for (const domain of [{ ...captured.domain, hostname: 'other.example.test' },
            { ...captured.domain, target: { ...captured.domain.target, path: '/other' } },
            { ...captured.domain, healthCheck: { path: '/other-health', expectStatus: 204 } }]) {
            expect(await native.owner.observe({ placement, route: { ...captured, domain } })).toMatchObject({ kind: 'conflict' });
            expect(await native.owner.remove({ placement, route: { ...captured, domain } })).toMatchObject({ kind: 'conflict' });
        }
        native.loseNextWrite();
        expect((await native.owner.remove({ placement, route: captured })).kind).toBe('unknown');
        expect(native.server.routes).toEqual([native.foreign]);
        expect(native.server.errors.routes).toHaveLength(1);
        const removed = await native.owner.remove({ placement, route: captured });
        expect(removed.kind).toBe('removed');
        if (removed.kind !== 'removed') throw new Error('Topologyless removal did not settle');
        expect(verifyNativeCaddyRemoval(removed, placement, captured, native.keys.publicKey)).toBe(true);
        expect(native.server.errors.routes).toEqual([]);
        const count = native.writes.length;
        expect((await native.owner.remove({ placement, route: captured })).kind).toBe('removed');
        expect(await native.owner.observe({ placement, route: captured })).toEqual({ kind: 'absent' });
        expect(native.writes).toHaveLength(count);
    });

    it('installs public TLS and redirect resources once, removes them without secret reacquisition and preserves shared config', async () => {
        const config = materializeCaddyInitialConfigV1({ adminSocket: '/run/caddy/admin.sock', originListen: [':8080'],
            publicListen: [':443'], publicHttpListen: [':80'] });
        const paths = new Map<string, Record<string, unknown>>([
            ['/config/apps/http/servers/happier_public', config.apps.http.servers.happier_public!],
            [`/config/apps/http/servers/${caddyPublicHttpServerId('happier_public')}`, config.apps.http.servers.happier_public_http!],
            ['/config/apps/tls', config.apps.tls!],
        ]);
        const foreign = { '@id': 'foreign-certificate', certificate: 'foreign', key: 'foreign', tags: ['foreign'] };
        const tls = config.apps.tls!;
        tls.certificates.load_pem.push(foreign);
        let version = 0;
        const writes: string[] = [];
        const exchange: NativeCaddyAdminExchange = async request => {
            const parentPath = [...paths.keys()].find(path => request.path === path || request.path.startsWith(`${path}/`));
            const parent = parentPath ? paths.get(parentPath) : undefined;
            if (request.method === 'GET') return parent ? { status: 200, value: structuredClone(parent), etag: `"${parentPath} ${version}"` } : { status: 404 };
            const ownedId = request.path.startsWith('/id/') ? decodeURIComponent(request.path.slice(4)) : undefined;
            const arrays = [...paths.values()].flatMap(value => [value.routes, (value.errors as { routes?: unknown[] } | undefined)?.routes,
                value.tls_connection_policies, (value.certificates as { load_pem?: unknown[] } | undefined)?.load_pem,
                (value.automation as { policies?: unknown[] } | undefined)?.policies]).filter((value): value is unknown[] => Array.isArray(value));
            if (ownedId) {
                const list = arrays.find(items => items.some(item => item && typeof item === 'object' && '@id' in item && item['@id'] === ownedId));
                if (!list) return { status: 404 };
                const index = list.findIndex(item => item && typeof item === 'object' && '@id' in item && item['@id'] === ownedId);
                if (request.method === 'DELETE') list.splice(index, 1); else list[index] = structuredClone(request.value);
            } else {
                if (!parent || !parentPath) return { status: 404 };
                const segments = request.path.slice(parentPath.length + 1).split('/');
                let destination: Record<string, unknown> = parent;
                for (const segment of segments.slice(0, -2)) destination = destination[segment] as Record<string, unknown>;
                const list = destination[segments.at(-2)!];
                if (!Array.isArray(list)) return { status: 404 };
                list.unshift(structuredClone(request.value));
            }
            writes.push(`${request.method} ${request.path}`); version++;
            return { status: 200 };
        };
        const keys = tweetnacl.sign.keyPair();
        const owner = createNativeCaddyRoutes({ machineId: placement.machineId, installationId: placement.installationId,
            privateKey: keys.secretKey, exchange });
        const publicPlacement = { ...placement, nativeServer: 'happier_public' };
        const publicRoute: CaddyDomainRouteInput = { ...route, listener: 'public', peerOrigins: [],
            basicAuth: [{ username: 'reader', bcryptHash: 'existing-bcrypt-hash' }],
            publicTls: { kind: 'custom', certificatePem: 'certificate', privateKeyPem: 'private-key' } };
        const unsupported = { ...publicRoute, domain: { ...publicRoute.domain,
            target: { ...publicRoute.domain.target, redirectTo: 'javascript:unsupported' } } };
        expect(await owner.activate({ placement: publicPlacement, route: unsupported }))
            .toEqual({ kind: 'unavailable', reason: 'invalid_parameters' });
        expect(writes).toHaveLength(0);
        expect(await owner.activate({ placement: publicPlacement, route: publicRoute })).toEqual({ kind: 'active' });
        const material = materializeCaddyDomainRouteV1(publicRoute);
        expect(tls.certificates.load_pem).toContainEqual(material.tls?.certificate);
        expect(config.apps.http.servers.happier_public_http?.routes).toContainEqual(material.tls?.redirectRoute);
        const effectCount = writes.length;
        expect(await owner.activate({ placement: publicPlacement, route: publicRoute })).toEqual({ kind: 'active' });
        expect(writes).toHaveLength(effectCount);
        const withoutSecrets = { ...publicRoute, basicAuth: [{ username: 'reader' }], publicTls: { kind: 'custom' as const } };
        expect(await owner.observe({ placement: publicPlacement, route: withoutSecrets })).toEqual({ kind: 'active' });
        const exposure = await owner.readExposure({ placement: publicPlacement, route: withoutSecrets, caddy: {
            status: 'ready', containerId: 'private-container', containerName: 'happier-caddy',
            adminSocketPath: '/private/admin.sock', networkNames: [], servers: [
                { serverId: 'happier_public', listen: [':443'], tls: true, automaticHttpsDisabled: false,
                    endpoints: [{ hostAddress: '0.0.0.0', hostPort: 443, containerPort: 443 }] },
                { serverId: 'happier_public_http', listen: [':80'], tls: false, automaticHttpsDisabled: true,
                    endpoints: [{ hostAddress: '::', hostPort: 80, containerPort: 80 }] },
                { serverId: 'unrelated', listen: [':9000'], tls: false, automaticHttpsDisabled: true, endpoints: [] },
            ],
        } });
        expect(exposure).toEqual({ kind: 'ready', listener: 'public', localOrigin: true, fallback: false,
            listeners: [
                { tls: true, automaticHttpsDisabled: false,
                    endpoints: [{ audience: 'wildcard', hostPort: 443, containerPort: 443, protocol: 'tcp' }] },
                { tls: false, automaticHttpsDisabled: true,
                    endpoints: [{ audience: 'wildcard', hostPort: 80, containerPort: 80, protocol: 'tcp' }] },
            ] });
        expect(writes).toHaveLength(effectCount);
        expect(await owner.activate({ placement: publicPlacement, route: withoutSecrets })).toEqual({ kind: 'unavailable', reason: 'credential_unavailable' });
        expect(await owner.remove({ placement: publicPlacement, route: { ...withoutSecrets, basicAuth: [{ username: 'other-person' }] } }))
            .toEqual({ kind: 'conflict', reason: 'route_conflict' });
        expect(writes).toHaveLength(effectCount);
        const removed = await owner.remove({ placement: publicPlacement, route: withoutSecrets });
        expect(removed.kind).toBe('removed');
        if (removed.kind !== 'removed') throw new Error('Public removal did not settle');
        expect(removed.routeIds).toEqual(nativeCaddyDomainRouteIdsV1(publicRoute.domainId, 'public').removalIds);
        expect(verifyNativeCaddyRemoval(removed, publicPlacement, withoutSecrets, keys.publicKey)).toBe(true);
        expect(tls.certificates.load_pem).toEqual([foreign]);
        expect(await owner.observe({ placement: publicPlacement, route: publicRoute })).toEqual({ kind: 'absent' });
    });

    it('activates and observes the complete route and fallback, preserves foreign routes and performs zero equal writes', async () => {
        const native = caddyBoundary();
        const result = await native.owner.activate({ placement, route });
        expect(result.kind).toBe('active');
        expect(native.server.routes).toContainEqual(materializeCaddyDomainRouteV1(route).route);
        expect(native.server.errors.routes).toContainEqual(materializeCaddyDomainRouteV1(route).fallbackRoute);
        expect(native.server.routes).toContainEqual(native.foreign);
        const count = native.writes.length;
        expect((await native.owner.observe({ placement, route })).kind).toBe('active');
        expect((await native.owner.activate({ placement, route })).kind).toBe('active');
        expect(native.writes).toHaveLength(count);
    });

    it('changes the edge endpoint set only with the admitted prior material and refuses a foreign expanded host', async () => {
        const native = caddyBoundary();
        native.server.routes.push({ '@id': 'another-owner', match: [{ host: [route.domain.hostname] }], handle: [] });
        expect(await native.owner.activate({ placement, route })).toMatchObject({ kind: 'conflict', reason: 'route_conflict' });
        expect(native.writes).toHaveLength(0);
        native.server.routes.pop();
        const edge: CaddyDomainRouteInput = { ...route, listener: 'public', peerOrigins: [],
            upstreams: { kind: 'privateOrigins', endpoints: ['100.98.0.2:8080', '100.98.0.3:8080'] } };
        expect((await native.owner.activate({ placement, route: edge })).kind).toBe('active');
        const moved: CaddyDomainRouteInput = { ...edge, upstreams: { kind: 'privateOrigins', endpoints: ['100.98.0.4:8080'] } };
        expect((await native.owner.activate({ placement, route: moved })).kind).toBe('conflict');
        expect((await native.owner.activate({ placement, route: moved, expected: materializeCaddyDomainRouteV1(edge) })).kind).toBe('active');
        expect(native.server.routes).toContainEqual(materializeCaddyDomainRouteV1(moved).route);
    });

    it('removes only the admitted owned route and signs exact installed absence for DTEAR', async () => {
        const native = caddyBoundary();
        await native.owner.activate({ placement, route });
        const removed = await native.owner.remove({ placement, route });
        expect(removed.kind).toBe('removed');
        if (removed.kind !== 'removed') throw new Error('Native removal did not settle');
        expect(native.server.routes).toEqual([native.foreign]);
        expect(native.server.errors.routes).toEqual([]);
        expect(verifyNativeCaddyRemoval(removed, placement, route, native.keys.publicKey)).toBe(true);
        for (const changed of [{ environmentId: 'other' }, { domainId: 'other' }, { requestId: 'other' },
            { actionOperationId: 'other' }, { machineId: 'other' }, { installationId: 'other' }]) {
            expect(verifyNativeCaddyRemoval(removed, { ...placement, ...changed }, route, native.keys.publicKey)).toBe(false);
        }
        expect(verifyNativeCaddyRemoval(removed, placement, route, tweetnacl.sign.keyPair().publicKey)).toBe(false);
    });

    it('refuses a valid absence proof for the wrong listener while the intended leg remains installed', async () => {
        const native = caddyBoundary();
        expect((await native.owner.activate({ placement, route })).kind).toBe('active');
        const wrongLeg = await native.owner.remove({ placement, route: { ...route, listener: 'public' } });
        if (wrongLeg.kind !== 'removed') throw new Error('Expected a signed absence for the other listener');
        expect((await native.owner.observe({ placement, route })).kind).toBe('active');
        expect(verifyNativeCaddyRemoval(wrongLeg, placement, route, native.keys.publicKey)).toBe(false);
        const removed = await native.owner.remove({ placement, route });
        if (removed.kind !== 'removed') throw new Error('Expected removal of the intended listener');
        expect(verifyNativeCaddyRemoval(removed, placement, route, native.keys.publicKey)).toBe(true);
    });

    it('permits distinct paths on the same host while refusing an overlapping health or app path', async () => {
        const native = caddyBoundary();
        native.server.routes.push({ '@id': 'another-path', match: [{ host: [route.domain.hostname], path: ['/other*'] }], handle: [] });
        const scoped: CaddyDomainRouteInput = { ...route, peerOrigins: [], domain: { ...route.domain,
            target: { ...route.domain.target, path: '/api' }, healthCheck: { path: '/api/health', expectStatus: 200 } } };
        expect((await native.owner.activate({ placement, route: scoped })).kind).toBe('active');
        const overlapping = { ...scoped, domain: { ...scoped.domain, healthCheck: { path: '/other/health', expectStatus: 200 } } };
        const count = native.writes.length;
        expect((await native.owner.activate({ placement, route: overlapping,
            expected: materializeCaddyDomainRouteV1(scoped) })).kind).toBe('conflict');
        expect(native.writes).toHaveLength(count);
    });

    it('reports a lost write as unknown and reconciles at the next admission without replaying it', async () => {
        const native = caddyBoundary();
        const single = { ...route, peerOrigins: [] };
        native.loseNextWrite();
        expect((await native.owner.activate({ placement, route: single })).kind).toBe('unknown');
        expect(native.writes).toHaveLength(1);
        expect((await native.owner.activate({ placement, route: single })).kind).toBe('active');
        expect(native.writes).toHaveLength(1);
        native.loseNextWrite();
        expect((await native.owner.remove({ placement, route: single })).kind).toBe('unknown');
        const count = native.writes.length;
        expect((await native.owner.remove({ placement, route: single })).kind).toBe('removed');
        expect(native.writes).toHaveLength(count);
    });

    it('does not retry ETag refusal, write after cancellation, or touch another installation', async () => {
        const native = caddyBoundary();
        native.refuseNextWrite();
        expect((await native.owner.activate({ placement, route })).kind).toBe('conflict');
        expect(native.writes).toHaveLength(1);
        expect((await native.owner.activate({ placement: { ...placement, installationId: 'replacement' }, route })).kind).toBe('conflict');
        const cancel = new AbortController(); cancel.abort();
        expect((await native.owner.activate({ placement, route, signal: cancel.signal })).kind).toBe('cancelled');
        expect(native.writes).toHaveLength(1);
    });
});

describe('native Caddy start-first switch adapter', () => {
    const generation = (projectName: string, replicaCount = 2): NativeComposeRoutingGeneration => ({
        environmentInstanceId: 'instance', engineId: 'engine', projectName, admissionProjectName: 'environment',
        services: ['web', 'api'].map(service => ({ service, stopGracePeriodSeconds: 17,
            replicas: Array.from({ length: replicaCount }, (_, index) => index + 1).map(number => ({ id: `${projectName}-${service}-${number}`,
                name: `${projectName}-${service}-${number}`, networks: [`${projectName}_default`] })) })),
    });
    const incumbent = generation('old'), candidate = generation('new', 3);
    const web: CaddyDomainRouteInput = { ...route, peerOrigins: [], basicAuth: [{ username: 'reader', bcryptHash: 'configured-native-hash' }],
        upstreams: { kind: 'replicas', containerNames: ['old-web-1', 'old-web-2'] } };
    const api: CaddyDomainRouteInput = { ...web, domainId: 'api-domain', domain: { ...web.domain,
        hostname: 'api.example.test', target: { service: 'api', containerPort: 4000 } },
        upstreams: { kind: 'replicas', containerNames: ['old-api-1', 'old-api-2'] } };
    const apiPlacement = { ...placement, domainId: api.domainId };

    it('switches every affected leg through the real route owner with complete candidate replica lists', async () => {
        const native = caddyBoundary();
        await native.owner.activate({ placement, route: web });
        await native.owner.activate({ placement: apiPlacement, route: api });
        const before = native.writes.length;
        const adapter = createNativeCaddyStartFirstRoutes({ routes: native.owner,
            legs: [{ placement, route: { ...web, basicAuth: [{ username: 'reader' }] } },
                { placement: apiPlacement, route: { ...api, basicAuth: [{ username: 'reader' }] } }] });
        expect(await adapter.switch({ candidate, incumbent })).toEqual({ kind: 'switched' });
        expect(native.writes.slice(before)).toEqual([web, api].map(input =>
            `PATCH /id/${nativeCaddyDomainRouteIdsV1(input.domainId, input.listener).proxyId}`));
        for (const [input, target] of [[web, placement], [api, apiPlacement]] as const) {
            const replicas = candidate.services.find(service => service.service === input.domain.target.service)!.replicas;
            const [first, ...rest] = replicas.map(replica => replica.name);
            if (!first) throw new Error('Expected complete native replicas');
            expect((await native.owner.observe({ placement: target, route: { ...input,
                upstreams: { kind: 'replicas', containerNames: [first, ...rest] } } })).kind).toBe('active');
        }
        expect(native.server.routes).toContainEqual(native.foreign);
        const writes = native.writes.length;
        expect(await adapter.switch({ candidate, incumbent })).toEqual({ kind: 'switched' });
        expect(native.writes).toHaveLength(writes);
    });

    it('projects only validated nonsecret local legs, rejects changed incumbent and recovers a lost proxy reply', async () => {
        const native = caddyBoundary();
        await native.owner.activate({ placement, route: web });
        const identity = { domainId: web.domainId, domain: web.domain, listener: web.listener, basicAuth: [{ username: 'reader' }] };
        const observed = await native.owner.readStartFirstLeg({ placement, route: identity });
        expect(observed).toEqual({ kind: 'ready', leg: { placement, route: { ...identity, privateSourceRanges: web.privateSourceRanges, peerOrigins: [] } } });
        if (observed.kind !== 'ready') throw new Error('Expected local replica leg');
        const before = native.writes.length;
        const request = { ...observed.leg, expectedReplicaNames: ['not-the-incumbent'] as const,
            candidateReplicaNames: ['new-web-1', 'new-web-2', 'new-web-3'] as const };
        expect(await native.owner.switchReplicas(request)).toMatchObject({ kind: 'conflict' });
        expect(await native.owner.readStartFirstLeg({ placement, route: { ...identity,
            domain: { ...identity.domain, hostname: 'foreign.example.test' } } })).toMatchObject({ kind: 'conflict' });
        expect(native.writes).toHaveLength(before);
        const valid = { ...request, expectedReplicaNames: ['old-web-1', 'old-web-2'] as const };
        native.loseNextWrite();
        expect(await native.owner.switchReplicas(valid)).toMatchObject({ kind: 'unknown' });
        const afterLost = native.writes.length;
        expect(await native.owner.switchReplicas(valid)).toEqual({ kind: 'active' });
        expect(native.writes).toHaveLength(afterLost);
        const edge: CaddyDomainRouteInput = { ...web, upstreams: { kind: 'privateOrigins', endpoints: ['100.98.0.3:8080'] } };
        await native.owner.activate({ placement, route: edge,
            expected: materializeCaddyDomainRouteV1({ ...web, upstreams: { kind: 'replicas', containerNames: valid.candidateReplicaNames } }) });
        expect(await native.owner.readStartFirstLeg({ placement, route: identity })).toEqual({ kind: 'unchanged' });
    });

    it.each(['unknown', 'conflict', 'unavailable', 'cancelled'] as const)('passes native %s through without switching later legs', async kind => {
        const native = caddyBoundary();
        await native.owner.activate({ placement, route: web });
        await native.owner.activate({ placement: apiPlacement, route: api });
        const adapter = createNativeCaddyStartFirstRoutes({ routes: native.owner,
            legs: [{ placement, route: web }, { placement: apiPlacement, route: api }] });
        const cancel = new AbortController();
        if (kind === 'unknown') native.loseNextWrite();
        if (kind === 'conflict') native.refuseNextWrite();
        if (kind === 'unavailable') native.unavailableNextWrite();
        if (kind === 'cancelled') cancel.abort();
        expect(await adapter.switch({ candidate, incumbent, signal: cancel.signal })).toMatchObject({ kind });
        expect((await native.owner.observe({ placement: apiPlacement, route: api })).kind).toBe('active');
    });

    it('does not switch on missing candidate replicas, while an Environment with no affected legs does no native work', async () => {
        const native = caddyBoundary();
        const adapter = createNativeCaddyStartFirstRoutes({ routes: native.owner, legs: [{ placement, route: web }] });
        expect(await adapter.switch({ candidate: { ...candidate, services: [] }, incumbent })).toMatchObject({ kind: 'unavailable' });
        expect(native.writes).toEqual([]);
        expect(await createNativeCaddyStartFirstRoutes({ routes: native.owner, legs: [] }).switch({ candidate, incumbent }))
            .toEqual({ kind: 'switched' });
        expect(native.writes).toEqual([]);
    });
});
