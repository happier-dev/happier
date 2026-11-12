import { Resolver } from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthCheckResultV1Schema } from '@happier-dev/deployment-protocol/v1';
import { createNativeCaddyRoutes, type NativeCaddyAdminExchange, type NativeCaddyRoutePlacement } from './nativeCaddyRoutes';
import { caddyPublicHttpServerId, type CaddyDomainRouteRemovalInput } from '@/deployments/targets/ownServer/caddyRouteMaterialization';

const placement: NativeCaddyRoutePlacement = { serverId: 'home', accountId: 'owner', environmentId: 'environment',
    targetLinkId: 'link', domainId: 'domain', machineId: 'machine', installationId: 'installation',
    actionOperationId: 'operation', requestId: 'request', nativeServer: 'happier_public' };
const route: CaddyDomainRouteRemovalInput = { domainId: 'domain', listener: 'public',
    domain: { hostname: 'app.example.test', target: { service: 'web', containerPort: 3000 } } };

// DNS, public HTTP and the Caddy admin exchange are genuine external boundaries.
function boundary() {
    const foreign = { '@id': 'another-app', handle: [{ handler: 'static_response', status_code: 200 }] };
    const routes: unknown[] = [foreign];
    const root = { routes };
    const effects: string[] = [];
    const reads: string[] = [];
    let installFailure = false, cleanupFailure = false, cleanupTransportFailure = false, lostInstallReply = false;
    const exchange: NativeCaddyAdminExchange = async request => {
        request.signal?.throwIfAborted();
        if (request.method === 'GET') {
            reads.push(request.path);
            return { status: 200, value: structuredClone(root), etag: JSON.stringify(root) };
        }
        effects.push(request.method);
        if (request.method === 'DELETE' && cleanupTransportFailure) throw Object.assign(new Error('private admin socket'), { code: 'ECONNRESET' });
        if (request.method === 'PUT' && installFailure || request.method === 'DELETE' && cleanupFailure) return { status: 503 };
        if (request.etag !== JSON.stringify(root)) return { status: 412 };
        if (request.method === 'PUT') {
            routes.unshift(structuredClone(request.value));
            if (lostInstallReply) throw Object.assign(new Error('private admin reply lost'), { code: 'EPIPE' });
        } else if (request.method === 'DELETE') {
            const wanted = decodeURIComponent(request.path.slice('/id/'.length));
            const index = routes.findIndex(item => item !== null && typeof item === 'object' && '@id' in item && item['@id'] === wanted);
            if (index < 0) return { status: 404 };
            routes.splice(index, 1);
        } else throw new Error('Unexpected admin operation');
        return { status: 200 };
    };
    const owner = createNativeCaddyRoutes({ machineId: 'machine', installationId: 'installation', privateKey: new Uint8Array(64), exchange });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
        const challenge = routes[0] as { match: { host: string[]; path: string[] }[]; handle: { body: string }[] };
        expect(input).toBe(`http://${route.domain.hostname}${challenge.match[0]!.path[0]}`);
        expect(challenge.match[0]!.host).toEqual([route.domain.hostname]);
        expect(options?.redirect).toBe('manual');
        return new Response(challenge.handle[0]!.body);
    });
    vi.stubGlobal('fetch', fetch);
    return { owner, routes, foreign, effects, reads, fetch,
        failInstall: () => { installFailure = true; }, failCleanup: () => { cleanupFailure = true; },
        loseInstallReply: () => { lostInstallReply = true; }, failCleanupTransport: () => { cleanupTransportFailure = true; } };
}
const request = () => ({ hostname: route.domain.hostname, nativeServer: placement.nativeServer,
    listener: route.listener, signal: new AbortController().signal });

