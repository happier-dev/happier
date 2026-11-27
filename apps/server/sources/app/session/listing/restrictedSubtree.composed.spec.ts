import { sessionDirectGrantProjectionFixture } from '@/app/session/access/sessionAccess.testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbMocks, inTxPostgresControlStatementMock, matchesDbMockWhere } from '@/app/api/testkit/dbMocks';
import { createRouteTestBuilder } from '@/app/api/testkit/routeTestBuilder';
import { getRouteEntry } from '@/app/api/testkit/routeHarness';
import { isRestrictedAuthTokenDeniedForRoute } from '@/app/api/utils/apiTokenRouteAdmission';
import { VerifiedEphemeralSessionRunnerPrincipalSchema } from '@happier-dev/protocol/ephemeralRunner/principal';
import { SessionRuntimeManagedSubtreeListResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { registerSessionFilteredListingRoute } from '@/app/api/routes/session/registerSessionFilteredListingRoute';
import { listSessionsForAccount } from './service';
import { createV2SessionListServerTiming } from './timing';
import { resolveSessionAccessForOperation } from '@/app/session/access/sessionAccess';
import type { Tx } from '@/storage/inTx';
import { parseAccountStoredContentCompatibilityHttpHeadersV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';

const boundary = vi.hoisted(() => ({ db: undefined as unknown }));
// Only persistent storage is replaced; route, runtime currentness, graph traversal,
// access filtering, pagination, metadata projection and admission are real.
vi.mock('@/storage/db', async () => ({
    ...await import('@/config/databaseProvider'),
    get db() { return boundary.db; },
}));

const principal = VerifiedEphemeralSessionRunnerPrincipalSchema.parse({
    kind: 'ephemeral_session_runner', authority: 'session_runtime', accountId: 'account',
    activationId: '00000000-0000-4000-8000-000000000001', sessionId: 'coordinator', machineId: 'runner',
    installationId: 'installation', installationPublicKey: Buffer.alloc(32, 1).toString('base64url'), creatorTokenEpoch: 0,
});
const query: SessionListQueryV1 = { v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any',
    audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, underSessionId: principal.sessionId, limit: 2 };

function fixture() {
    const mocks = createDbMocks({ account: ['findUnique', 'findMany'], session: ['findUnique', 'findFirst', 'findMany'],
        ephemeralRunnerActivation: ['findFirst'], machine: ['findFirst'], accessKey: ['findUnique'],
        sessionFollowEdge: ['findMany'], teamMembership: ['findMany', 'findFirst'], homeSettings: ['findUnique'],
        sessionGrant: ['findMany'],  
        homeGovernancePolicy: ['findUnique'], simpleCache: ['findUnique'] });
    const account = { id: 'account', status: 'active', tokenEpoch: 0, encryptionMode: 'plain' };
    const metadata = { path: '/private-owner-workspace' };
    const ownerMetadata = createSessionOwnerMetadataV1({ metadata });
    if (!ownerMetadata.ok) throw new Error('Invalid test metadata');
    const row = (id: string, owner = account.id) => ({ id, accountId: owner, account: { ...account, id: owner },
        createdAt: new Date(1), updatedAt: new Date(id.length), meaningfulActivityAt: new Date(id.length), lastActiveAt: new Date(id.length),
        archivedAt: null, active: true, seq: 0, workDepth: 0, originKind: 'person', originRunId: null,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })), metadataVersion: 0, metadataLayoutVersion: 1,
        ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata.ownerMetadata)), agentState: null, agentStateVersion: 0,
        encryptionMode: 'plain', dataKeyEnvelopes: [], grants: [] as ReturnType<typeof sessionDirectGrantProjectionFixture>[],
          publicShare: null, turns: [], primaryTeamId: null,
        currentStorageState: 'hosted', acceptedThroughServerSeq: null, publishedThroughServerSeq: null,
        materializationPublicationId: null, materializedThroughSourceAt: null,
        pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null,
        pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0, latestTurnId: null, latestTurnStatus: null,
        latestTurnStatusObservedAt: null, latestReadyEventSeq: null, latestReadyEventAt: null, thinking: false, thinkingAt: null,
        responsibleAccountId: null, responsibleAccount: null,
    });
    const rows = [row('coordinator'), row('worker'), row('hidden', 'foreign'), row('grandchild'), row('unrelated')];
    const edges = [{ sourceSessionId: 'worker', destinationSessionId: 'coordinator', relation: 'manager' },
        { sourceSessionId: 'hidden', destinationSessionId: 'coordinator', relation: 'manager' },
        { sourceSessionId: 'grandchild', destinationSessionId: 'hidden', relation: 'manager' }];
    let current = true;
    const accounts = [...new Map(rows.map(row => [row.accountId, row.account])).values()];
    mocks.db.account.findUnique.mockImplementation(async ({ where }) => accounts.find(account => matchesDbMockWhere(account, where)) ?? null);
    mocks.db.account.findMany.mockImplementation(async ({ where }) => accounts.filter(account => matchesDbMockWhere(account, where)));
    const findRows = ({ where, skip, take }: { where?: unknown; skip?: number; take?: number }) => {
        const selected = rows.filter(row => matchesDbMockWhere(row, where ?? {}))
            .sort((a, b) => b.meaningfulActivityAt.getTime() - a.meaningfulActivityAt.getTime() || b.id.localeCompare(a.id));
        return selected.slice(skip ?? 0, take === undefined ? undefined : (skip ?? 0) + take);
    };
    mocks.db.session.findMany.mockImplementation(async args => findRows(args));
    mocks.db.session.findFirst.mockImplementation(async args => findRows(args)[0] ?? null);
    mocks.db.session.findUnique.mockImplementation(async args => findRows(args)[0] ?? null);
    mocks.db.sessionFollowEdge.findMany.mockImplementation(async ({ where }) => edges.filter(edge => matchesDbMockWhere(edge, where)));
    mocks.db.ephemeralRunnerActivation.findFirst.mockImplementation(async () => current ? { id: principal.activationId } : null);
    mocks.db.machine.findFirst.mockResolvedValue({ installationPublicKey: new Uint8Array(32).fill(1) });
    mocks.db.accessKey.findUnique.mockResolvedValue({ accountId: account.id });
    mocks.db.teamMembership.findMany.mockResolvedValue([]);
    mocks.db.sessionGrant.findMany.mockImplementation(async ({ where }) => rows
        .flatMap(row => row.grants.map(grant => ({ ...grant, sessionId: row.id })))
        .filter(grant => matchesDbMockWhere(grant, where)));
    mocks.db.homeSettings.findUnique.mockResolvedValue(null);
    mocks.db.homeGovernancePolicy.findUnique.mockResolvedValue(null);
    mocks.db.simpleCache.findUnique.mockResolvedValue({ value: 'srv_test_home' });
    const reader = { ...mocks.db, ...inTxPostgresControlStatementMock,
        async $executeRawUnsafe(sql: string, ...values: unknown[]) {
            if (sql === 'SET LOCAL jit = off' && values.length === 0) return 0;
            return inTxPostgresControlStatementMock.$executeRawUnsafe(sql, ...values);
        },
        // PostgreSQL's canonical singleton join returns one empty-Home row.
        $queryRawUnsafe: vi.fn().mockResolvedValue([{ revision: null, values: null,
            encryptedSecrets: null, authenticationPolicy: null }]),
    };
    let afterCapture: (() => void) | undefined;
    boundary.db = { ...reader, $transaction: async (read: (tx: typeof reader) => Promise<unknown>) => {
        const result = await read(reader);
        const effect = afterCapture;
        afterCapture = undefined;
        effect?.();
        return result;
    } };
    const authentication = { env: {}, authority: 'account_automation' as const, authenticationEvidence: undefined,
        sessionRuntimePrincipal: principal };
    return { mocks, rows, edges, authentication, revoke: () => { current = false; },
        access: (sessionId: string) => resolveSessionAccessForOperation(reader as unknown as Tx,
            { accountId: account.id, sessionId, authentication, capability: 'readTranscript' }),
        afterCapture: (effect: () => void) => { afterCapture = effect; },
        read: (overrides = {}) => listSessionsForAccount({ userId: account.id, authentication,
            source: { kind: 'query', query: { ...query, ...overrides } }, rowRepresentabilityWhere: {},
            timing: createV2SessionListServerTiming({}) }) };
}

