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
import { createLocalServicePublicRuntime } from '@/app/local/services/public/runtime';
import { createLocalServicePublicRateLimitChecker } from '@/app/local/services/public/rateLimits';
import type { OpenLocalServicePreviewTunnel } from '@/app/local/services/preview/httpAdapter';
import { createLocalServiceRouteRuntimes, registerLocalServiceRoutes } from '../registerRoutes';
import type { SessionAccessProjectionRow } from '@/app/session/access/sessionAccess';
import { LocalServicePreviewNativeDirectAccessV1Schema, LocalServicePreviewServerAccessV1Schema } from '@happier-dev/protocol/local/services/preview/nativeDirect';
import type { Fastify } from '@/app/api/types';
import { enableServeUi } from '@/app/api/utils/enableServeUi';
import { FEATURE_ENV_KEYS } from '@/app/features/catalog/featureEnvSchema';
import { peerMediationGrantSigningEnv } from '@/testkit/env';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import type { Server } from 'socket.io';

// Only database, HTTP router/socket and network tunnel boundaries are replaced.
const machineFindFirst = vi.hoisted(() => vi.fn(async (_query: unknown): Promise<{
    id: string; revokedAt?: Date | null; replacedByMachineId?: string | null;
    operationProtocolCapabilities?: MachineOperationProtocolCapabilitiesV1;
    operationProtocolCapabilitiesRevision?: number;
} | null> => ({ id: 'machine_1', revokedAt: null, replacedByMachineId: null })));
const sessionFindUnique = vi.hoisted(() => vi.fn(async (): Promise<SessionAccessProjectionRow | null> => null));
const machineFindUnique = vi.hoisted(() => vi.fn(async (_query: unknown): Promise<unknown> => null));
vi.mock('@/storage/db', () => {
    const boundary = { machine: { findFirst: machineFindFirst, findUnique: machineFindUnique }, session: { findUnique: sessionFindUnique } };
    return { db: { ...boundary, $transaction: async (callback: (tx: typeof boundary) => Promise<unknown>) => callback(boundary) } };
});

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
        machineFindFirst.mockReset().mockResolvedValue({ id: 'machine_1', revokedAt: null, replacedByMachineId: null });
        sessionFindUnique.mockReset().mockResolvedValue(null);
        machineFindUnique.mockReset().mockResolvedValue(null);
    });

    it('admits a shared current Machine viewer only against the actual current service and retires its registration', async () => {
        const target = { kind: 'managed_service', machineId: 'machine_1', managedServiceId: 'instance_1', cwd: '/workspace/app',
            declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest', name: 'web' } } };
        const resource = { ...preview, sessionId: undefined, owner: { kind: 'user', id: 'starter_1' }, serviceTarget: target };
        const account = (id: string) => ({ id, status: 'active', encryptionMode: 'plain', firstName: null, lastName: null, username: id, avatar: null });
        const facts = { id: 'machine_1', kind: 'persistent', accountId: 'user_1', installationId: 'installation_1', active: true,
            revokedAt: null, replacedByMachineId: null, metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
            metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'machine', platform: 'linux',
                happyCliVersion: '0.3', homeDir: '/home/user', happyHomeDir: '/home/user/.happier' })),
            dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), account: account('user_1'),
            accountGrants: ['starter_1', 'viewer_1'].map(accountId => ({ accountId, accessLevel: 'view', account: account(accountId) })),
            teamGrants: [], groupGrants: [] };
        machineFindUnique.mockResolvedValue(facts);
        machineFindFirst.mockResolvedValue({ id: 'machine_1', revokedAt: null, replacedByMachineId: null });
        let retire!: () => void;
        const retirement = new Promise<void>((resolve) => { retire = resolve; });
        const calls: Array<Record<string, unknown>> = [];
        const socket = { id: 'custodian_socket', data: { clientType: 'machine-scoped', userId: 'user_1', machineId: 'machine_1',
            verifiedMachineInstallationId: 'installation_1', accountStoredContentCompatibility: {
                supportsCurrentProtocol: true, supportsPluginDataProtocol: false, supportsSessionAccessWitnessProtocol: false,
                supportsMachinePoolChangeProtocol: false, supportsSavedSecretResourceChangeProtocol: false,
                outcome: 'accepted', declaration: { v: 1, protocolVersion: 2 }, upgradeRequired: null } },
            timeout: () => ({ emitWithAck: async (_event: string, raw: unknown) => {
                const request = raw as Record<string, unknown>;
                calls.push(request);
                const params = request.params as { kind: string };
                if (params.kind === 'wait_retirement') { await retirement; return { v: 1, kind: 'retired', instanceId: 'instance_1' }; }
                return { v: 1, kind: 'admitted', instanceId: 'instance_1', serviceTarget: target, starterAccountId: 'starter_1', endpoint: preview.target };
            } }) };
        const room = { timeout: () => room, fetchSockets: async () => [socket] };
        // Socket.IO and its returned acknowledgement are the network boundary; forwarding and admission remain real.
        const io = { in: () => room } as unknown as Server;
        eventRouter.setIo(io, { forwardRpc: request => forwardRpcCall({ ...request, io }) });
        const env = { ...peerMediationGrantSigningEnv(), HANDY_MASTER_SECRET: 'secret', HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true', HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'secret_link',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '60000', HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: '0',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: '1', [FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]: 'default',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: '1', [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: '5173' };
        const runtimes = createLocalServiceRouteRuntimes(env);
        const closeHooks: Array<() => Promise<void>> = [];
        const app = Object.assign(createFakeRouteApp(), { addHook(_name: string, hook: () => Promise<void>) { closeHooks.push(hook); } });
        registerLocalServiceRoutes(app as never, { env, runtimes });
        try {
            const reply = createReplyStub();
            await getRouteHandler(app, 'POST', '/v1/local-services/preview')({ userId: 'viewer_1', body: resource }, reply);
            expect(reply.statusCode).toBe(201);
            expect(reply.send.mock.calls[0]?.[0]).toMatchObject({ resource: { serviceTarget: target, owner: { kind: 'user', id: 'starter_1' } } });
            expect(calls[0]).toMatchObject({ authorization: { kind: 'localServices.preview.admission.serverOrigin' },
                machineAdmission: { actorAccountId: 'viewer_1', custodianAccountId: 'user_1', installationId: 'installation_1' } });
            const publicReply = createReplyStub();
            await getRouteHandler(app, 'POST', '/v1/local-services/public')({ userId: 'viewer_1', body: { machineId: resource.machineId,
                previewId: resource.previewId, serviceTarget: target, mode: 'secret_link', ttlMs: 60_000,
                confirmation: { acknowledged: true } } }, publicReply);
            expect(publicReply.statusCode).toBe(201);
            expect(publicReply.send.mock.calls[0]?.[0]).toMatchObject({ exposure: { serviceTarget: target, mode: 'secret_link' } });
            const exposed = publicReply.send.mock.calls[0]?.[0] as { exposure: { exposureId: string } };
            const wrongPublic = createReplyStub();
            await getRouteHandler(app, 'POST', '/v1/local-services/public')({ userId: 'viewer_1', body: { machineId: resource.machineId,
                previewId: resource.previewId, serviceTarget: { ...target, managedServiceId: 'another-instance' }, mode: 'secret_link', ttlMs: 60_000,
                confirmation: { acknowledged: true } } }, wrongPublic);
            expect(wrongPublic.statusCode).toBe(403);
            const status = createReplyStub();
            await getRouteHandler(app, 'POST', '/v1/local-services/public/status')({ userId: 'viewer_1', body: { machineId: resource.machineId,
                previewId: resource.previewId } }, status);
            expect(status.send.mock.calls[0]?.[0]).toMatchObject({ snapshot: { exposures: [{ exposureId: exposed.exposure.exposureId, serviceTarget: target }] } });
            const qualifiedStatus = createReplyStub();
            await getRouteHandler(app, 'POST', '/v1/local-services/public/status')({ userId: 'viewer_1', body: { machineId: resource.machineId,
                previewId: resource.previewId, serviceTarget: target } }, qualifiedStatus);
            expect(qualifiedStatus.send.mock.calls[0]?.[0]).toMatchObject({ snapshot: { exposures: [{ exposureId: exposed.exposure.exposureId, serviceTarget: target }] } });
            const wrongStatus = createReplyStub();
            await getRouteHandler(app, 'POST', '/v1/local-services/public/status')({ userId: 'viewer_1', body: { machineId: resource.machineId,
                previewId: resource.previewId, serviceTarget: { ...target, managedServiceId: 'another-instance' } } }, wrongStatus);
            expect(wrongStatus.statusCode).toBe(403);
            const wrongRevoke = createReplyStub();
            const revokeBody = { machineId: resource.machineId, previewId: resource.previewId, exposureId: exposed.exposure.exposureId, serviceTarget: target };
            await getRouteHandler(app, 'DELETE', '/v1/local-services/public/:exposureId')({ userId: 'viewer_1',
                params: { exposureId: exposed.exposure.exposureId }, body: { ...revokeBody, serviceTarget: { ...target, cwd: '/wrong/root' } } }, wrongRevoke);
            expect(wrongRevoke.statusCode).toBe(403);
            const revoke = createReplyStub();
            await getRouteHandler(app, 'DELETE', '/v1/local-services/public/:exposureId')({ userId: 'viewer_1',
                params: { exposureId: exposed.exposure.exposureId }, body: revokeBody }, revoke);
            expect(revoke.send.mock.calls[0]?.[0]).toEqual({ ok: true });
            expect(runtimes.public.resolveExposure(exposed.exposure.exposureId)?.state).toBe('revoked');
            const changed = createReplyStub();
            await getRouteHandler(app, 'POST', '/v1/local-services/preview')({ userId: 'viewer_1', body: { ...resource,
                target: { ...preview.target, port: 5174 } } }, changed);
            expect(changed.statusCode).toBe(403);
            machineFindFirst.mockImplementationOnce(async () => {
                // A real DB/network await can finish after C41 finalized the viewer's last grant.
                machineFindUnique.mockResolvedValue({ ...facts, accountGrants: facts.accountGrants.filter(grant => grant.accountId !== 'viewer_1') });
                eventRouter.disconnectMachineAndSessionSockets({ accountId: 'viewer_1', machineId: resource.machineId, sessionBindings: [] });
                return { id: resource.machineId, revokedAt: null, replacedByMachineId: null };
            });
            const lostDuringEndpointRead = createReplyStub();
            await getRouteHandler(app, 'POST', '/v1/local-services/preview')({ userId: 'viewer_1', body: resource }, lostDuringEndpointRead);
            expect(lostDuringEndpointRead.statusCode).toBe(403);
            retire();
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(runtimes.preview.resolvePreview(resource.previewId)).toBeNull();
        } finally {
            retire();
            for (const hook of closeHooks) await hook();
            eventRouter.clearIo();
        }
    });

    it('retires only a revoked Machine viewer token and stream while another viewer remains admitted', async () => {
        const env = { ...peerMediationGrantSigningEnv(), HANDY_MASTER_SECRET: 'secret', HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true', HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.happier.test',
            [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: '1', [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: '5173' };
        const runtimes = createLocalServiceRouteRuntimes(env);
        const native = { ...preview, sessionId: undefined, owner: { kind: 'user' as const, id: 'starter_1' },
            serviceTarget: { kind: 'managed_service' as const, machineId: preview.machineId, managedServiceId: 'instance_1', cwd: '/workspace/app',
                declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } } };
        const binding = { previewId: native.previewId, machineId: native.machineId, sessionId: undefined };
        const admit = (viewerAccountId: string) => {
            const result = runtimes.preview.registerPreview({ resource: native, accountId: 'starter_1', viewerAccountId });
            if (!result.ok || !result.accessUrl) throw new Error('Viewer admission unavailable');
            const exchanged = runtimes.preview.exchangeAccessToken({ ...binding, rawToken: new URL(result.accessUrl).searchParams.get('previewToken') });
            if (!exchanged.ok) throw new Error(exchanged.reasonCode);
            return exchanged.rawToken;
        };
        const revoked = admit('viewer_1');
        const retained = admit('viewer_2');
        let finish!: () => void;
        const closed = new Promise<void>((resolve) => { finish = resolve; });
        const openTunnel: OpenLocalServicePreviewTunnel = async () => ({ tunnelId: 'tunnel', substreamId: 'stream',
            write() {}, endWrite() {}, close: finish, abort: finish,
            async *read() { yield new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhello'); await closed; } });
        const closeHooks: Array<() => Promise<void>> = [];
        const app = Object.assign(createFakeRouteApp(), { addHook(_name: string, hook: () => Promise<void>) { closeHooks.push(hook); } });
        registerLocalServiceRoutes(app as never, { env, runtimes, openTunnel });
        const raw = downstreamBoundary();
        const pending = getRouteHandler(app, 'GET', '/*')({ params: { '*': '' }, headers: { host: HOST,
            cookie: `happier_preview_token=${revoked}` } }, { ...createReplyStub(), raw });
        try {
            expect(await Promise.race([raw.writing.then(() => 'opened'), pending.then(() => 'refused')])).toBe('opened');
            raw.emit('drain');
            expect(raw.output.join('')).toContain('hello');
            eventRouter.disconnectMachineAndSessionSockets({ accountId: 'viewer_1', machineId: native.machineId, sessionBindings: [] });
            expect(raw.destroyed).toBe(true);
            expect(runtimes.preview.validateAccess({ ...binding, rawToken: revoked }).ok).toBe(false);
            expect(runtimes.preview.validateAccess({ ...binding, rawToken: retained })).toEqual({ ok: true });
            expect(runtimes.preview.resolvePreview(native.previewId)).not.toBeNull();
            await pending;
        } finally { raw.destroy(); finish(); await pending; for (const hook of closeHooks) await hook(); }
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
            where: { id: 'machine_1', accountId: 'user_1' }, select: { revokedAt: true, replacedByMachineId: true },
        });
        machineFindFirst.mockResolvedValueOnce(null);
        const denied = createReplyStub();
        await handler({ userId: 'user_2', body: { ...resource, previewId: 'other', owner: { kind: 'user', id: 'user_2' } } }, denied);
        expect(denied.statusCode).toBe(403);
        expect(runtime.resolvePreview('other')).toBeNull();
    });

    it.each([
        { revokedAt: new Date(1_000), replacedByMachineId: null },
        { revokedAt: null, replacedByMachineId: 'replacement-machine' },
    ])('refuses sessionless registration and fresh access on an unavailable Machine ($replacedByMachineId)', async (state) => {
        const { app, runtime } = fixture();
        const { sessionId: _sessionId, ...machinePreview } = preview;
        const resource: LocalServicePreviewResourceV1 = {
            ...machinePreview, previewId: 'machine-preview', owner: { kind: 'user', id: 'user_1' },
        };
        machineFindFirst.mockResolvedValue({ id: 'machine_1', ...state });
        const registration = createReplyStub();
        await getRouteHandler(app, 'POST', '/v1/local-services/preview')({ userId: 'user_1', body: resource }, registration);
        expect(registration.statusCode).toBe(403);
        expect(runtime.resolvePreview(resource.previewId)).toBeNull();

        // A retained registration does not authorize a fresh token after its Machine retires.
        expect(runtime.registerPreview({ resource, accountId: 'user_1' }).ok).toBe(true);
        const access = createReplyStub();
        await getRouteHandler(app, 'POST', '/v1/local-services/preview/:previewId/access')({
            userId: 'user_1', params: { previewId: resource.previewId }, body: { v: 1, kind: 'server_preview' },
        }, access);
        expect(access.statusCode).toBe(403);
        expect(access.send).toHaveBeenCalledWith({ error: 'preview_access_denied', reasonCode: 'session_not_authorized' });
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

    it.each([
        ['private', 'http'], ['private', 'websocket'], ['public', 'http'], ['public', 'websocket'],
        ['private', 'websocket_handshake'], ['public', 'websocket_handshake'],
        ['public_source', 'http'], ['public_source', 'websocket'],
    ] as const)('retires an active %s %s stream when its registration is revoked', async (scope, kind) => {
        let tunnelRetired = false;
        let finishTunnel!: () => void;
        const tunnelClosed = new Promise<void>((resolve) => { finishTunnel = resolve; });
        let requestSent!: () => void;
        const sent = new Promise<void>((resolve) => { requestSent = resolve; });
        const retireTunnel = () => { tunnelRetired = true; finishTunnel(); };
        const openTunnel: OpenLocalServicePreviewTunnel = async () => ({
            tunnelId: 'tunnel', substreamId: 'active-stream',
            write() { requestSent(); }, endWrite() {}, close: retireTunnel, abort: retireTunnel,
            async *read() {
                if (kind === 'websocket_handshake') { await tunnelClosed; return; }
                yield new TextEncoder().encode(kind === 'http'
                    ? 'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhello'
                    : 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
                await tunnelClosed;
            },
        });
        const { runtime, cookie: privateCookie } = fixture();
        const publicRuntime = createLocalServicePublicRuntime({
            tokenSecret: 'secret', publicBaseUrl: 'https://app.happier.test', hostOriginBaseDomain: 'preview.happier.test',
            policy: { enabled: true, allowedModes: ['secret_link'], maxTtlMs: 60_000, dnsTlsRequired: false, auditRequired: true },
            nowMs: () => 1_000, resolvePreview: runtime.resolvePreview,
            allowTestDevAuditSink: true,
            // Audit persistence is the only replaced boundary; admission and rate limiting stay real.
            recordAuditEvent() {},
            checkRateLimit: createLocalServicePublicRateLimitChecker({ kind: 'fixed_window', windowMs: 60_000, maxRequests: 100 }),
        });
        const created = publicRuntime.createExposure({ preview, requestedMode: 'secret_link', requestedTtlMs: 60_000,
            actorId: 'user_1', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });
        if (!created.ok) throw new Error(created.reasonCode);
        const exposureId = created.exposure.exposureId;
        const exchanged = publicRuntime.exchangeAccessToken({ exposureId,
            rawToken: new URL(created.exposure.publicUrl).searchParams.get('publicToken') });
        if (!exchanged.ok) throw new Error(exchanged.reasonCode);
        const cookie = scope === 'private' ? privateCookie : `happier_public_token=${exchanged.rawToken}`;
        const upgradeHandlers: Array<(request: unknown, socket: unknown, head: Uint8Array) => unknown> = [];
        const app = Object.assign(createFakeRouteApp(), {
            server: { on(event: string, handler: (request: unknown, socket: unknown, head: Uint8Array) => unknown) {
                if (event === 'upgrade') upgradeHandlers.push(handler);
            } },
        });
        const env = { ...peerMediationGrantSigningEnv(), HANDY_MASTER_SECRET: 'secret', HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'secret_link',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '60000',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: '0',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: '1',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]: 'default',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: '5173',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.happier.test' };
        registerLocalServiceRoutes(app as never, { env, runtimes: { preview: runtime, public: publicRuntime }, openTunnel });
        const raw = downstreamBoundary();
        let closeClient!: () => void;
        const clientClosed = new Promise<void>((resolve) => { closeClient = resolve; });
        const socket = Object.assign(raw, {
            async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
                await clientClosed;
                throw new Error('client_closed');
            },
        });
        socket.on('close', closeClient);
        const headers = { host: HOST, cookie };
        const pending = kind === 'http'
            ? getRouteHandler(app, 'GET', scope === 'private' ? '/*' : '/v1/local-services/public/:exposureId/*')({
                params: { '*': '', exposureId }, headers,
            }, { ...createReplyStub(), raw })
            : Promise.resolve(upgradeHandlers[scope === 'private' ? 0 : 1]?.({
                url: scope === 'private' ? '/socket' : `/v1/local-services/public/${exposureId}/socket`, headers: {
                host: HOST, cookie, upgrade: 'websocket', connection: 'Upgrade',
                'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
            } }, socket, new Uint8Array()));
        try {
            const opening = kind === 'websocket_handshake' ? sent : raw.writing;
            expect(await Promise.race([opening.then(() => 'opened'), pending.then(() => 'refused')])).toBe('opened');
            if (kind !== 'websocket_handshake') {
                raw.emit('drain');
                expect(raw.output.join('')).toContain(kind === 'http' ? 'hello' : '101 Switching Protocols');
            }
            expect(scope !== 'public' ? runtime.unregisterPreview(preview.previewId)
                : publicRuntime.revokeExposure(exposureId, { actorId: 'user_1' })).toEqual({ ok: true });
            expect(raw.destroyed).toBe(true);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(tunnelRetired).toBe(true);
            await pending;
        } finally {
            raw.destroy();
            finishTunnel();
            await pending;
        }
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