describe('native Domain DNS reachability', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('proves the exact public hostname through a one-use Caddy route and removes only that route', async () => {
        vi.spyOn(Resolver.prototype, 'resolve').mockResolvedValue(['2001:db8::1']);
        const native = boundary();
        let servedToken = '';
        native.fetch.mockImplementationOnce(async () => {
            const challenge = native.routes[0] as { handle: { body: string }[] };
            servedToken = challenge.handle[0]!.body;
            native.routes.push({ '@id': 'concurrent-app' });
            return new Response(servedToken);
        });
        const result = HealthCheckResultV1Schema.parse(await native.owner.checkDnsReadiness(request()));
        expect(result).toMatchObject({ status: 'up' });
        expect(result.evidence.items[0]?.text).toContain('dns_ready');
        expect(JSON.stringify(result)).not.toContain(servedToken);
        expect(native.routes).toEqual([native.foreign, { '@id': 'concurrent-app' }]);
        expect(native.effects).toEqual(['PUT', 'DELETE']);
        expect(native.reads).toEqual(Array(2).fill(`/config/apps/http/servers/${caddyPublicHttpServerId(placement.nativeServer)}`));
    });

    it('settles absent DNS without Caddy effects, accepts IPv6-only records and retains resolver failure', async () => {
        const resolve = vi.spyOn(Resolver.prototype, 'resolve').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENODATA' }));
        const native = boundary();
        expect(await native.owner.checkDnsReadiness(request())).toMatchObject({ status: 'down' });
        expect(native.effects).toEqual([]);
        expect(native.reads).toEqual([]);
        expect(native.fetch).not.toHaveBeenCalled();
        resolve.mockRejectedValueOnce(Object.assign(new Error('missing A'), { code: 'ENODATA' })).mockResolvedValueOnce(['2001:db8::1']);
        expect(await native.owner.checkDnsReadiness(request())).toMatchObject({ status: 'up' });
        resolve.mockRejectedValue(Object.assign(new Error('private DNS details'), { code: 'ESERVFAIL' }));
        const unavailable = await native.owner.checkDnsReadiness(request());
        expect(unavailable).toMatchObject({ status: 'unknown' });
        expect(JSON.stringify(unavailable)).toContain('resolver_unavailable');
        expect(JSON.stringify(unavailable)).not.toContain('private DNS details');
    });

    it('distinguishes another server, oversized responses and redirects without following another authority', async () => {
        vi.spyOn(Resolver.prototype, 'resolve').mockResolvedValue(['192.0.2.1']);
        const native = boundary();
        for (const response of [new Response('another server'), new Response('x'.repeat(10000)),
            new Response(null, { status: 302, headers: { location: 'https://other.example.test/' } })]) {
            native.fetch.mockResolvedValueOnce(response);
            const result = await native.owner.checkDnsReadiness(request());
            expect(result).toMatchObject({ status: 'down' });
            expect(JSON.stringify(result)).toContain('dns_not_this_machine');
            expect(native.routes).toEqual([native.foreign]);
        }
        expect(native.fetch).toHaveBeenCalledTimes(3);
        expect(native.fetch.mock.calls.every(([, options]) => options?.redirect === 'manual')).toBe(true);
    });

    it('stops at the exact token plus one byte and disposes the response before exact cleanup', async () => {
        vi.spyOn(Resolver.prototype, 'resolve').mockResolvedValue(['192.0.2.1']);
        const native = boundary();
        let disposed = false;
        native.fetch.mockImplementationOnce(async () => {
            const challenge = native.routes[0] as { handle: { body: string }[] };
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) { controller.enqueue(new TextEncoder().encode(`${challenge.handle[0]!.body}x`)); },
                cancel() { disposed = true; },
            }));
        });
        expect(await native.owner.checkDnsReadiness(request())).toMatchObject({ status: 'down' });
        expect(disposed).toBe(true);
        expect(native.routes).toEqual([native.foreign]);
    });

    it('cleans its route after transport failure and caller cancellation, retaining unavailable causes', async () => {
        vi.spyOn(Resolver.prototype, 'resolve').mockResolvedValue(['192.0.2.1']);
        const native = boundary();
        native.fetch.mockRejectedValueOnce(Object.assign(new Error('private failure'), { cause: Object.assign(new Error('socket'), { code: 'ECONNREFUSED' }) }));
        const unavailable = await native.owner.checkDnsReadiness(request());
        expect(unavailable).toMatchObject({ status: 'unknown' });
        expect(JSON.stringify(unavailable)).toContain('ECONNREFUSED');
        expect(native.routes).toEqual([native.foreign]);
        const abort = new AbortController();
        native.fetch.mockImplementationOnce(async () => { abort.abort(); throw abort.signal.reason; });
        expect(await native.owner.checkDnsReadiness({ ...request(), signal: abort.signal })).toMatchObject({ kind: 'cancelled' });
        expect(native.routes).toEqual([native.foreign]);
    });

    it('retains admin installation/cleanup failures and cleans a lost installation reply', async () => {
        vi.spyOn(Resolver.prototype, 'resolve').mockResolvedValue(['192.0.2.1']);
        const install = boundary();
        install.failInstall();
        expect(await install.owner.checkDnsReadiness(request())).toMatchObject({ kind: 'unavailable', failureCause: { httpStatus: 503 } });
        expect(install.fetch).not.toHaveBeenCalled();
        const cleanup = boundary();
        cleanup.failCleanup();
        expect(await cleanup.owner.checkDnsReadiness(request())).toMatchObject({ kind: 'unavailable', failureCause: { httpStatus: 503 } });
        expect(cleanup.routes).toHaveLength(2);
        const lost = boundary();
        lost.loseInstallReply();
        expect(await lost.owner.checkDnsReadiness(request())).toMatchObject({ kind: 'unknown', failureCause: { errorCode: 'EPIPE' } });
        expect(lost.routes).toEqual([lost.foreign]);
        const reset = boundary();
        reset.failCleanupTransport();
        const resetResult = await reset.owner.checkDnsReadiness(request());
        expect(resetResult).toMatchObject({ kind: 'unknown', failureCause: { errorCode: 'ECONNRESET', phase: 'deployment.domain.dns.cleanup' } });
        expect(JSON.stringify(resetResult)).not.toContain('private admin socket');
    });

    it('does not assert public DNS readiness for private listeners or cancelled admission', async () => {
        const resolve = vi.spyOn(Resolver.prototype, 'resolve').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENODATA' }));
        const native = boundary();
        const missing = await native.owner.checkDnsReadiness({ ...request(), listener: 'privateOrigin' });
        expect(missing).toMatchObject({ status: 'down' });
        expect(JSON.stringify(missing)).toContain('dns_missing');
        resolve.mockResolvedValue(['192.0.2.1']);
        const result = await native.owner.checkDnsReadiness({ ...request(), listener: 'privateOrigin' });
        expect(result).toMatchObject({ status: 'unknown' });
        expect(JSON.stringify(result)).toContain('dns_private_listener_unavailable');
        const abort = new AbortController(); abort.abort();
        expect(await native.owner.checkDnsReadiness({ ...request(), signal: abort.signal })).toMatchObject({ kind: 'cancelled' });
        expect(resolve).toHaveBeenCalledTimes(4);
        expect(native.effects).toEqual([]);
    });
});
