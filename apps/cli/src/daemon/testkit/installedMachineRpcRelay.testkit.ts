import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { io } from 'socket.io-client';
import { onTestFinished } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { signMachineInstallationProof, type MachineInstallationIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

type MachineRelayIngress = Pick<RpcRequest, 'machineAdmission' | 'callerAuthority' | 'sessionActionOrigin'>;
type DatabaseQuery = Readonly<{ where?: Readonly<{ id?: string | Readonly<{ in: readonly string[] }>; accountId?: string }> }>;
type MachineDatabaseBoundary<TMachine, TAccount> = {
    machine: { findUnique(query: DatabaseQuery): Promise<TMachine | null>;
        findFirst(query: DatabaseQuery): Promise<TMachine | null>; findMany(query: DatabaseQuery): Promise<TMachine[]> };
    account: { findUnique(query: DatabaseQuery): Promise<TAccount | null> };
    ephemeralRunnerActivation: { findFirst(query: unknown): Promise<null> };
    accessKey: { findMany(query: unknown): Promise<Readonly<{ accountId: string; sessionId: string }>[]> };
    $queryRaw(): Promise<{ statement_timeout: string }[]>;
    $executeRaw(): Promise<number>;
    $executeRawUnsafe(): Promise<number>;
    $transaction<T>(operation: (tx: MachineDatabaseBoundary<TMachine, TAccount>) => Promise<T>): Promise<T>;
};

/** Database boundary for the real Home Machine admission producer. It stores
 * resource/grant facts, never an admission result or requester context. */
export function createInstalledMachineRpcDatabaseBoundary(input: Readonly<{
    machineId: string;
    ownerAccountId: string;
    installation: MachineInstallationIdentityV1;
    members?: readonly Readonly<{ accountId: string; accessLevel: 'view' | 'admin' }>[];
}>) {
    const account = { id: input.ownerAccountId, status: 'active', encryptionMode: 'plain',
        publicKey: null, contentPublicKey: null, contentPublicKeySig: null };
    const machine = { id: input.machineId, kind: 'persistent', accountId: input.ownerAccountId,
        account, installationId: input.installation.installationId,
        installationPublicKey: Buffer.from(input.installation.publicKey, 'base64url'),
        metadata: encodePlainMachineStoredContent({}), metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0,
        dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        active: true, revokedAt: null as Date | null, replacedByMachineId: null as string | null,
        operationProtocolCapabilities: null, operationProtocolCapabilitiesRevision: 0,
        accountGrants: (input.members ?? []).map(member => ({ ...member,
            account: { id: member.accountId, status: 'active' } })), teamGrants: [], groupGrants: [] };
    const matches = (query: DatabaseQuery) => (!query.where?.id || (typeof query.where.id === 'string'
        ? query.where.id === machine.id : query.where.id.in.includes(machine.id)))
        && (!query.where?.accountId || query.where.accountId === machine.accountId);
    const db: MachineDatabaseBoundary<typeof machine, typeof account> = {
        machine: {
            findUnique: async (query: DatabaseQuery) => matches(query) ? machine : null,
            findFirst: async (query: DatabaseQuery) => matches(query) ? machine : null,
            findMany: async (query: DatabaseQuery) => matches(query) ? [machine] : [],
        },
        account: { findUnique: async (query: DatabaseQuery) => query.where?.id === account.id ? account : null },
        // The installed persistent Machine has no ephemeral runner activation.
        ephemeralRunnerActivation: { findFirst: async () => null },
        // This fixture has no Sessions or AccessKeys. Disconnect still runs the
        // real custody recovery over the empty persistent relation.
        accessKey: { findMany: async () => [] },
        $queryRaw: async () => [{ statement_timeout: '0' }],
        $executeRaw: async () => 0,
        $executeRawUnsafe: async () => 0,
        $transaction: async <T>(operation: (tx: MachineDatabaseBoundary<typeof machine, typeof account>) => Promise<T>): Promise<T> => operation(db),
    };
    return { db, machine };
}

/** Real Home registration/forwarding into an installed Machine manager.
 * Callers own the database system boundary and the receiving Machine fixture;
 * this harness substitutes neither admission nor any registered effect. */
export async function createInstalledMachineRpcRelay(input: Readonly<{
    manager: RpcHandlerManager;
    machineId: string;
    transportOwnerAccountId: string;
    methods: readonly string[];
    ui?: Readonly<{ installation: MachineInstallationIdentityV1; ownerAccountId?: string }>;
}>) {
    // Runtime paths keep server source aliases under their own package and out
    // of CLI declaration compilation, matching the canonical registration suite.
    const registrationPath = '../../../../server/sources/app/api/socket/rpc/registerSocketRpcHandlers';
    const forwardingPath = '../../../../server/sources/app/api/socket/rpc/forwardRpcCall';
    const { registerSocketRpcHandlers }: Readonly<{
        registerSocketRpcHandlers(params: Readonly<{ userId: string; socket: ServerSocket; io: Server }>): void;
    }> = await import(registrationPath);
    const { forwardRpcCall }: Readonly<{
        forwardRpcCall(params: Readonly<{ io: Server; targetUserId: string; method: string; callParams: unknown;
            traceId: string; timeoutMs: null }> & MachineRelayIngress): Promise<unknown>;
    }> = await import(forwardingPath);
    const installationVerificationPath = '../../../../server/sources/app/api/socket/machineSocketInstallationProof';
    const installationVerifier: Readonly<{
        resolveVerifiedMachineSocketInstallationId(params: Readonly<{ accountId: string; machineId: string;
            machine: Readonly<{ installationId: string | null; installationPublicKey: Uint8Array | null }>;
            socketAuth: unknown }>): string | null;
    }> | undefined = input.ui ? await import(installationVerificationPath) : undefined;
    const databasePath = '../../../../server/sources/storage/db';
    const database: Readonly<{ db: Readonly<{ machine: Readonly<{
        findUnique(query: Readonly<{ where: Readonly<{ id: string }> }>): Promise<Readonly<{
            installationId: string | null; installationPublicKey: Uint8Array | null }> | null>;
    }> }> }> | undefined = input.ui ? await import(databasePath) : undefined;
    const ownerAccountId = input.ui?.ownerAccountId ?? input.transportOwnerAccountId;
    const compatibilityPath = '../../../../server/sources/app/clientCompatibility/accountStoredContentCompatibility';
    const compatibility: Readonly<{
        evaluateAccountStoredContentSocketCompatibility(auth: unknown): unknown;
        writeAccountStoredContentCompatibilityForSocket(socket: ServerSocket, result: unknown): void;
    }> = await import(compatibilityPath);
    const clientCompatibilityAuth = buildAccountStoredContentCompatibilitySocketAuthV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION);
    const transportBudgetPath = '../../../../server/sources/app/api/socket/transportBudget';
    const { DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE }: Readonly<{ DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE: number }> =
        await import(transportBudgetPath);
    const http = createServer();
    const sockets = new Server(http, { maxHttpBufferSize: DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE });
    sockets.on('connection', async socket => {
        const uiCaller = socket.handshake.auth.uiCaller;
        if (input.ui && uiCaller && typeof uiCaller === 'object' && typeof uiCaller.actorAccountId === 'string') {
            // Authentication is the network boundary. The Home still produces
            // custody/role/currentness itself from the database below CALL.
            socket.data = { clientType: 'user-scoped', authTokenKind: 'account',
                authAuthority: uiCaller.callerAuthority, authTokenAuthenticationEvidence: [] };
            compatibility.writeAccountStoredContentCompatibilityForSocket(socket,
                compatibility.evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            registerSocketRpcHandlers({ userId: uiCaller.actorAccountId, socket, io: sockets });
        } else {
            socket.data = { clientType: 'machine-scoped', machineId: input.machineId };
            compatibility.writeAccountStoredContentCompatibilityForSocket(socket,
                compatibility.evaluateAccountStoredContentSocketCompatibility(socket.handshake.auth));
            if (input.ui && installationVerifier && database) {
                const machine = await database.db.machine.findUnique({ where: { id: input.machineId } });
                const verified = machine && installationVerifier.resolveVerifiedMachineSocketInstallationId({
                    accountId: ownerAccountId, machineId: input.machineId, machine, socketAuth: socket.handshake.auth });
                if (!verified) { socket.disconnect(true); return; }
                socket.data.verifiedMachineInstallationId = verified;
            }
            registerSocketRpcHandlers({ userId: input.ui ? ownerAccountId : input.transportOwnerAccountId, socket, io: sockets });
        }
        socket.emit('fixture:rpc-ready');
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Machine relay endpoint unavailable');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const receiver = io(endpoint, { autoConnect: false, reconnection: false,
        auth: { ...clientCompatibilityAuth, ...(input.ui ? { installationId: input.ui.installation.installationId,
            installationPublicKey: input.ui.installation.publicKey,
            installationProof: signMachineInstallationProof({ privateKey: input.ui.installation.privateKey,
                payload: { version: 1, accountId: ownerAccountId, machineId: input.machineId,
                    installationId: input.ui.installation.installationId } }) } : {}) } });
    const callers = new Map<string, ReturnType<typeof io>>();
    receiver.on(SOCKET_RPC_EVENTS.REQUEST, (request: RpcRequest, acknowledge: (result: unknown) => void) => {
        void input.manager.handleRequest(request).then(acknowledge);
    });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
        input.manager.onSocketDisconnect();
        receiver.disconnect();
        for (const caller of callers.values()) caller.disconnect();
        await new Promise<void>(resolve => sockets.close(() => resolve()));
    })();
    onTestFinished(close);
    try {
        await new Promise<void>((resolve, reject) => {
            receiver.once('fixture:rpc-ready', resolve);
            receiver.once('connect_error', reject);
            receiver.connect();
        });
        input.manager.onSocketConnect(receiver);
        const registered = await input.manager.waitForRegisteredHandlers([...input.methods], { timeoutMs: 5_000 });
        if (registered.status !== 'ready') throw new Error(`Machine relay methods did not register: ${JSON.stringify(registered)}`);
    } catch (error) {
        await close();
        throw error;
    }
    const invokeUiRaw = async (method: string, params: unknown, caller: Readonly<{
        actorAccountId?: string; callerAuthority?: RpcRequest['callerAuthority'];
        /** Preserve the real client's complete CALL carrier at the socket boundary. */
        packet?: Readonly<object>;
        /** Malformed client input control, never a server admission producer. */
        machineAdmission?: unknown;
    }> = {}): Promise<unknown> => {
        if (!input.ui) throw new Error('UI ingress requires an installed database fixture');
        const actorAccountId = caller.actorAccountId ?? ownerAccountId;
        const callerAuthority = caller.callerAuthority ?? 'present_user';
        const key = JSON.stringify([actorAccountId, callerAuthority]);
        let connection = callers.get(key);
        if (!connection) {
            connection = io(endpoint, { autoConnect: false, reconnection: false,
                auth: { ...clientCompatibilityAuth, uiCaller: { actorAccountId, callerAuthority } } });
            callers.set(key, connection);
            await new Promise<void>((resolve, reject) => {
                connection!.once('fixture:rpc-ready', resolve);
                connection!.once('connect_error', reject);
                connection!.connect();
            });
        }
        const connectedCaller = connection;
        return new Promise(resolve => connectedCaller.emit(SOCKET_RPC_EVENTS.CALL,
            { ...caller.packet, method: `${input.machineId}:${method}`, params, timeoutMs: null,
                ...(caller.machineAdmission === undefined ? {} : { machineAdmission: caller.machineAdmission }) }, resolve));
    };
    return {
        invokeUiRaw,
        async invokeUi(method: string, params: unknown, caller?: Parameters<typeof invokeUiRaw>[2]): Promise<unknown> {
            const response = await invokeUiRaw(method, params, caller);
            if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true || !('result' in response)) {
                return response;
            }
            return response.result;
        },
        async invoke(method: string, params: unknown, ingress: MachineRelayIngress): Promise<unknown> {
            const response = await forwardRpcCall({ io: sockets, targetUserId: input.transportOwnerAccountId,
                method: `${input.machineId}:${method}`, callParams: params, traceId: randomUUID(), timeoutMs: null, ...ingress });
            if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true || !('result' in response)) {
                throw new Error('Machine relay did not return a daemon result');
            }
            return response.result;
        },
        close,
    };
}
