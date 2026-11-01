import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { LocalServicePreviewResourceV1, MachineOperationProtocolCapabilitiesV1 } from '@happier-dev/protocol';
import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler } from '@/app/api/testkit/routeHarness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLocalServicePreviewRoutes } from './registerRoutes';
import { startSocket } from '@/app/api/socket';
import { createLocalServicePreviewRuntime } from '@/app/local/services/preview/runtime';
import { createLocalServicePublicRuntime } from '@/app/local/services/public/runtime';
import { createLocalServicePublicRateLimitChecker } from '@/app/local/services/public/rateLimits';
import { DaemonLocalServicePublicPreviewStatusResponseV1Schema, LocalServicePublicExposureV1Schema } from '@happier-dev/protocol/local/services/public/v1';
import type { OpenLocalServicePreviewTunnel } from '@/app/local/services/preview/httpAdapter';
import { createLocalServiceRouteRuntimes, registerLocalServiceRoutes } from '../registerRoutes';
import type { SessionAccessProjectionRow } from '@/app/session/access/sessionAccess';
import { LocalServicePreviewNativeDirectAccessV1Schema, LocalServicePreviewServerAccessV1Schema } from '@happier-dev/protocol/local/services/preview/nativeDirect';
import type { Fastify } from '@/app/api/types';
import { enableServeUi } from '@/app/api/utils/enableServeUi';
import { enableApiCompression } from '@/app/api/utils/enableApiCompression';
import { FEATURE_ENV_KEYS } from '@/app/features/catalog/featureEnvSchema';
import { peerMediationGrantSigningEnv } from '@/testkit/env';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import { resolveRpcForwardTimeoutMs } from '@/app/api/socket/rpc/rpcForwardTimeout';
import type { Server } from 'socket.io';
import * as logging from '@/utils/logging/log';

