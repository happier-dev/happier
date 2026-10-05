import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { LocalServicePreviewResourceV1, MachineOperationProtocolCapabilitiesV1 } from '@happier-dev/protocol';
import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler } from '@/app/api/testkit/routeHarness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLocalServicePreviewRoutes } from './registerRoutes';
import { createLocalServicePreviewRuntime } from '@/app/local/services/preview/runtime';
import type { OpenLocalServicePreviewTunnel } from '@/app/local/services/preview/httpAdapter';
import { createLocalServiceRouteRuntimes, registerLocalServiceRoutes } from '../registerRoutes';
import type { SessionAccessProjectionRow } from '@/app/session/access/sessionAccess';
import { LocalServicePreviewNativeDirectAccessV1Schema, LocalServicePreviewServerAccessV1Schema } from '@happier-dev/protocol/local/services/preview/nativeDirect';
import type { Fastify } from '@/app/api/types';
import { enableServeUi } from '@/app/api/utils/enableServeUi';

// Only database, HTTP router/socket and network tunnel boundaries are replaced.
const machineFindFirst = vi.hoisted(() => vi.fn(async (_query: unknown): Promise<{
    id: string; revokedAt?: Date | null; replacedByMachineId?: string | null;
    operationProtocolCapabilities?: MachineOperationProtocolCapabilitiesV1;
    operationProtocolCapabilitiesRevision?: number;
} | null> => ({ id: 'machine_1' })));
const sessionFindUnique = vi.hoisted(() => vi.fn(async (): Promise<SessionAccessProjectionRow | null> => null));
vi.mock('@/storage/db', () => ({ db: { machine: { findFirst: machineFindFirst }, session: { findUnique: sessionFindUnique } } }));

const preview: LocalServicePreviewResourceV1 = {
    previewId: 'preview_1', sessionId: 'session_1', machineId: 'machine_1',
    owner: { kind: 'session', id: 'session_1' },
    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
    initialPath: { pathname: '/', search: '' },
    display: { title: 'Vite App', addressLabel: 'localhost:5173' }, originMode: 'host',
};
const sharedSession: SessionAccessProjectionRow = {
    id: 'session_1', accountId: 'user_1', account: { status: 'active' }, primaryTeamId: null,
    seq: 0, currentStorageState: 'hosted', acceptedThroughServerSeq: 0,
    materializationPublicationId: null, materializedThroughSourceAt: null, publishedThroughServerSeq: null,
    shares: [{ id: 'share_1', sharedWithUserId: 'viewer_1', accessLevel: 'view', canApprovePermissions: false }],
    teamGrants: [], groupGrants: [],
};
const HOST = 'preview-1.preview.happier.test';
const DECODED_CRLF_PATH = 'foo\r\nX-Injected: yes\r\n\r\nGET /admin HTTP/1.1';
const ENCODED_CRLF_PATH = '/foo%0D%0AX-Injected:%20yes%0D%0A%0D%0AGET%20/admin%20HTTP/1.1';

function fixture(openTunnel?: OpenLocalServicePreviewTunnel) {
    const runtime = createLocalServicePreviewRuntime({
        tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test',
        hostOriginBaseDomain: 'preview.happier.test', nowMs: () => 1_000,
    });
    const registered = runtime.registerPreview({ resource: preview, accountId: 'user_1' });
    if (!registered.ok) throw new Error(registered.reasonCode);
    if (!registered.accessUrl) throw new Error('Private preview fixture requires an access URL');
    const queryToken = new URL(registered.accessUrl).searchParams.get('previewToken');
    const binding = { previewId: preview.previewId, sessionId: preview.sessionId, machineId: preview.machineId };
    const viewer = runtime.exchangeAccessToken({ ...binding, rawToken: queryToken });
    if (!viewer.ok) throw new Error(viewer.reasonCode);
    const upgradeHandlers: Array<(request: unknown, socket: unknown, head: Uint8Array) => unknown> = [];
    const app = Object.assign(createFakeRouteApp(), {
        server: { on(event: string, handler: (request: unknown, socket: unknown, head: Uint8Array) => unknown) {
            if (event === 'upgrade') upgradeHandlers.push(handler);
        } },
    });
    registerLocalServicePreviewRoutes(app as never, {
        resolvePreview: runtime.resolvePreview, resolvePreviewByHost: runtime.resolvePreviewByHost,
        hostOriginBaseDomain: 'preview.happier.test', registerPreview: runtime.registerPreview,
        unregisterPreview: runtime.unregisterPreview, validateAccess: runtime.validateAccess,
        exchangeAccessToken: runtime.exchangeAccessToken,
        resolvePreviewAccountId: (id) => runtime.resolvePreviewContext(id)?.accountId,
        openTunnel,
    });
    return { runtime, app, upgradeHandlers, cookie: `happier_preview_token=${viewer.rawToken}` };
}

