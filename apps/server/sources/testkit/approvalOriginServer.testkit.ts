import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { isLiveCliApprovalOriginMethod } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import type { Fastify } from '@/app/api/types';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { auth } from '@/app/auth/auth';
import { narrowCredentialAuthority } from '@/app/auth/effectiveCredentialAuthority';
import { db } from '@/storage/db';
import { createLightSqliteHarness } from './lightSqliteHarness';

interface ApprovalOriginRpcPacket {
    readonly method: string;
    readonly params: unknown;
}

export interface ApprovalOriginTestHome {
    readonly accountId: string;
    readonly token: string;
    readonly serverUrl: string;
    startRpc(observeCall?: (packet: ApprovalOriginRpcPacket) => void): void;
    close(): Promise<void>;
}

export interface ApprovalOriginServerTestkit {
    createHome(options: Readonly<{
        configureHttp(app: FastifyInstance, accountId: string): void;
    }>): Promise<ApprovalOriginTestHome>;
    close(): Promise<void>;
}

/** Real disposable auth, Artifact HTTP/CAS and RPC relay for cross-app approval tests. */
export async function createApprovalOriginServerTestkit(): Promise<ApprovalOriginServerTestkit> {
    const sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-conforigin-', initAuth: true, initEncrypt: true });
    const homes = new Set<ApprovalOriginTestHome>();
    return {
        createHome: async options => {
            const app = createAuthenticatedTestApp({ authentication: 'real' }) as Fastify;
            let io: Server | undefined;
            let closed = false;
            try {
                const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1 } });
                const token = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
                options.configureHttp(app, account.id);
                artifactsRoutes(app);
                const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
                const home: ApprovalOriginTestHome = {
                    accountId: account.id, token, serverUrl,
                    startRpc: observeCall => {
                        if (io) throw new Error('approval_origin_rpc_already_started');
                        const relay = new Server(app.server, { path: '/v1/updates' });
                        io = relay;
                        relay.use(async (socket, next) => {
                            const verified = await auth.verifyTokenForRoute(socket.handshake.auth.token);
                            if (!verified || verified.userId !== account.id) return next(new Error('invalid_token'));
                            socket.data.userId = verified.userId;
                            socket.data.clientType = socket.handshake.auth.clientType;
                            socket.data.authTokenKind = verified.authTokenKind;
                            socket.data.authAuthority = narrowCredentialAuthority(verified.authority, socket.handshake.auth.authorityCeiling);
                            socket.data.authTokenAuthenticationEvidence = verified.authenticationEvidence;
                            next();
                        });
                        relay.on('connection', socket => {
                            registerSocketRpcHandlers({ userId: account.id, socket, io: relay });
                            socket.on(SOCKET_RPC_EVENTS.CALL, (packet: ApprovalOriginRpcPacket) => {
                                if (isLiveCliApprovalOriginMethod(packet.method)) observeCall?.(packet);
                            });
                        });
                    },
                    close: async () => {
                        if (closed) return;
                        closed = true;
                        try {
                            if (io) await new Promise<void>(resolve => io!.close(() => resolve()));
                        } finally {
                            try { await app.close(); } finally { homes.delete(home); }
                        }
                    },
                };
                homes.add(home);
                return home;
            } catch (error) { await app.close(); throw error; }
        },
        close: async () => {
            try { for (const home of homes) await home.close(); }
            finally { await sqlite.close(); }
        },
    };
}