// Only database, HTTP router/socket and network tunnel boundaries are replaced.
const machineFindFirst = vi.hoisted(() => vi.fn(async (_query: unknown): Promise<{
    id: string; revokedAt?: Date | null; replacedByMachineId?: string | null;
    operationProtocolCapabilities?: MachineOperationProtocolCapabilitiesV1;
    operationProtocolCapabilitiesRevision?: number;
} | null> => ({ id: 'machine_1', revokedAt: null, replacedByMachineId: null })));
const sessionFindUnique = vi.hoisted(() => vi.fn(async (): Promise<SessionAccessProjectionRow | null> => null));
const machineFindUnique = vi.hoisted(() => vi.fn(async (_query: unknown): Promise<unknown> => null));
const homeSettingsFindUnique = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('@/storage/db', async () => {
    const { createDbTransactionMock, inTxPostgresControlStatementMock } = await import('@/app/api/testkit/dbMocks');
    const { homeConfigSnapshotPostgresQueryMock } = await import('@/app/home/settings/homeConfigSnapshot.testkit');
    const boundary = { ...inTxPostgresControlStatementMock, ...homeConfigSnapshotPostgresQueryMock,
        machine: { findFirst: machineFindFirst, findUnique: machineFindUnique,
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                (await Promise.all(where.id.in.map(id => machineFindUnique({ where: { id } })))).filter(row => row !== null),
        }, session: { findUnique: sessionFindUnique },
        homeSettings: { findUnique: homeSettingsFindUnique }, homeGovernancePolicy: { findUnique: async () => null } };
    return { db: createDbTransactionMock(() => boundary).wrapDb(boundary) };
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
        homeSettingsFindUnique.mockReset().mockResolvedValue(null);
    });

    it('keeps local services isolated when stored-content subpath opt-in is enabled', () => {
        const env = { HANDY_MASTER_SECRET: 'secret', HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test',
            HAPPIER_PUBLIC_SHARES_ALLOW_SUBPATH: '1',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'secret_link',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '60000',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: '0',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: '1',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]: 'default',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: '1' };
        const runtimes = createLocalServiceRouteRuntimes(env);
        expect(runtimes.preview.registerPreview({ resource: preview, accountId: 'user_1' }))
            .toMatchObject({ ok: true, accessUrl: null });
        expect(runtimes.public.createExposure({ preview, requestedMode: 'secret_link', requestedTtlMs: 60_000,
            actorId: 'user_1', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' }))
            .toEqual({ ok: false, reasonCode: 'public_origin_unavailable' });
        expect(runtimes.public.getSnapshot({ machineId: preview.machineId, previewId: preview.previewId }).exposures).toEqual([]);
    });

    it('admits each distinct Service or Session once per machine-wide public status request while filtering denied links', async () => {
        const account = { id: 'user_1', status: 'active', encryptionMode: 'plain' };
        machineFindUnique.mockResolvedValue({ id: 'machine_1', kind: 'persistent', accountId: account.id,
            installationId: 'installation_1', active: true, revokedAt: null, replacedByMachineId: null,
            metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
            metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'machine', platform: 'linux',
                happyCliVersion: '0.3', homeDir: '/home/user', happyHomeDir: '/home/user/.happier' })),
            dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), account,
            accountGrants: [], teamGrants: [], groupGrants: [] });
        const resource: LocalServicePreviewResourceV1 = { ...preview, sessionId: undefined,
            owner: { kind: 'user', id: 'user_1' }, serviceTarget: { kind: 'managed_service', machineId: 'machine_1',
                managedServiceId: 'instance_1', cwd: '/workspace/app',
                declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest', name: 'web' } } } };
        const deniedResource: LocalServicePreviewResourceV1 = { ...resource, previewId: 'preview_denied',
            serviceTarget: { ...resource.serviceTarget!, managedServiceId: 'instance_denied' } };
        const mismatchedResource: LocalServicePreviewResourceV1 = { ...resource,
            serviceTarget: { ...resource.serviceTarget!, cwd: '/different/workspace' } };
        const sessionResource: LocalServicePreviewResourceV1 = { ...preview, previewId: 'preview_session' };
        sessionFindUnique.mockResolvedValue(sharedSession);
        const admittedTargets: string[] = [];
        let deniedServiceAvailable = false;
        const socket = { id: 'custodian_socket', data: { clientType: 'machine-scoped', userId: 'user_1', machineId: 'machine_1',
            verifiedMachineInstallationId: 'installation_1', accountStoredContentCompatibility: {
                supportsCurrentProtocol: true, supportsPluginDataProtocol: false, supportsSessionAccessWitnessProtocol: false,
                supportsMachinePoolChangeProtocol: false, supportsSavedSecretResourceChangeProtocol: false,
                outcome: 'accepted', declaration: { v: 1, protocolVersion: 2 }, upgradeRequired: null } },
            timeout: () => ({ emitWithAck: async (_event: string, raw: unknown) => {
                const request = raw as { params: { target: { managedServiceId: string } } };
                const id = request.params.target.managedServiceId;
                admittedTargets.push(id);
                const candidate = id === 'instance_denied' ? deniedResource : resource;
                return id === 'instance_denied' && !deniedServiceAvailable ? { v: 1, kind: 'refused', reasonCode: 'service_unavailable' }
                    : { v: 1, kind: 'admitted', instanceId: id, serviceTarget: candidate.serviceTarget,
                        starterAccountId: 'user_1', endpoint: candidate.target };
            } }) };
        const room = { timeout: () => room, fetchSockets: async () => [socket], emit() {}, disconnectSockets() {} };
        // Socket.IO acknowledgements and Prisma are the only replaced system boundaries.
        const io = { in: () => room, to: () => room, sockets: { adapter: { rooms: new Map() }, sockets: new Map() } } as unknown as Server;
        eventRouter.setIo(io, { forwardRpc: request => forwardRpcCall({ ...request, io }) });
        const env = { ...peerMediationGrantSigningEnv(), HANDY_MASTER_SECRET: 'secret', HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'public',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '60000',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: '0',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: '1',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]: 'default',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: '5173',
            [FEATURE_ENV_KEYS.machinesTunnelDirectPeerEnabled]: '1' };
        const runtimes = createLocalServiceRouteRuntimes(env);
        const closeHooks: Array<() => Promise<void>> = [];
        const app = Object.assign(createFakeRouteApp(), { addHook(_name: string, hook: () => Promise<void>) { closeHooks.push(hook); } });
        registerLocalServiceRoutes(app as never, { env, runtimes });
        try {
            for (const candidate of [resource, deniedResource, sessionResource]) {
                expect(runtimes.preview.registerPreview({ resource: candidate, accountId: 'user_1' }).ok).toBe(true);
            }
            const links = [resource, resource, resource, sessionResource, sessionResource, sessionResource,
                deniedResource, deniedResource, mismatchedResource].map(candidate => {
                const result = runtimes.public.createExposure({ preview: candidate, requestedMode: 'public', requestedTtlMs: 60_000,
                    actorId: 'user_1', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });
                if (!result.ok) throw new Error(result.reasonCode);
                return result.exposure;
            });
            const handler = getRouteHandler(app, 'POST', '/v1/local-services/public/status');
            for (let requestIndex = 0; requestIndex < 2; requestIndex++) {
                deniedServiceAvailable = requestIndex === 1;
                admittedTargets.length = 0;
                sessionFindUnique.mockClear();
                const reply = createReplyStub();
                await handler({ userId: 'user_1', body: { machineId: 'machine_1' } }, reply);
                expect(reply.statusCode).toBe(200);
                const response = DaemonLocalServicePublicPreviewStatusResponseV1Schema.parse(reply.send.mock.calls[0]?.[0]);
                const expectedLinks = links.slice(0, deniedServiceAvailable ? 8 : 6);
                expect(response.snapshot.exposures).toHaveLength(expectedLinks.length);
                expect(response.snapshot.exposures).toEqual(expect.arrayContaining(expectedLinks));
                expect(admittedTargets.sort()).toEqual(['instance_1', 'instance_denied']);
                expect(sessionFindUnique).toHaveBeenCalledTimes(1);
            }
        } finally {
            for (const hook of closeHooks) await hook();
            eventRouter.clearIo();
        }
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
            timeout: (timeoutMs: number) => ({ emitWithAck: async (_event: string, raw: unknown) => {
                const request = raw as Record<string, unknown>;
                calls.push(request);
                const params = request.params as { kind: string };
                if (params.kind === 'wait_retirement') {
                    // Socket.IO is the boundary: honor its ACK deadline rather than returning
                    // an immortal promise that hides the production registration timeout.
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try {
                        await Promise.race([retirement, new Promise<never>((_resolve, reject) => {
                            timer = setTimeout(() => reject(new Error('operation has timed out')), timeoutMs);
                        })]);
                    } finally { clearTimeout(timer); }
                    return { v: 1, kind: 'retired', instanceId: 'instance_1' };
                }
                return { v: 1, kind: 'admitted', instanceId: 'instance_1', serviceTarget: target, starterAccountId: 'starter_1', endpoint: preview.target };
            } }) };
        const room = { timeout: () => room, fetchSockets: async () => [socket] };
        // Socket.IO and its returned acknowledgement are the network boundary; forwarding and admission remain real.
        // The custodian is only reachable through the cluster census: this process holds no local room members.
        const io = { in: () => room, sockets: { adapter: { rooms: new Map() }, sockets: new Map() } } as unknown as Server;
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
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const reply = createReplyStub();
            await getRouteHandler(app, 'POST', '/v1/local-services/preview')({ userId: 'viewer_1', body: resource }, reply);
            expect(reply.statusCode).toBe(201);
            expect(reply.send.mock.calls[0]?.[0]).toMatchObject({ resource: { serviceTarget: target, owner: { kind: 'user', id: 'starter_1' } } });
            expect(calls[0]).toMatchObject({ authorization: { kind: 'localServices.preview.admission.serverOrigin' },
                machineAdmission: { actorAccountId: 'viewer_1', custodianAccountId: 'user_1', installationId: 'installation_1' } });
            await new Promise<void>(resolve => setImmediate(resolve));
            const ordinaryDeadline = resolveRpcForwardTimeoutMs();
            if (ordinaryDeadline === null) throw new Error('Fixture requires the ordinary finite Home RPC deadline');
            await vi.advanceTimersByTimeAsync(ordinaryDeadline + 1);
            expect(runtimes.preview.resolvePreview(resource.previewId)).toEqual(resource);
            vi.useRealTimers();
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
            vi.useRealTimers();
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
            expect(await Promise.race([raw.writing.then(() => 'opened'), Promise.resolve(pending).then(() => 'refused')])).toBe('opened');
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

            // The pane's state probe reads the proxy's typed refusal, so an ended preview can say so. Only
            // the parent its own collector identity names may read it; any other origin gets no CORS grant.
            const appOrigin = 'https://app.happier.test';
            const collector = encodeURIComponent(JSON.stringify({ browserSessionId: 'bs', viewId: 'v', navigationGeneration: 0,
                collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' }, webPostMessageTargetOrigin: appOrigin }));
            const probe = (host: string, origin: string) => app.inject({ method, url: `/?__happierCollector=${collector}&__happierCollectorState=1`, headers: { host, origin } });
            for (const [host, status] of [['unknown.preview.happier.test', 404], [HOST, 401]] as const) {
                const read = await probe(host, appOrigin);
                expect(read.statusCode).toBe(status);
                expect(read.headers['access-control-allow-origin']).toBe(appOrigin);
                expect(read.headers['access-control-allow-credentials']).toBe('true');
                expect((await probe(host, 'https://elsewhere.test')).headers['access-control-allow-origin']).toBeUndefined();
            }
            expect((await injectPreview('/', 'unknown.preview.happier.test')).headers['access-control-allow-origin']).toBeUndefined();

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

    it('serves independently minted private viewers and a public link through real registration, exchange and access routes', async () => {
        sessionFindUnique.mockResolvedValue(sharedSession);
        const env = { ...peerMediationGrantSigningEnv(), HANDY_MASTER_SECRET: 'test-master-secret',
            HAPPIER_MANAGED_RELAY_PURPOSE: 'personal-home', HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'secret_link',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '60000',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: '0',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: '1',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]: 'default',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: '5173' };
        const network = tunnelBoundary('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\n\r\nok');
        const app = fastify({ logger: false });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Authentication and the persistent Session/Machine reads are external boundaries.
        app.decorate('authenticate', async (request: object) => {
            Reflect.set(request, 'userId', 'user_1');
            Reflect.set(request, 'authAuthority', 'present_user');
        });
        registerLocalServiceRoutes(app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify, {
            env, openTunnel: network.openTunnel,
        });
        try {
            const registered = await app.inject({ method: 'POST', url: '/v1/local-services/preview', payload: preview });
            expect(registered.statusCode).toBe(201);
            const firstUrl = new URL(registered.json<{ accessUrl: string }>().accessUrl);
            const acquire = async () => {
                const response = await app.inject({ method: 'POST', url: `/v1/local-services/preview/${preview.previewId}/access`,
                    payload: { v: 1, kind: 'server_preview' } });
                expect(response.statusCode).toBe(200);
                return new URL(LocalServicePreviewServerAccessV1Schema.parse(response.json()).accessUrl);
            };
            const secondUrl = await acquire();
            expect(secondUrl.searchParams.get('previewToken')).not.toBe(firstUrl.searchParams.get('previewToken'));
            const open = async (url: URL) => {
                const response = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: url.host } });
                expect(response.statusCode).toBe(303);
                expect(response.headers.location).not.toContain('previewToken');
                // The HTTPS preview is embedded under a different top-level site. Lax
                // cookies are rejected there; partitioning keeps admission scoped to that viewer.
                const attributes = String(response.headers['set-cookie']).split(';').slice(1).map((part) => part.trim());
                expect(attributes).toEqual(expect.arrayContaining(['Path=/', 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned']));
                expect(attributes.some((part) => part.startsWith('Domain='))).toBe(false);
                const cookie = String(response.headers['set-cookie']).split(';')[0]!;
                const loaded = await app.inject({ method: 'GET', url: String(response.headers.location), headers: { host: url.host, cookie } });
                expect(loaded.statusCode).toBe(200);
                expect(loaded.body).toBe('ok');
                return cookie;
            };
            const firstCookie = await open(firstUrl);
            const secondCookie = await open(secondUrl);
            await acquire();
            for (const cookie of [firstCookie, secondCookie]) {
                const reload = await app.inject({ method: 'GET', url: '/', headers: { host: firstUrl.host, cookie } });
                expect(reload.statusCode).toBe(200);
                expect(reload.body).toBe('ok');
            }
            const replay = await app.inject({ method: 'GET', url: firstUrl.pathname + firstUrl.search, headers: { host: firstUrl.host } });
            expect(replay.statusCode).toBe(401);
            expect(replay.json()).toEqual({ error: 'preview_access_denied', reasonCode: 'token_mismatch' });
            const admittedReplay = await app.inject({ method: 'GET', url: firstUrl.pathname + firstUrl.search,
                headers: { host: firstUrl.host, cookie: firstCookie } });
            expect(admittedReplay.statusCode).toBe(303);
            expect(admittedReplay.headers['set-cookie']).toBeUndefined();
            expect(admittedReplay.headers.location).not.toContain('previewToken');
            const exposed = await app.inject({ method: 'POST', url: '/v1/local-services/public', payload: {
                previewId: preview.previewId, machineId: preview.machineId, sessionId: preview.sessionId,
                mode: 'secret_link', ttlMs: 60_000, confirmation: { acknowledged: true },
            } });
            expect(exposed.statusCode).toBe(201);
            const exposure = LocalServicePublicExposureV1Schema.parse(exposed.json<{ exposure: unknown }>().exposure);
            const publicUrl = new URL(exposure.publicUrl);
            expect(publicUrl.origin).not.toBe(firstUrl.origin);
            const exchanged = await app.inject({ method: 'GET', url: publicUrl.pathname + publicUrl.search, headers: { host: publicUrl.host } });
            expect(exchanged.statusCode).toBe(303);
            expect(exchanged.headers.location).not.toContain('publicToken');
            const publicAttributes = String(exchanged.headers['set-cookie']).split(';').slice(1).map((part) => part.trim());
            expect(publicAttributes).toEqual(expect.arrayContaining([
                'Path=/', 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned',
            ]));
            expect(publicAttributes.some((part) => part.startsWith('Domain='))).toBe(false);
            const publicHeaders = { host: publicUrl.host, cookie: String(exchanged.headers['set-cookie']).split(';')[0]! };
            const publicLoaded = await app.inject({ method: 'GET', url: String(exchanged.headers.location), headers: publicHeaders });
            expect(publicLoaded.statusCode).toBe(200);
            expect(publicLoaded.body).toBe('ok');
            const freshUrl = await acquire();
            env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED = '0';
            const disabledAdmission = await app.inject({ method: 'GET', url: freshUrl.pathname + freshUrl.search,
                headers: { host: freshUrl.host } });
            expect(disabledAdmission.statusCode).toBe(404);
            expect(disabledAdmission.headers['set-cookie']).toBeUndefined();
            for (const method of ['GET', 'HEAD', 'POST'] as const) {
                const disabledBody = await app.inject({ method, url: '/', headers: { host: firstUrl.host, cookie: firstCookie } });
                expect(disabledBody.statusCode).toBe(404);
                expect(disabledBody.body).not.toBe('ok');
            }
            const disabledPublic = await app.inject({ method: 'GET', url: String(exchanged.headers.location), headers: publicHeaders });
            expect(disabledPublic.statusCode).toBe(404);
            env.HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED = 'true';
            await open(freshUrl);
            const recoveredPublic = await app.inject({ method: 'GET', url: String(exchanged.headers.location), headers: publicHeaders });
            expect(recoveredPublic.statusCode).toBe(200);
            const publicRevoke = await app.inject({ method: 'DELETE', url: `/v1/local-services/public/${exposure.exposureId}`, payload: {
                previewId: preview.previewId, machineId: preview.machineId, sessionId: preview.sessionId, exposureId: exposure.exposureId,
            } });
            expect(publicRevoke.statusCode).toBe(200);
            const publicRetired = await app.inject({ method: 'GET', url: String(exchanged.headers.location), headers: publicHeaders });
            expect(publicRetired.statusCode).toBe(403);
            expect(publicRetired.json()).toEqual({ error: 'public_preview_access_denied', reasonCode: 'revoked' });
            const revoke = await app.inject({ method: 'DELETE', url: `/v1/local-services/preview/${preview.previewId}` });
            expect(revoke.statusCode).toBe(200);
            const retired = await app.inject({ method: 'GET', url: '/', headers: { host: firstUrl.host, cookie: secondCookie } });
            expect(retired.statusCode).toBe(404);
        } finally { await app.close(); }
    });

    it.each([
        { kind: 'private', failCleanup: true }, { kind: 'public', failCleanup: true },
        { kind: 'private', failCleanup: false }, { kind: 'public', failCleanup: false },
    ] as const)('contains a failure after the first SSE bytes at the real $kind HTTP ingress (failed cleanup: $failCleanup) and keeps serving', async ({ kind, failCleanup }) => {
        const env = { ...peerMediationGrantSigningEnv(), HANDY_MASTER_SECRET: 'test-master-secret',
            HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'secret_link',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '60000',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: '0',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: '1',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]: 'default',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: '5173' };
        const runtimes = createLocalServiceRouteRuntimes(env);
        const registered = runtimes.preview.registerPreview({ resource: preview, accountId: 'user_1' });
        if (!registered.ok || !registered.accessUrl) throw new Error('preview registration failed');
        const exposure = runtimes.public.createExposure({ preview, requestedMode: 'secret_link', requestedTtlMs: 60_000,
            actorId: 'user_1', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });
        if (!exposure.ok) throw new Error('public exposure failed');
        const url = new URL(kind === 'private' ? registered.accessUrl : exposure.exposure.publicUrl);
        let failAfterBytes = () => {};
        const bytesReceived = new Promise<void>(resolve => { failAfterBytes = resolve; });
        const storageError = Object.assign(new Error('private storage failure'), { code: 'P2024' });
        // The tunnel is a real external transport boundary. Its failure and failed cleanup
        // exercise the real HTTP adapter, sink, route and Fastify error lifecycle.
        let failing = true;
        const openTunnel: OpenLocalServicePreviewTunnel = async () => failing ? {
            tunnelId: 'tunnel', substreamId: 'stream', write() {}, endWrite() {},
            async *read() {
                yield new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: first\n\n');
                await bytesReceived;
                throw new Error('upstream disconnected');
            },
            abort() {},
            async close() { if (failCleanup) throw storageError; },
        } : await tunnelBoundary('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok').openTunnel({ preview });
        const log = vi.spyOn(logging, 'log').mockImplementation(() => {});
        const rejections: unknown[] = [];
        let rejected = () => {};
        const onUnhandled = (reason: unknown) => { rejections.push(reason); rejected(); };
        process.on('unhandledRejection', onUnhandled);
        const app = fastify({ logger: false });
        app.decorate('authenticate', async () => {});
        registerLocalServiceRoutes(app as unknown as Fastify, { env, runtimes, openTunnel });
        let socket: ReturnType<typeof connect> | undefined;
        try {
            const exchange = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: url.host } });
            expect(exchange.statusCode).toBe(303);
            const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
            const listener = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));
            socket = connect(Number(listener.port), '127.0.0.1');
            let response = '';
            const closed = new Promise<void>(resolve => {
                socket!.on('error', () => resolve());
                socket!.on('close', () => resolve());
                socket!.on('data', chunk => {
                    response += chunk.toString();
                    if (response.includes('data: first')) failAfterBytes();
                });
                socket!.on('connect', () => socket!.write(`GET /sse HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`));
            });
            const unhandled = new Promise<void>(resolve => { rejected = resolve; });
            await Promise.race([closed, unhandled]);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(response).toContain('data: first');
            expect(rejections).toEqual([]);
            expect(socket.destroyed).toBe(true);
            if (failCleanup) {
                expect(log.mock.calls.some(([context]) => typeof context === 'object' && context !== null
                    && Reflect.get(context, 'errorCode') === 'P2024')).toBe(true);
            }
            failing = false;
            const recovered = await app.inject({ method: 'GET', url: '/', headers: { host: url.host, cookie } });
            expect(recovered.statusCode).toBe(200);
            expect(recovered.body).toBe('ok');
            expect(rejections).toEqual([]);
        } finally {
            failAfterBytes();
            socket?.destroy();
            await app.close();
            process.off('unhandledRejection', onUnhandled);
            log.mockRestore();
        }
    });

    it.each(['private', 'public'] as const)('contains a rejected Home read at the real %s upgrade ingress and recovers', async (kind) => {
        const env = { ...peerMediationGrantSigningEnv(), HANDY_MASTER_SECRET: 'test-master-secret',
            HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'secret_link',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '60000',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: '0',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: '1',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]: 'default',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: '5173' };
        const runtimes = createLocalServiceRouteRuntimes(env);
        const registered = runtimes.preview.registerPreview({ resource: preview, accountId: 'user_1' });
        if (!registered.ok || !registered.accessUrl) throw new Error('preview registration failed');
        const exposure = runtimes.public.createExposure({ preview, requestedMode: 'secret_link', requestedTtlMs: 60_000,
            actorId: 'user_1', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });
        if (!exposure.ok) throw new Error('public exposure failed');
        const url = new URL(kind === 'private' ? registered.accessUrl : exposure.exposure.publicUrl);
        const network = tunnelBoundary('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
        const app = fastify({ logger: false });
        app.decorate('authenticate', async () => {});
        const upgradeSockets = new Set<Duplex>();
        app.server.on('upgrade', (_request, socket) => {
            upgradeSockets.add(socket);
            socket.on('close', () => upgradeSockets.delete(socket));
        });
        const rejections: unknown[] = [];
        let rejected = (_reason: unknown) => {};
        const onUnhandled = (reason: unknown) => { rejections.push(reason); rejected(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
            for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
            vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
            // Exercise the real request Home overlay and transaction owner; only DB rows are replaced.
            registerLocalServiceRoutes(app as unknown as Fastify, { runtimes, openTunnel: network.openTunnel });
            const exchange = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: url.host } });
            expect(exchange.statusCode).toBe(303);
            const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
            const listener = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));
            const upgrade = async () => {
                const socket = connect(Number(listener.port), '127.0.0.1');
                let response = '';
                const completed = new Promise<string>((resolve, reject) => {
                    socket.on('error', reject);
                    socket.on('close', () => resolve(response));
                    socket.on('data', chunk => {
                        response += chunk.toString();
                        if (response.includes('\r\n\r\n')) resolve(response);
                    });
                    socket.on('connect', () => socket.write(`GET /socket HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
                });
                const unhandled = new Promise<string>(resolve => { rejected = () => resolve('unhandled-rejection'); });
                try { return await Promise.race([completed, unhandled]); }
                finally { socket.destroy(); }
            };
            homeSettingsFindUnique.mockRejectedValue(new Error('home-config-read-refused'));
            const refused = await upgrade();
            expect(refused).not.toBe('unhandled-rejection');
            expect(refused).not.toContain('101 Switching Protocols');
            expect(rejections).toEqual([]);
            homeSettingsFindUnique.mockResolvedValue(null);
            expect(await upgrade()).toContain('101 Switching Protocols');
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(rejections).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            for (const socket of upgradeSockets) socket.destroy();
            await app.close();
            vi.unstubAllEnvs();
        }
    });

    it.each([
        { contentType: 'text/event-stream', first: 'data: first\n\n' },
        { contentType: 'application/json', first: '{"rows":[' },
    ])('streams private $contentType bytes and releases the relay tunnel on browser cancellation', async ({ contentType, first }) => {
        const env = { ...peerMediationGrantSigningEnv(), HANDY_MASTER_SECRET: 'test-master-secret',
            HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.happier.test',
            [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: '5173' };
        const runtimes = createLocalServiceRouteRuntimes(env);
        const registered = runtimes.preview.registerPreview({ resource: preview, accountId: 'user_1' });
        if (!registered.ok || !registered.accessUrl) throw new Error('preview registration failed');
        const url = new URL(registered.accessUrl);
        let release = () => {};
        const released = new Promise<void>(resolve => { release = resolve; });
        // The remote stream never ends by itself; only the tunnel's release lets its reader finish.
        const openTunnel: OpenLocalServicePreviewTunnel = async () => ({
            tunnelId: 'tunnel', substreamId: 'sse', write() {}, endWrite() {},
            async *read() {
                yield new TextEncoder().encode(`HTTP/1.1 200 OK\r\nContent-Type: ${contentType}\r\n\r\n${first}`);
                await released;
            },
            abort: release, close: release,
        });
        const app = fastify({ logger: false });
        await enableApiCompression(app);
        app.decorate('authenticate', async () => {});
        registerLocalServiceRoutes(app as unknown as Fastify, { env, runtimes, openTunnel });
        let socket: ReturnType<typeof connect> | undefined;
        try {
            const exchange = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: url.host } });
            const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
            const listener = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));
            socket = connect(Number(listener.port), '127.0.0.1');
            let received = '';
            const firstBytes = new Promise<void>(resolve => socket!.on('data', chunk => {
                received += chunk.toString();
                if (received.includes(first)) resolve();
            }));
            socket.on('connect', () => socket!.write(`GET /sse HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${cookie}\r\nAccept: text/event-stream\r\nAccept-Encoding: gzip, br\r\n\r\n`));
            await firstBytes;
            expect(received.toLowerCase()).not.toContain('\r\ncontent-encoding:');
            expect(received.toLowerCase()).toContain('\r\ntransfer-encoding: chunked');
            socket.destroy();
            await released;
        } finally {
            release();
            socket?.destroy();
            await app.close();
        }
    }, 15_000);

    it.each(['private', 'public'] as const)('admits a slow %s relay WebSocket upgrade beside Socket.IO, keeps Socket.IO and closes an unclaimed upgrade', async (kind) => {
        const env = { ...peerMediationGrantSigningEnv(), HANDY_MASTER_SECRET: 'test-master-secret',
            HAPPIER_PUBLIC_SERVER_URL: 'https://app.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.happier.test',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: 'true',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'secret_link',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '60000',
            HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: '0',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestAuditSink]: '1',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewRateLimitProfileIds]: 'default',
            [FEATURE_ENV_KEYS.localServicesPublicPreviewAllowTestRateLimitChecker]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelServerRoutedEnabled]: '1',
            [FEATURE_ENV_KEYS.machinesTunnelAllowedPorts]: '5173' };
        const runtimes = createLocalServiceRouteRuntimes(env);
        const registered = runtimes.preview.registerPreview({ resource: preview, accountId: 'user_1' });
        if (!registered.ok || !registered.accessUrl) throw new Error('preview registration failed');
        const exposure = runtimes.public.createExposure({ preview, requestedMode: 'secret_link', requestedTtlMs: 60_000,
            actorId: 'user_1', sessionAuthorized: true, dnsTlsValid: true, rateLimitProfileId: 'default' });
        if (!exposure.ok) throw new Error('public exposure failed');
        const url = new URL(kind === 'private' ? registered.accessUrl : exposure.exposure.publicUrl);
        const network = tunnelBoundary('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
        // The remote machine takes longer than Socket.IO's default unclaimed-upgrade deadline (1 s) to answer.
        const slowTunnel: OpenLocalServicePreviewTunnel = async (input) => {
            await new Promise<void>(resolve => setTimeout(resolve, 1_500));
            return network.openTunnel(input);
        };
        const app = fastify({ logger: false });
        app.decorate('authenticate', async () => {});
        try {
            for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
            vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
            await enableApiCompression(app);
            startSocket(app as unknown as Fastify);
            registerLocalServiceRoutes(app as unknown as Fastify, { runtimes, openTunnel: slowTunnel });
            const exchange = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: url.host } });
            const cookie = String(exchange.headers['set-cookie']).split(';')[0]!;
            const listener = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));
            const upgrade = async (path: string, host: string) => {
                const socket = connect(Number(listener.port), '127.0.0.1');
                let response = '';
                try {
                    return await new Promise<{ response: string; closedAfterMs: number | null }>((resolve) => {
                        const startedAt = Date.now();
                        socket.on('error', () => resolve({ response, closedAfterMs: Date.now() - startedAt }));
                        socket.on('close', () => resolve({ response, closedAfterMs: Date.now() - startedAt }));
                        socket.on('data', chunk => {
                            response += chunk.toString();
                            if (response.includes('\r\n\r\n')) resolve({ response, closedAfterMs: null });
                        });
                        socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
                    });
                } finally { socket.destroy(); }
            };
            expect((await upgrade('/socket', url.host)).response).toContain('101 Switching Protocols');
            // Socket.IO keeps its own path.
            expect((await upgrade('/v1/updates/?EIO=4&transport=websocket', 'app.happier.test')).response).toContain('101 Switching Protocols');
            // Nothing claims this upgrade; it must still be closed rather than held open.
            const unclaimed = await upgrade('/not-a-claimed-route', 'unclaimed.happier.test');
            expect(unclaimed.response).not.toContain('101 Switching Protocols');
            expect(unclaimed.closedAfterMs).not.toBeNull();
        } finally {
            await app.close();
            vi.unstubAllEnvs();
        }
    }, 15_000);

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
        const host = scope === 'private' ? HOST : new URL(created.exposure.publicUrl).host;
        const headers = { host, cookie };
        const pending = kind === 'http'
            ? getRouteHandler(app, 'GET', scope === 'private' ? '/*' : '/v1/local-services/public/:exposureId/*')({
                params: { '*': '', exposureId }, headers,
            }, { ...createReplyStub(), raw })
            : Promise.resolve(upgradeHandlers[scope === 'private' ? 0 : 1]?.({
                url: scope === 'private' ? '/socket' : `/v1/local-services/public/${exposureId}/socket`, headers: {
                host, cookie, upgrade: 'websocket', connection: 'Upgrade',
                'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
            } }, socket, new Uint8Array()));
        try {
            const opening = kind === 'websocket_handshake' ? sent : raw.writing;
            expect(await Promise.race([opening.then(() => 'opened'), Promise.resolve(pending).then(() => 'refused')])).toBe('opened');
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