function tunnelBoundary(response = 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n') {
    const writes: string[] = [];
    const openTunnel: OpenLocalServicePreviewTunnel = async () => ({
        tunnelId: 'tunnel', substreamId: 'stream',
        write(bytes) { writes.push(new TextDecoder().decode(bytes)); },
        endWrite() {}, close() {}, abort() {},
        async *read() { yield new TextEncoder().encode(response); },
    });
    return { openTunnel, writes };
}

function downstreamBoundary() {
    const events = new EventEmitter();
    let wrote = () => {};
    const writing = new Promise<void>((resolve) => { wrote = resolve; });
    const socket = Object.assign(events, {
        destroyed: false, ended: false, writing, output: [] as string[],
        writeHead() {},
        write(bytes: Uint8Array) { socket.output.push(new TextDecoder().decode(bytes)); wrote(); return false; },
        end() { socket.ended = true; },
        destroy() { socket.destroyed = true; events.emit('close'); },
        async *[Symbol.asyncIterator]() {},
    });
    return socket;
}

describe('local service preview routes', () => {
    beforeEach(() => {
        machineFindFirst.mockReset().mockResolvedValue({ id: 'machine_1' });
        sessionFindUnique.mockReset().mockResolvedValue(null);
    });

    it.each(['GET', 'HEAD'] as const)('keeps preview-host %s root requests in preview policy instead of the root UI', async (method) => {
        const uiDir = await mkdtemp(join(tmpdir(), 'happier-preview-root-'));
        const app = fastify({ logger: false });
        try {
            await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>Happier root fixture</title>', 'utf8');
            app.setValidatorCompiler(validatorCompiler);
            app.setSerializerCompiler(serializerCompiler);
            app.decorate('authenticate', async () => {});
            enableServeUi(app, { dir: uiDir, prefix: '/', mountRoot: true, required: true });
            const runtime = createLocalServicePreviewRuntime({
                tokenSecret: 'test-secret', publicBaseUrl: 'https://app.happier.test',
                hostOriginBaseDomain: 'preview.happier.test', nowMs: () => 1_000,
            });
            registerLocalServicePreviewRoutes(app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify, {
                resolvePreview: runtime.resolvePreview, resolvePreviewByHost: runtime.resolvePreviewByHost,
                hostOriginBaseDomain: 'preview.happier.test', validateAccess: runtime.validateAccess,
                exchangeAccessToken: runtime.exchangeAccessToken,
            });
            const injectPreview = (url: string, host = HOST) => app.inject({ method, url, headers: { host } });
            const assertRefusal = async (url: string, status: number, error: string, reasonCode: string, host = HOST) => {
                const response = await injectPreview(url, host);
                expect(response.statusCode).toBe(status);
                expect(response.headers['content-type']).toContain('application/json');
                expect(response.json()).toEqual({ error, reasonCode });
                expect(response.body).not.toContain('Happier root fixture');
            };

            await assertRefusal('/', 404, 'preview_not_found', 'preview_not_found');
            const registered = runtime.registerPreview({ resource: preview, accountId: 'user_1' });
            if (!registered.ok) throw new Error(registered.reasonCode);
            await assertRefusal('/', 401, 'preview_access_denied', 'preview_token_missing');
            await assertRefusal('/?previewToken=invalid', 401, 'preview_access_denied', 'token_mismatch');
            await assertRefusal('/qa-preview-probe', 401, 'preview_access_denied', 'preview_token_missing');
            await assertRefusal('/', 404, 'preview_not_found', 'preview_not_found', 'unknown.preview.happier.test');

            const ui = await app.inject({ method, url: '/', headers: { host: 'app.happier.test' } });
            expect(ui.statusCode).toBe(200);
            expect(ui.headers['content-security-policy']).toBe("frame-ancestors 'none'");
            if (method === 'GET') expect(ui.body).toContain('Happier root fixture');
            else expect(ui.body).toBe('');
        } finally {
            await app.close();
            await rm(uiDir, { recursive: true, force: true });
        }
    });

    it('refreshes expired server admission for a shared viewer without native endpoint availability', async () => {
        sessionFindUnique.mockResolvedValue(sharedSession);
        const env = { HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home', HANDY_MASTER_SECRET: 'test-master-secret',
            HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test', HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_MACHINES_TUNNEL_DIRECT_PEER__ENABLED: 'false' };
        let now = 1_000;
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: env.HAPPIER_PUBLIC_SERVER_URL,
            hostOriginBaseDomain: 'preview.happier.test', tokenTtlMs: 60_000, nowMs: () => now });
        const registered = runtime.registerPreview({ resource: preview, accountId: 'user_1' });
        if (!registered.ok || !registered.accessUrl) throw new Error('Expected isolated server admission');
        const binding = { previewId: preview.previewId, sessionId: preview.sessionId, machineId: preview.machineId };
        now = 61_001;
        expect(runtime.exchangeAccessToken({ ...binding, rawToken: new URL(registered.accessUrl).searchParams.get('previewToken') }))
            .toEqual({ ok: false, reasonCode: 'expired' });
        machineFindFirst.mockResolvedValue(null);
        const app = createFakeRouteApp();
        registerLocalServiceRoutes(app as never, { env, runtimes: { ...createLocalServiceRouteRuntimes(env), preview: runtime } });
        const request = { userId: 'viewer_1', authAuthority: 'present_user', params: { previewId: preview.previewId },
            body: { v: 1, kind: 'server_preview' } };
        const reply = createReplyStub();
        await getRouteHandler(app, 'POST', '/v1/local-services/preview/:previewId/access')(request, reply);
        expect(reply.statusCode).toBe(200);
        const refreshed = LocalServicePreviewServerAccessV1Schema.parse(reply.send.mock.calls[0]?.[0]);
        expect(refreshed).toMatchObject({ v: 1, kind: 'server_preview', previewId: preview.previewId, machineId: preview.machineId });
        expect(refreshed.expiresAt).toBeGreaterThan(now);
        const freshUrl = new URL(refreshed.accessUrl);
        expect(freshUrl.hostname).toBe('preview-1.preview.happier.test');
        expect(runtime.exchangeAccessToken({ ...binding, rawToken: freshUrl.searchParams.get('previewToken') }).ok).toBe(true);
        sessionFindUnique.mockResolvedValue(null);
        const denied = createReplyStub();
        await getRouteHandler(app, 'POST', '/v1/local-services/preview/:previewId/access')(request, denied);
        expect(denied.statusCode).toBe(403);
    });

    it('does not roll back replacement policy while a server admission waits for Session authorization', async () => {
        let startRead!: () => void;
        let finishRead!: (row: SessionAccessProjectionRow) => void;
        const reading = new Promise<void>((resolve) => { startRead = resolve; });
        const acl = new Promise<SessionAccessProjectionRow>((resolve) => { finishRead = resolve; });
        sessionFindUnique.mockImplementation(async () => { startRead(); return acl; });
        const env = { HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test', HANDY_MASTER_SECRET: 'secret',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true' };
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: env.HAPPIER_PUBLIC_SERVER_URL,
            hostOriginBaseDomain: 'preview.happier.test' });
        runtime.registerPreview({ resource: preview, accountId: 'user_1' });
        const app = createFakeRouteApp();
        registerLocalServiceRoutes(app as never, { env, runtimes: { ...createLocalServiceRouteRuntimes(env), preview: runtime } });
        const reply = createReplyStub();
        const pending = getRouteHandler(app, 'POST', '/v1/local-services/preview/:previewId/access')({
            userId: 'viewer_1', authAuthority: 'present_user', params: { previewId: preview.previewId },
            body: { v: 1, kind: 'server_preview' },
        }, reply);
        await reading;
        const policy: NonNullable<LocalServicePreviewResourceV1['policy']> = {
            allowedMethods: ['POST'], cookiePolicy: 'drop', compressionPolicy: 'identity', redirectPolicy: 'preserve_host_origin',
            maxRequestBodyBytes: 1_024, maxResponseBodyBytes: 1_024,
        };
        expect(runtime.registerPreview({ resource: { ...preview, policy }, accountId: 'user_1' }).ok).toBe(true);
        finishRead(sharedSession);
        await pending;
        expect(runtime.resolvePreview(preview.previewId)?.policy).toEqual(policy);
        expect(reply.statusCode).toBe(404);
    });

    it.each([
        preview.owner,
        { kind: 'plugin', id: 'plugin_1' },
    ] satisfies LocalServicePreviewResourceV1['owner'][])('admits a shared Session viewer through real Session ACL without granting Machine ownership ($kind)', async (owner) => {
        sessionFindUnique.mockResolvedValue(sharedSession);
        machineFindFirst.mockImplementation(async (query: unknown) => {
            const parsed = query as { where: { accountId: string; id: string } };
            return parsed.where.accountId === 'user_1' && parsed.where.id === 'machine_1'
                ? { id: 'machine_1', revokedAt: null, replacedByMachineId: null,
                    operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: {
                        irohMachineEndpoint: { protocolVersions: [1], endpointId: 'b'.repeat(64) },
                        localServicePreviewNativeAccess: { protocolVersions: [1] },
                    } } : null;
        });
        const env = { HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home', HANDY_MASTER_SECRET: 'test-master-secret',
            HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test', HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_MACHINES_TUNNEL_DIRECT_PEER__ENABLED: 'true' };
        const runtimes = createLocalServiceRouteRuntimes(env);
        runtimes.preview.registerPreview({ resource: { ...preview, owner }, accountId: 'user_1' });
        const app = createFakeRouteApp();
        registerLocalServiceRoutes(app as never, { env, runtimes });
        const reply = createReplyStub();
        await getRouteHandler(app, 'POST', '/v1/local-services/preview/:previewId/access')({
            userId: 'viewer_1', authAuthority: 'present_user', params: { previewId: preview.previewId },
            body: { v: 1, initiator: { kind: 'account_client', endpointId: 'a'.repeat(64) }, ephemeralPublicKeyBase64Url: 'c'.repeat(43) },
        }, reply);
        expect(reply.statusCode).not.toBe(403);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({
            grant: expect.objectContaining({ payload: expect.objectContaining({ accountId: 'user_1', exp: null }) }),
        }));
        const access = LocalServicePreviewNativeDirectAccessV1Schema.parse(reply.send.mock.calls[0]?.[0]);
        const scope = access.grant.payload.scope;
        if (scope.kind !== 'tcp_tunnel' || !scope.preview) throw new Error('Expected a preview grant');
        const controlDenied = createReplyStub();
        await getRouteHandler(app, 'POST', '/v1/local-services/preview/:previewId/native-registration')({
            userId: 'viewer_1', authAuthority: 'present_user', params: { previewId: preview.previewId },
            body: { ...scope.preview, grantId: access.grant.payload.grantId },
        }, controlDenied);
        expect(controlDenied.statusCode).toBe(403);
        sessionFindUnique.mockResolvedValue(null);
        const denied = createReplyStub();
        await getRouteHandler(app, 'POST', '/v1/local-services/preview/:previewId/access')({
            userId: 'viewer_1', authAuthority: 'present_user', params: { previewId: preview.previewId },
            body: { v: 1, initiator: { kind: 'account_client', endpointId: 'a'.repeat(64) }, ephemeralPublicKeyBase64Url: 'c'.repeat(43) },
        }, denied);
        expect(denied.statusCode).toBe(403);
    });

    it('returns the typed no-private-route registration through the authenticated HTTP boundary', async () => {
        const runtime = createLocalServicePreviewRuntime({ tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test', hostOriginBaseDomain: null });
        const app = createFakeRouteApp();
        registerLocalServicePreviewRoutes(app as never, { ...runtime });
        const { sessionId: _sessionId, ...machinePreview } = preview;
        const reply = createReplyStub();
        await getRouteHandler(app, 'POST', '/v1/local-services/preview')({ userId: 'user_1', body: { ...machinePreview, owner: { kind: 'user', id: 'user_1' } } }, reply);
        expect(reply.statusCode).toBe(201);
        expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ accessUrl: null, expiresAt: null, accessUnavailableReasonCode: 'preview_private_route_unavailable' }));
    });

    it('authorizes a sessionless preview against its real Machine and Account', async () => {
        const { app, runtime } = fixture();
        const { sessionId: _sessionId, ...machinePreview } = preview;
        const resource = { ...machinePreview, previewId: 'machine-preview', owner: { kind: 'user', id: 'user_1' } };
        const handler = getRouteHandler(app, 'POST', '/v1/local-services/preview');
        const reply = createReplyStub();
        await handler({ userId: 'user_1', body: resource }, reply);
        expect(reply.statusCode).toBe(201);
        expect(runtime.resolvePreview('machine-preview')?.sessionId).toBeUndefined();
        expect(machineFindFirst).toHaveBeenCalledWith({
            where: { id: 'machine_1', accountId: 'user_1' }, select: { id: true },
        });
        machineFindFirst.mockResolvedValueOnce(null);
        const denied = createReplyStub();
        await handler({ userId: 'user_2', body: { ...resource, previewId: 'other', owner: { kind: 'user', id: 'user_2' } } }, denied);
        expect(denied.statusCode).toBe(403);
        expect(runtime.resolvePreview('other')).toBeNull();
    });

    it('refuses private preview data on the API origin even for a registered host resource', async () => {
        const { app, runtime, upgradeHandlers, cookie } = fixture();
        const registered = runtime.registerPreview({ resource: preview, accountId: 'user_1' });
        if (!registered.ok) throw new Error(registered.reasonCode);
        const reply = createReplyStub();
        await getRouteHandler(app, 'GET', '/v1/local-services/preview/:previewId/*')({
            params: { previewId: 'preview_1', '*': '' }, headers: { host: 'app.happier.test' },
            query: { previewToken: new URL(registered.accessUrl ?? '').searchParams.get('previewToken') },
        }, reply);
        expect(reply.statusCode).toBe(404);
        expect(reply.headers['Set-Cookie']).toBeUndefined();
        const socket = downstreamBoundary();
        const pending = Promise.resolve(upgradeHandlers[0]?.({
            url: '/v1/local-services/preview/preview_1/socket',
            headers: { host: 'app.happier.test', cookie },
        }, socket, new Uint8Array()));
        await socket.writing;
        socket.emit('drain');
        await pending;
        expect(socket.output.join('')).toContain('404 Not Found');
        expect(socket.destroyed).toBe(true);
    });

    it('requires real Session authorization when a Session is supplied', async () => {
        const { app, runtime } = fixture();
        const reply = createReplyStub();
        await getRouteHandler(app, 'POST', '/v1/local-services/preview')({
            userId: 'user_1', authAuthority: 'present_user', body: { ...preview, previewId: 'other-session' },
        }, reply);
        expect(reply.statusCode).toBe(403);
        expect(runtime.resolvePreview('other-session')).toBeNull();
    });

    it('revokes sessionless registration only for its owning Account and Machine', async () => {
        const { app, runtime } = fixture();
        const { sessionId: _sessionId, ...resource } = preview;
        expect(runtime.registerPreview({ accountId: 'user_1', resource: {
            ...resource, previewId: 'machine-preview', owner: { kind: 'user', id: 'user_1' },
        } }).ok).toBe(true);
        const handler = getRouteHandler(app, 'DELETE', '/v1/local-services/preview/:previewId');
        const denied = createReplyStub();
        await handler({ userId: 'user_2', params: { previewId: 'machine-preview' } }, denied);
        expect(denied.statusCode).toBe(403);
        const allowed = createReplyStub();
        await handler({ userId: 'user_1', params: { previewId: 'machine-preview' } }, allowed);
        expect(allowed.send).toHaveBeenCalledWith({ ok: true });
        expect(runtime.resolvePreview('machine-preview')).toBeNull();
    });

    it('keeps lifecycle authenticated and host data-plane access preview-token scoped', async () => {
        const network = tunnelBoundary();
        const { app, cookie } = fixture(network.openTunnel);
        expect(getRouteEntry(app, 'POST', '/v1/local-services/preview').opts.preHandler).toBe(app.authenticate);
        expect(getRouteEntry(app, 'DELETE', '/v1/local-services/preview/:previewId').opts.preHandler).toBe(app.authenticate);
        expect(getRouteEntry(app, 'GET', '/*').opts.preHandler).toBeUndefined();
        const reply = createReplyStub();
        await getRouteHandler(app, 'GET', '/*')({
            params: { '*': 'assets/app.js' }, query: { v: '1' }, headers: { host: HOST, cookie },
        }, reply);
        expect(network.writes.join('')).toContain('GET /assets/app.js?v=1 HTTP/1.1\r\n');
        for (const cookieHeader of [undefined, 'happier_preview_token=%E0%A4%A']) {
            const denied = createReplyStub();
            await getRouteHandler(app, 'GET', '/*')({ params: { '*': '' }, headers: { host: HOST, cookie: cookieHeader } }, denied);
            expect(denied.statusCode).toBe(401);
        }
    });

    it('exchanges a fresh URL token once into a Secure HTTP-only host cookie and tokenless redirect', async () => {
        const { app, runtime } = fixture();
        const registered = runtime.registerPreview({ resource: preview, accountId: 'user_1' });
        if (!registered.ok) throw new Error(registered.reasonCode);
        const request = {
            params: { '*': DECODED_CRLF_PATH }, headers: { host: HOST },
            query: { previewToken: new URL(registered.accessUrl ?? '').searchParams.get('previewToken'), tab: '1' },
        };
        const reply = createReplyStub();
        await getRouteHandler(app, 'GET', '/*')(request, reply);
        expect(reply.statusCode).toBe(303);
        expect(reply.headers.Location).toBe(`${ENCODED_CRLF_PATH}?tab=1`);
        expect(reply.headers.Location).not.toMatch(/[\r\n]/u);
        expect(String(reply.headers['Set-Cookie'])).toContain('Path=/');
        expect(String(reply.headers['Set-Cookie'])).toContain('HttpOnly');
        expect(String(reply.headers['Set-Cookie'])).toContain('Secure');
        const authenticatedReload = createReplyStub();
        await getRouteHandler(app, 'GET', '/*')({ ...request, headers: {
            host: HOST, cookie: String(reply.headers['Set-Cookie']).split(';')[0],
        } }, authenticatedReload);
        expect(authenticatedReload.statusCode).toBe(303);
        expect(authenticatedReload.headers.Location).toBe(`${ENCODED_CRLF_PATH}?tab=1`);
        expect(authenticatedReload.headers['Set-Cookie']).toBeUndefined();
        const replay = createReplyStub();
        await getRouteHandler(app, 'GET', '/*')(request, replay);
        expect(replay.statusCode).toBe(401);
    });

    it('never writes a second upstream request line for a router-decoded CRLF private preview path', async () => {
        const network = tunnelBoundary();
        const { app, cookie } = fixture(network.openTunnel);
        await getRouteHandler(app, 'GET', '/*')({
            method: 'GET', params: { '*': DECODED_CRLF_PATH }, headers: { host: HOST, cookie },
        }, createReplyStub());
        const upstream = network.writes.join('');
        expect(upstream.split('\r\n').filter((line) => /\sHTTP\/1\.1$/u.test(line))).toHaveLength(1);
        expect(upstream.split('\r\n')[0]).toBe(`GET ${ENCODED_CRLF_PATH} HTTP/1.1`);
        expect(upstream).not.toMatch(/\r\nX-Injected:/u);
    });

    it('waits for downstream HTTP response drain before resolving private preview response writes', async () => {
        const network = tunnelBoundary('HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx');
        const { app, cookie } = fixture(network.openTunnel);
        const raw = downstreamBoundary();
        const pending = getRouteHandler(app, 'GET', '/*')({
            params: { '*': '' }, headers: { host: HOST, cookie },
        }, { ...createReplyStub(), raw });
        await raw.writing;
        expect(raw.ended).toBe(false);
        raw.emit('drain');
        await pending;
        expect(raw.output.join('')).toBe('x');
        expect(raw.ended).toBe(true);
    });

    it('waits for downstream socket drain before resolving private preview WebSocket writes', async () => {
        const network = tunnelBoundary('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
        const { upgradeHandlers, cookie } = fixture(network.openTunnel);
        const socket = downstreamBoundary();
        let completed = false;
        const pending = Promise.resolve(upgradeHandlers[0]?.({
            url: '/@vite/client?v=1',
            headers: { host: HOST, cookie, upgrade: 'websocket', connection: 'Upgrade',
                'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
        }, socket, new Uint8Array())).then(() => { completed = true; });
        await socket.writing;
        expect(completed).toBe(false);
        socket.emit('drain');
        await pending;
        expect(socket.output.join('')).toContain('101 Switching Protocols');
        expect(network.writes.join('')).toContain('GET /@vite/client?v=1 HTTP/1.1');
    });

    it.each(['close', 'error'])('closes private WS error responses when downstream emits %s before drain', async (event) => {
        const { upgradeHandlers } = fixture();
        const socket = downstreamBoundary();
        const pending = Promise.resolve(upgradeHandlers[0]?.({
            url: '/socket', headers: { host: HOST },
        }, socket, new Uint8Array()));
        await socket.writing;
        socket.emit(event);
        await pending;
        expect(socket.destroyed).toBe(true);
        expect(socket.output.join('')).toContain('401 Unauthorized');
    });
});
