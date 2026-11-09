import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { homeConfigSnapshotPostgresQueryMock } from '../../home/settings/homeConfigSnapshot.testkit';
import { createDbMocks, inTxPostgresControlStatementMock, matchesDbMockWhere } from './dbMocks';
import type { MachineAdmissionFacts } from '../../machines/machineAccess';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { MachineInstallationIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ProjectSourceOwnerV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { TeamRecord } from '../../teams/projections';
import type { ResourceGrantAccessFacts } from '../../teams/resourceGrantAccess';

/** Database I/O boundary for the real Home issuer and installed-Session MCP journey. */
export function createInstalledSessionExternalActionStorage() {
    const publicKey: Uint8Array = new Uint8Array();
    const accountGrants: MachineAdmissionFacts['accountGrants'] = [];
    const state = {
        accountId: 'account', machineId: 'machine', sessionId: 'session', installationId: 'installation',
        homeId: 'srv_proposal_admission', bound: true, publisherBound: true,
        publicKey, metadata: encodePlainMachineStoredContent({}),
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null as Date | null,
        accountGrants,
        operationProtocolCapabilities: {} as unknown,
        operationProtocolCapabilitiesRevision: 0,
        sessionIds: new Set<string>(), directReportSessionIds: new Set<string>(),
        sessionOwners: new Map<string, string>(),
        sessionAccessKeyIds: new Set<string>(),
        creation: {
            team: null as TeamRecord | null,
            membershipActive: true,
            artifact: { id: 'create-candidate', accountId: 'account', kind: null as string | null,
                accountGrants: [] as ResourceGrantAccessFacts['accountGrants'] },
        },
        deploymentRead: {
            enabled: false, sourceReadable: true,
            candidate: { id: 'candidate', headerVersion: 1, bodyVersion: 1 },
            source: { id: 'source', revision: 1, name: 'App', repository: null, defaultRef: null, subdir: null,
                audience: [], owner: ProjectSourceOwnerV1Schema.parse({ kind: 'account', accountId: 'account' }), createdByAccountId: 'account', attachments: [] },
            environment: { id: 'staging', projectSourceId: 'source', revision: 1, runtimeTargetLinkId: 'runtime',
                deployerMode: 'members',
                buildMachineId: 'machine', deletedAt: null as Date | null, contentArtifactId: 'environment-content' },
            link: { id: 'runtime', environmentId: 'staging', role: 'runtime', sourceKind: 'host', targetKind: 'ownServer',
                activeDeploymentId: 'active-receipt', deletedAt: null as Date | null, detachedAt: null as Date | null,
                contentArtifactId: 'runtime-content', machines: [{ machineId: 'machine', installationId: 'installation', state: 'active' }] },
            receipt: { id: 'active-receipt', environmentId: 'staging', targetLinkId: 'runtime', contentArtifactId: 'receipt-content' },
        },
    };
    const account = { id: state.accountId, status: 'active', tokenEpoch: 1,
        encryptionMode: 'plain' };
    const otherAccount = { ...account, id: 'other-account' };
    const machine = () => ({ id: state.machineId, accountId: state.accountId, kind: 'persistent',
        installationId: state.installationId, installationPublicKey: state.publicKey,
        revokedAt: state.revokedAt, replacedByMachineId: null, active: true,
        metadata: state.metadata, daemonState: null, dataEncryptionKey: state.dataEncryptionKey,
        operationProtocolCapabilities: state.operationProtocolCapabilities,
        operationProtocolCapabilitiesRevision: state.operationProtocolCapabilitiesRevision,
        account, accountGrants: state.accountGrants, teamGrants: [], groupGrants: [] });
    type MachineWhere = { id?: string; accountId?: string; installationId?: string; revokedAt?: null; replacedByMachineId?: null };
    const readMachine = async ({ where }: { where: MachineWhere }) => {
        const row = machine();
        return Object.entries(where).every(([field, expected]) => row[field as keyof typeof row] === expected) ? row : null;
    };
    // Session rows and exact access keys are persistent database facts only;
    // real Home admission still decides physical Machine requester authority.
    const sessionFields = createDbMocks({ session: [] }).db.session.fields;
    const readSession = (id: string) => {
        if (!state.bound || id !== state.sessionId && !state.sessionIds.has(id)) return null;
        const accountId = state.sessionOwners.get(id) ?? state.accountId;
        return { id, accountId, account: accountId === otherAccount.id ? otherAccount : account,
            shares: [], teamGrants: [], groupGrants: [] };
    };
    const readSessions = () => [...new Set([state.sessionId, ...state.sessionIds])].flatMap(id => {
        const row = readSession(id);
        return row ? [row] : [];
    });
    const reader = {
        ...homeConfigSnapshotPostgresQueryMock,
        // The real transaction owner now establishes a PostgreSQL read snapshot.
        // Replace only that database command, leaving currentness/policy real.
        ...inTxPostgresControlStatementMock,
        account: { findUnique: async ({ where }: { where: { id: string } }) =>
            where.id === account.id ? account : where.id === otherAccount.id ? otherAccount : null },
        machine: { findUnique: readMachine, findFirst: readMachine,
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.includes(state.machineId) ? [machine()] : [],
        },
        ephemeralRunnerActivation: { findFirst: async () => null },
        session: {
            fields: sessionFields,
            findFirst: async ({ where }: { where: unknown }) => readSessions().find(row => matchesDbMockWhere(row, where)) ?? null,
            findUnique: async ({ where }: { where: { id: string } }) => readSession(where.id),
            findMany: async ({ where }: { where: unknown }) => readSessions().filter(row => matchesDbMockWhere(row, where)),
        },
        sessionFollowEdge: { findMany: async ({ where }: { where: { relation: string; destinationSessionId: { in: string[] } } }) =>
            where.relation === 'manager' && where.destinationSessionId.in.includes(state.sessionId)
                ? [...state.directReportSessionIds].map(sourceSessionId => ({ sourceSessionId })) : [],
        },
        team: { findMany: async ({ where }: { where: unknown }) => state.creation.team
            && matchesDbMockWhere(state.creation.team, where) ? [state.creation.team] : [] },
        teamMembership: { findMany: async ({ where }: { where: unknown }) => {
            const team = state.creation.team;
            if (!team || !state.creation.membershipActive) return [];
            const row = { id: 'source-team-owner', teamId: team.id, accountId: state.accountId, role: 'owner', status: 'active',
                account, provisionedIdentity: null, identityConnectionManagement: null };
            const recipient = { ...row, id: 'source-team-member', accountId: otherAccount.id, role: 'member', account: otherAccount };
            return [row, recipient].filter(candidate => matchesDbMockWhere(candidate, where));
        } },
        teamGroupMembership: { findMany: async () => [] },
        accessKey: { findUnique: async ({ where }: { where: { accountId_machineId_sessionId: { accountId: string; machineId: string; sessionId: string } } }) => {
            const key = where.accountId_machineId_sessionId;
            const session = readSession(key.sessionId);
            return state.bound && session?.accountId === key.accountId && key.machineId === state.machineId
                && (key.sessionId === state.sessionId || state.sessionAccessKeyIds.has(key.sessionId))
                ? { machine: machine(), session, data: 'existing-session-machine-key', dataVersion: 1,
                    createdAt: new Date(0), updatedAt: new Date(0) } : null;
        } },
        simpleCache: { findUnique: async () => ({ value: state.homeId }) },
        homeSettings: { findUnique: async () => null },
        homeGovernancePolicy: { findUnique: async () => null },
        projectSource: { findUnique: async ({ where }: { where: { id: string } }) => state.deploymentRead.enabled
            && state.deploymentRead.sourceReadable && where.id === state.deploymentRead.source.id ? state.deploymentRead.source : null },
        projectDeploymentDefaults: { findUnique: async () => null },
        artifact: {
            findUnique: async ({ where }: { where: { id: string } }) => where.id === state.creation.artifact.id
                ? state.creation.artifact : state.deploymentRead.enabled && where.id === state.deploymentRead.candidate.id
                    ? state.deploymentRead.candidate : null,
            findFirst: async ({ where }: { where: unknown }) => {
                const row = { ...state.creation.artifact, account, teamGrants: [], groupGrants: [],
                    pluginUiArtifact: null, packageAssetRelease: null, deletedAt: null };
                return matchesDbMockWhere(row, where) ? row : null;
            },
        },
        deploymentEnvironment: { findUnique: async ({ where }: { where: { id: string } }) => state.deploymentRead.enabled
            && where.id === state.deploymentRead.environment.id ? state.deploymentRead.environment : null,
            findMany: async ({ where }: { where: unknown }) => state.deploymentRead.enabled
                && matchesDbMockWhere(state.deploymentRead.environment, where) ? [state.deploymentRead.environment] : [],
        },
        deploymentTargetLink: { findFirst: async ({ where }: { where: unknown }) => state.deploymentRead.enabled
            && matchesDbMockWhere(state.deploymentRead.link, where) ? state.deploymentRead.link : null },
        deployment: {
            findUnique: async ({ where }: { where: { id: string } }) => state.deploymentRead.enabled
                && where.id === state.deploymentRead.receipt.id ? state.deploymentRead.receipt : null,
            findFirst: async ({ where }: { where: unknown }) => state.deploymentRead.enabled
                && matchesDbMockWhere(state.deploymentRead.receipt, where) ? state.deploymentRead.receipt : null,
        },
    };
    const db = { ...reader, $transaction: async <T>(run: (tx: typeof reader) => Promise<T>) => run(reader) };
    return { db, state, account, otherAccount };
}

export const installedSessionExternalActionStorage = createInstalledSessionExternalActionStorage();

/** Cross-owner composed tests reach Home through this server-owned boundary. */
export async function startPhysicalOwnerSessionRpcBoundary(input: Readonly<{
    installation: MachineInstallationIdentityV1;
    receive(request: SocketRpcRequestPayload): Promise<unknown>;
}>) {
    const [{ auth }, { registerMachineAdmissionRoutes }, { rpcHandler }, { createAuthenticatedTestApp },
        { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler },
        { evaluateAccountStoredContentCompatibility }, { RPC_METHODS }, { SOCKET_RPC_EVENTS }, { accessKeysRoutes }, { featuresRoutes }] = await Promise.all([
        import('../../auth/auth'), import('../routes/machines/registerMachineAdmissionRoutes'), import('../socket/rpcHandler'),
        import('./sqliteFastify'), import('./socketHarness'), import('../../clientCompatibility/accountStoredContentCompatibility'),
        import('@happier-dev/protocol/rpc/methods'), import('@happier-dev/protocol/socketRpc'),
        import('../routes/accessKeys/accessKeysRoutes'), import('../routes/features/featuresRoutes'),
    ]);
    await auth.init();
    const { state } = installedSessionExternalActionStorage;
    state.installationId = input.installation.installationId;
    state.publicKey = decodeBase64(input.installation.publicKey, 'base64url');
    state.bound = true;
    state.operationProtocolCapabilities = {};
    state.operationProtocolCapabilitiesRevision = 0;
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    const observedHttp: Array<{ route: string; status: number }> = [];
    const startedHttp: string[] = [];
    app.addHook('onRequest', async (request: FastifyRequest) => { startedHttp.push(request.url.split('?')[0]); });
    app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
        const route = request.routeOptions.url;
        if (route !== undefined) observedHttp.push({ route, status: reply.statusCode });
    });
    registerMachineAdmissionRoutes(app);
    accessKeysRoutes(app);
    featuresRoutes(app);
    const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    const ownerToken = await auth.createToken('account', undefined, { kind: 'account', authority: 'present_user' });
    const compatibility = evaluateAccountStoredContentCompatibility({ status: 'missing' });
    const target = { id: 'actual-session-receiver', connected: true, data: { clientType: 'session-scoped', userId: 'account', sessionId: 'session',
        sessionScopedBinding: { sessionId: 'session', machineId: 'machine', proof: 'machine-access-key' },
        accountStoredContentCompatibility: compatibility }, timeout: () => ({ emitWithAck: async (_event: string, request: SocketRpcRequestPayload) => input.receive(request) }) };
    const method = `session:${RPC_METHODS.PREVIEW_ENV}`;
    const io = createSocketRoomDiscoveryHarness(async room => room === target.id || room === `rpc:account:${method}` ? [target] : []);
    return {
        baseUrl, ownerToken, homeId: state.homeId, observedHttp, startedHttp,
        withdraw: () => { state.bound = false; },
        close: async () => { await app.close(); },
        call: async (authority: 'present_user' | 'account_automation', sessionSource = false): Promise<unknown> => {
            const token = authority === 'present_user' ? ownerToken
                : await auth.createToken('account', undefined, { kind: 'terminal', authority: 'account_automation' });
            const socket = Object.assign(createAuthenticatedFakeSocket({ data: {
                clientType: sessionSource ? 'session-scoped' : 'user-scoped', authAuthority: authority,
                authTokenKind: authority === 'present_user' ? 'account' : 'terminal', authTokenEpoch: 1,
                accountStoredContentCompatibility: compatibility,
                ...(sessionSource ? { sessionId: 'session', sessionScopedBinding: target.data.sessionScopedBinding } : {}),
            } }), { handshake: { auth: { token } } });
            rpcHandler('account', socket as unknown as import('socket.io').Socket, { io });
            let result: unknown;
            await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method,
                params: { keys: ['MI1_OWNER_PREVIEW'], extraEnv: { MI1_OWNER_PREVIEW: 'owned-preview' } } },
                (response: unknown) => { result = response; });
            return result;
        },
    };
}