describe('restricted coordinator Under-self listing', () => {
    beforeEach(() => { vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres'); });
    afterEach(() => vi.unstubAllEnvs());

    it('uses the declared root binding and the real list owner, including paging through an unreadable manager', async () => {
        const f = fixture();
        const route = createRouteTestBuilder({ method: 'POST', path: '/v2/sessions/query',
            registerRoutes: app => registerSessionFilteredListingRoute(app as never) });
        const entry = getRouteEntry(route.app, 'POST', '/v2/sessions/query');
        const request = { authTokenKind: 'ephemeral_session_runner', userId: principal.accountId,
            sessionRuntimePrincipal: principal, body: query, routeOptions: { config: entry.opts.config } };
        expect(isRestrictedAuthTokenDeniedForRoute(request as never)).toBe(false);
        expect(isRestrictedAuthTokenDeniedForRoute({ ...request, body: { ...query, underSessionId: 'unrelated' } } as never)).toBe(true);
        const response = await route.invoke({ ...request, authAuthority: 'account_automation',
            accountStoredContentCompatibility: evaluateAccountStoredContentCompatibility(
                parseAccountStoredContentCompatibilityHttpHeadersV1(currentAccountStoredContentCompatibilityHeaders)) });
        const first = SessionRuntimeManagedSubtreeListResponseV1Schema.parse(response.reply.send.mock.calls[0]?.[0]);
        expect(first.hasNext).toBe(true);
        const second = await f.read({ cursor: first.nextCursor });
        expect(second?.sessions.map(row => row.id)).toEqual(['worker']);
        expect([...first.sessions, ...second!.sessions].map(row => row.id).sort()).toEqual(['coordinator', 'grandchild', 'worker']);
        for (const row of [...first.sessions, ...second!.sessions]) {
            expect(row.effectiveAccess?.level).toBe('view');
            expect(row).not.toHaveProperty('viewer');
            expect(row).not.toHaveProperty('ownerMetadata');
            expect(row).not.toHaveProperty('receivedRuleCount');
        }
    });

    it('refuses other roots and private Account query arms, rather than borrowing Account authority', async () => {
        const f = fixture();
        for (const overrides of [{ underSessionId: 'unrelated' }, { underSessionId: undefined },
            { scope: 'following' }, { attention: 'needs_my_attention' }, { tagIds: { include: ['private'], exclude: [] } },
            { folderIds: ['private'] }, { projectKeys: { include: ['private'], exclude: [] } },
            { membership: { mode: 'manual_only' as const, tagIds: ['private'] } }, { includeAttention: true }]) {
            await expect(f.read(overrides)).rejects.toMatchObject({ code: 'credential_scope_denied' });
        }
        expect(await f.access('worker')).toMatchObject({ status: 'unavailable' });
        expect(await f.access('coordinator')).toMatchObject({ status: 'allowed' });
    });

    it('releases the storage snapshot before mapping the admitted Session page', async () => {
        const f = fixture();
        const coordinator = f.rows.find(row => row.id === 'coordinator')!;
        let snapshotClosed = false;
        const mappingPhases: boolean[] = [];
        const readCreatedAt = coordinator.createdAt.getTime.bind(coordinator.createdAt);
        coordinator.createdAt.getTime = () => {
            mappingPhases.push(snapshotClosed);
            return readCreatedAt();
        };
        f.afterCapture(() => { snapshotClosed = true; });

        const page = await f.read();
        expect(page?.sessions.find(row => row.id === 'coordinator')?.createdAt).toBe(1);
        // Selection can also read this Date. The final access serializes the admitted row.
        expect(mappingPhases.at(-1)).toBe(true);
    });

    it('retains admitted graph membership and runtime authority until the next request', async () => {
        const detached = fixture();
        detached.afterCapture(() => { detached.edges.splice(0, detached.edges.length); });
        expect((await detached.read({ limit: 50 }))?.sessions.map(row => row.id).sort()).toEqual(['coordinator', 'grandchild', 'worker']);
        expect((await detached.read({ limit: 50 }))?.sessions.map(row => row.id)).toEqual(['coordinator']);
        const revoked = fixture();
        revoked.afterCapture(revoked.revoke);
        expect((await revoked.read())?.sessions).toHaveLength(2);
        await expect(revoked.read()).rejects.toMatchObject({ code: 'credential_scope_denied' });
    });

    it('retains an admitted shared worker and removes it on the next request after revocation', async () => {
        const f = fixture();
        const hidden = f.rows.find(row => row.id === 'hidden')!;
        hidden.grants.push(sessionDirectGrantProjectionFixture({ id: 'worker-read', accountId: principal.accountId,
            account: { status: 'active' }, accessLevel: 'view', canApprovePermissions: false }));
        f.afterCapture(() => { hidden.grants.length = 0; });
        expect((await f.read({ limit: 50 }))?.sessions.map(row => row.id).sort()).toEqual(['coordinator', 'grandchild', 'hidden', 'worker']);
        expect((await f.read({ limit: 50 }))?.sessions.map(row => row.id).sort()).toEqual(['coordinator', 'grandchild', 'worker']);
    });
});
