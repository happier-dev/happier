import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ArtifactHttpReadV1Schema,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilitySocketAuthV1,
    createActionExecutor,
    decodePlainArtifactStoredContent,
} from '@happier-dev/protocol';
import { WorkBoardV1Schema, buildWorkBoardItemKeyV1 } from '@happier-dev/protocol/boards';
import { WorkflowDefinitionArtifactBodyV1ReadSchema, WorkflowDefinitionArtifactHeaderV1Schema } from '@happier-dev/protocol/workflows';
import { ArtifactPrivateRevisionMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { StoredContentPublicShareReadResponseV1Schema } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createCliActionDeps } from '../../../../../../cli/src/session/actions/createCliActionDeps';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { startSocket } from '@/app/api/socket';
import type { Fastify as AppFastify } from '@/app/api/types';
import { accountRoutes } from '../account/accountRoutes';
import { artifactsRoutes } from './artifactsRoutes';
import { publicShareRoutes } from '../share/publicShareRoutes';
import { loadPublicShareViewerContent } from '../share/publicShareViewerClient';
import { db } from '@/storage/db';
import { eventRouter } from '@/app/events/eventRouter';
import { resolveServerFeaturePayload } from '@/app/features/catalog/resolveServerFeaturePayload';
import { serverFeatureRegistry } from '@/app/features/catalog/serverFeatureRegistry';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

describe('unified work Actions through CLI, HTTP, SQLite and Socket.IO', () => {
    let harness: LightSqliteHarness;
    let app: AppFastify;
    let origin: string;
    let accountId: string;
    let token: string;
    let socket: Socket;
    let executor: ReturnType<typeof createActionExecutor>;
    const context = { surface: 'cli', authority: 'present_user', bypassApprovals: true } as const;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-int-action-seams-', initAuth: true,
            initEncrypt: true, initFiles: true, env: {
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
                HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1',
                HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.example.test',
            } });
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        accountId = account.id;
        token = await auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' });
        app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        enableAuthentication(app);
        accountRoutes(app);
        artifactsRoutes(app);
        publicShareRoutes(app);
        startSocket(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected the HTTP listener');
        origin = `http://127.0.0.1:${address.port}`;
        executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
            serverId: origin, serverHttpBaseUrl: origin, sessionId: '', mode: 'plain', ctx: null,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
                features: resolveServerFeaturePayload(process.env, serverFeatureRegistry) }),
        }));
        socket = ioClient(origin, { path: '/v1/updates/', transports: ['websocket'], autoConnect: false, reconnection: false,
            auth: { token, clientType: 'user-scoped', clientPurpose: 'sync',
                ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } });
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
            socket.connect();
        });
        // A connect event precedes server convergence; an admitted packet proves
        // the real middleware has finished binding rooms and handlers.
        await socket.emitWithAck(SOCKET_RPC_EVENTS.CALL, { method: 'neutral.missing', params: {} });
    }, 120_000);

    afterAll(async () => {
        socket?.close();
        try { await app?.close(); } finally {
            eventRouter.clearIo();
            await harness?.close();
        }
    });

    async function readWireArtifact(id: string) {
        const response = await fetch(`${origin}/v1/artifacts/${id}`, { headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(200);
        return ArtifactHttpReadV1Schema.parse(await response.json());
    }

    it('persists a Board edit, delivers its committed cursor, and reopens canonical content and provenance', async () => {
        const boardId = randomUUID();
        const ref = { kind: 'session', qualifiedId: { serverId: origin, id: 'destination-session' } } as const;
        const key = buildWorkBoardItemKeyV1(ref);
        const update = new Promise<unknown>(resolve => {
            const receive = (payload: { body?: { t?: string; artifactId?: string } }) => {
                if (payload.body?.t !== 'new-artifact' || payload.body.artifactId !== boardId) return;
                socket.off('update', receive);
                resolve(payload);
            };
            socket.on('update', receive);
        });
        expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: boardId, name: 'Release' } } }, context))
            .toMatchObject({ ok: true, result: { board: { id: boardId, name: 'Release' } } });
        const change = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
            accountId, kind: 'artifact', entityId: boardId,
        } } });
        expect(UpdateContainerSchema.parse(await update)).toMatchObject({ seq: change.cursor, body: { t: 'new-artifact', artifactId: boardId } });
        expect(await executor.execute('boards.apply', { intent: { kind: 'add_items', boardId, refs: [ref] } }, context))
            .toMatchObject({ ok: true });
        expect(await executor.execute('boards.apply', { intent: { kind: 'set_positions', boardId,
            positionsByItemRef: { [key]: { x: 24, y: 48 } } } }, context)).toMatchObject({ ok: true });
        const wire = await readWireArtifact(boardId);
        const opened = decodePlainArtifactStoredContent(wire.body);
        if (!opened || typeof opened !== 'object' || !('body' in opened) || typeof opened.body !== 'string') {
            throw new Error('Expected a produced Board body');
        }
        const board = WorkBoardV1Schema.parse(JSON.parse(opened.body));
        expect(board).toMatchObject({ id: boardId, source: { picked: [ref] }, positionsByItemRef: { [key]: { x: 24, y: 48 } } });
        expect(await executor.execute('boards.list', {}, context)).toMatchObject({ ok: true, result: { boards: expect.arrayContaining([board]) } });
        const metadata = wire.provenance && ArtifactPrivateRevisionMetadataV1Schema.parse(decodePlainArtifactStoredContent(wire.provenance));
        expect(metadata).toMatchObject({ artifactId: boardId, bodyVersion: wire.bodyVersion,
            provenance: { savedBy: { kind: 'person', accountId } } });
        const before = await db.artifact.findUniqueOrThrow({ where: { id: boardId } });
        expect(await executor.execute('boards.apply', { intent: { kind: 'update', boardId,
            patch: { source: { unknown: { sections: ['future'] } } } } }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(await db.artifact.findUniqueOrThrow({ where: { id: boardId } })).toEqual(before);
    });

    it('normalizes a Workflow definition at the real Action entry point and reads its produced stored schemas', async () => {
        const definitionId = randomUUID();
        expect(await executor.execute('workflow.definition.create', { definitionId, metadata: { title: 'Review' },
            definition: { version: 1, defaults: { agentTarget: { kind: 'agent', identity: {
                pluginId: 'happier.agent.claude', localId: 'claude',
            } } }, blocks: ['Review this'] } }, context)).toMatchObject({ ok: true, result: { definitionId } });
        const wire = await readWireArtifact(definitionId);
        const header = WorkflowDefinitionArtifactHeaderV1Schema.parse(decodePlainArtifactStoredContent(wire.header));
        expect(header).toMatchObject({ definitionId, metadata: { title: 'Review' }, revision: {
            headerVersion: wire.headerVersion, bodyVersion: wire.bodyVersion,
        } });
        const opened = decodePlainArtifactStoredContent(wire.body);
        if (!opened || typeof opened !== 'object' || !('body' in opened) || typeof opened.body !== 'string') {
            throw new Error('Expected a produced Workflow body');
        }
        const body = WorkflowDefinitionArtifactBodyV1ReadSchema.parse(JSON.parse(opened.body));
        expect(body.definition.blocks[0]).toMatchObject({ kind: 'step', id: 'wf--step-0' });
        expect(await executor.execute('workflow.definition.get', { definitionId }, context))
            .toMatchObject({ ok: true, result: { definitionId, definition: body.definition } });
        const invalidId = randomUUID();
        expect(await executor.execute('workflow.definition.create', { definitionId: invalidId,
            metadata: { title: 'Invalid' }, definition: { blocks: [] } }, context)).toMatchObject({ ok: false, errorCode: 'invalid_input' });
        expect(await db.artifact.findUnique({ where: { id: invalidId } })).toBeNull();
    });

    it('publishes a Board through the real public-link Action, opens its HTTP output in the viewer, and observes revocation', async () => {
        const boardId = randomUUID();
        expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: boardId, name: 'Shared release' } } }, context))
            .toMatchObject({ ok: true });
        const result = await executor.execute('artifact.public_link.create', { artifactId: boardId }, context);
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error('Expected a created public link');
        const publication = ArtifactActionOutputSchemasV1['artifact.public_link.create'].parse(result.result);
        if (!publication.url) throw new Error('Explicit anonymous creation did not issue a URL');
        const link = new URL(publication.url);
        const lookupId = link.pathname.split('/').at(-1)!;
        const secret = link.hash.slice('#k='.length);
        expect(lookupId).not.toBe(secret);
        expect((await db.publicSessionShare.findUniqueOrThrow({ where: { id: publication.publicShare.id } })).artifactId).toBe(boardId);
        // Map the isolated hostname to the in-process listener at the network
        // boundary. All replies, admission, storage and viewer decoding stay real.
        const viewerFetch: typeof fetch = async (input, init) => {
            const requested = new URL(input instanceof Request ? input.url : String(input));
            expect(requested.origin).toBe(link.origin);
            const headers = new Headers(init?.headers);
            headers.set('host', requested.host);
            const response = await fetch(`${origin}${requested.pathname}${requested.search}`, { ...init, headers });
            if (response.ok) {
                const wire = StoredContentPublicShareReadResponseV1Schema.parse(await response.clone().json());
                expect(wire).toMatchObject({ subject: { kind: 'artifact', id: boardId }, encryptionMode: 'plain',
                    content: { kind: 'artifact' } });
                expect(JSON.stringify(wire)).not.toContain(secret);
            }
            return response;
        };
        const location = { origin: link.origin, pathname: link.pathname, hash: link.hash };
        expect(await loadPublicShareViewerContent({ location, fetch: viewerFetch }))
            .toMatchObject({ status: 'ready', title: 'Shared release' });
        expect(await executor.execute('artifact.public_link.revoke', { artifactId: boardId, shareId: publication.publicShare.id }, context))
            .toMatchObject({ ok: true, result: { revoked: true } });
        expect(await loadPublicShareViewerContent({ location, fetch: viewerFetch })).toEqual({ status: 'unavailable' });
    });
});
