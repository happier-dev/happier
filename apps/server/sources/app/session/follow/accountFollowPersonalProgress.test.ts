import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { deriveSessionFollowOriginalOccurrenceKeyV1, resolveExecutionRunFollowOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { createDbMocks, createDbTransactionMock, installDbModuleMock, matchesDbMockWhere } from '@/app/api/testkit/dbMocks';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import type { ExecutionRunFollowFrontierWitness } from './executionRunFollowSource';
import { sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { encodeAccountScopedKvJson } from '@/app/kv/accountScopedKv';
import { buildSessionFollowRulePhysicalKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';

const boundary = createDbMocks({ account: ['findUnique', 'findMany', 'update'], session: ['findUnique', 'findMany'], machine: ['findUnique', 'findMany'],
    sessionShare: ['findMany'], sessionTeamGrant: ['findMany'], sessionGroupGrant: ['findMany'],
    accessKey: ['findUnique'], userKVStore: ['findUnique'], sessionMessage: ['findUnique'],
    accountSessionFollow: ['findUnique', 'updateMany', 'upsert'], accountChange: ['upsert'], accountPushToken: ['findMany'] });
const transactions = createDbTransactionMock(() => ({ ...boundary.db,
    $executeRawUnsafe: async (query: string, accountId: string) => {
        if (query === 'UPDATE "Account" SET "settingsVersion" = "settingsVersion" WHERE "id" = ?' && accountId === 'account') return 1;
        throw new Error('Unexpected fixture SQL');
    },
}));
// Only the persistent connection is replaced. Source/currentness, Account mode,
// policy, mute, occurrence selection, CAS and publication execute real code.
installDbModuleMock({ db: transactions.wrapDb(boundary.db) });
const { acceptAccountFollowPersonalProgress } = await import('./accountFollowPersonalProgress');
const { inTx } = await import('@/storage/inTx');
const { readAccountRunFollowDeliveryInTx, setOtherAccountFollow } = await import('./accountFollowService');
const { admitSessionFollowRuleOccurrenceInTx } = await import('./sessionFollowRuleProgress');

beforeEach(() => { boundary.reset(); vi.stubEnv('HAPPIER_DB_PROVIDER', 'sqlite'); vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', 'srv_home'); });
afterEach(() => vi.unstubAllEnvs());

function fixture() {
    const account = { id: 'account', status: 'active', encryptionMode: 'plain', publicKey: null, contentPublicKey: null,
        contentPublicKeySig: null, settings: null, settingsVersion: 0, seq: 0, deliveryMutes: null as string | null };
    const target = { homeId: 'srv_home', accountId: account.id, sessionId: 'session', machineId: 'machine', installationId: 'installation' };
    const session = { id: 'session', accountId: account.id, account, archivedAt: null, runtimeMachineTarget: target,
        publisherGeneration: 1n, currentStorageState: 'hosted', shares: [], teamGrants: [], groupGrants: [] };
    const machine = { id: 'machine', kind: 'persistent', accountId: account.id, account, installationId: 'installation',
        revokedAt: null, replacedByMachineId: null, active: true, metadata: encodePlainMachineStoredContent({}), daemonState: null,
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), accountGrants: [], teamGrants: [], groupGrants: [] };
    const follow = { sessionId: null, sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'execution_run', sessionId: session.id, runId: 'run' }), sourceDiscussionId: null,
        sourceExecutionRunSessionId: session.id, sourceExecutionRunId: 'run', sourceWorkflowRunId: null,
        accountId: account.id, following: true, hasPersistentFollow: true, followPolicy: '{"preset":"important"}',
        deliveredExecutionRunTerminalEventId: null, deliveredExecutionRunPermissionKey: null as string | null, deliveredWorkflowRunRevision: null };
    const frontier: { -readonly [K in keyof ExecutionRunFollowFrontierWitness]: ExecutionRunFollowFrontierWitness[K] } = { source: { kind: 'execution_run', sessionId: session.id, runId: 'run' },
        machineCustodianAccountId: account.id,
        status: 'running', terminalEventId: null, attention: { kind: 'permission_required', requestIds: ['permission'],
            requests: [{ requestId: 'permission', createdAt: 10 }] }, target, publisherGeneration: '1' };
    boundary.db.account.findUnique.mockResolvedValue(account);
    boundary.db.account.update.mockImplementation(async () => ({ ...account, seq: ++account.seq }));
    boundary.db.accountChange.upsert.mockResolvedValue({ cursor: 1 });
    boundary.db.accountPushToken.findMany.mockResolvedValue([]);
    boundary.db.session.findUnique.mockResolvedValue(session);
    boundary.db.machine.findUnique.mockResolvedValue(machine);
    boundary.db.machine.findMany.mockResolvedValue([machine]);
    boundary.db.accessKey.findUnique.mockResolvedValue({ session, machine });
    boundary.db.accountSessionFollow.findUnique.mockResolvedValue(follow);
    boundary.db.accountSessionFollow.upsert.mockImplementation(async ({ update }: { update: Partial<typeof follow> }) => {
        Object.assign(follow, update); return follow;
    });
    boundary.db.accountSessionFollow.updateMany.mockImplementation(async ({ where, data }: { where: unknown; data: Partial<typeof follow> }) => {
        if (!matchesDbMockWhere(follow, where)) return { count: 0 };
        Object.assign(follow, data);
        return { count: 1 };
    });
    const authentication = createPresentUserSessionAccessAuthentication();
    const occurrence = () => {
        const value = resolveExecutionRunFollowOccurrenceV1({ ...frontier, sessionId: session.id, runId: 'run' });
        if (!value) throw new Error('Expected a real Run permission occurrence');
        return value;
    };
    const read = () => inTx(tx => readAccountRunFollowDeliveryInTx(tx, { accountId: account.id, authentication, ...occurrence() }));
    const accept = (original = occurrence().original) => acceptAccountFollowPersonalProgress({ accountId: account.id, authentication,
        occurrence: { original }, executionRunFrontier: frontier });
    const set = (preset: 'important' | 'quiet') => setOtherAccountFollow({ accountId: account.id, source: frontier.source,
        policy: { preset }, authentication, executionRunFrontier: frontier });
    return { account, follow, frontier, occurrence, read, accept, set };
}

it('settles one exact personal permission occurrence, preserves the terminal cursor and admits reused ids only with a new creation time', async () => {
    const f = fixture();
    expect(await f.read()).toMatchObject({ represented: false });
    expect(await f.accept()).toEqual({ ok: true, value: { accepted: true, alreadyRepresented: false } });
    expect(f.follow.deliveredExecutionRunPermissionKey).toBe(deriveSessionFollowOriginalOccurrenceKeyV1(f.occurrence().original));
    expect(f.follow.deliveredExecutionRunTerminalEventId).toBeNull();
    expect(await f.accept()).toEqual({ ok: true, value: { accepted: true, alreadyRepresented: true } });
    expect(await f.read()).toMatchObject({ represented: true });
    f.frontier.attention = { kind: 'permission_required', requestIds: ['permission'], requests: [{ requestId: 'permission', createdAt: 11 }] };
    expect(await f.read()).toMatchObject({ represented: false });
    expect(await f.accept()).toMatchObject({ value: { accepted: true, alreadyRepresented: false } });
    const permissionKey = f.follow.deliveredExecutionRunPermissionKey;
    f.frontier.status = 'succeeded';
    f.frontier.terminalEventId = 'terminal';
    expect(await f.accept()).toMatchObject({ value: { accepted: true, alreadyRepresented: false } });
    expect(await f.accept()).toMatchObject({ value: { accepted: true, alreadyRepresented: true } });
    expect(f.follow.deliveredExecutionRunTerminalEventId).toBe('terminal');
    expect(f.follow.deliveredExecutionRunPermissionKey).toBe(permissionKey);
});

it('seeds a new personal Follow at the current permission frontier without reseeding an active policy edit', async () => {
    const f = fixture();
    f.follow.following = false;
    expect(await f.set('important')).toMatchObject({ ok: true, value: { changed: true } });
    expect(await f.accept()).toMatchObject({ value: { accepted: true, alreadyRepresented: true } });
    const seeded = f.follow.deliveredExecutionRunPermissionKey;
    f.frontier.attention = { kind: 'permission_required', requestIds: ['new'], requests: [{ requestId: 'new', createdAt: 12 }] };
    expect(await f.set('quiet')).toMatchObject({ ok: true, value: { changed: true } });
    expect(f.follow.deliveredExecutionRunPermissionKey).toBe(seeded);
    expect(await f.read()).toMatchObject({ represented: false });
});

it('withdraws cleared/replaced personal permissions and respects the same receiver mute and Follow policy', async () => {
    const f = fixture();
    const original = f.occurrence().original;
    f.frontier.attention = undefined;
    expect(await f.accept(original)).toMatchObject({ value: { accepted: false } });
    f.frontier.attention = { kind: 'permission_required', requestIds: ['replacement'], requests: [{ requestId: 'replacement', createdAt: 12 }] };
    expect(await f.accept(original)).toMatchObject({ value: { accepted: false } });
    f.account.deliveryMutes = JSON.stringify([{ kind: 'source', source: f.frontier.source }]);
    expect(await f.accept()).toMatchObject({ value: { accepted: false } });
    f.account.deliveryMutes = null;
    f.follow.followPolicy = JSON.stringify({ preset: 'custom', events: {} });
    expect(await f.accept()).toMatchObject({ value: { accepted: false } });
    expect(f.follow.deliveredExecutionRunPermissionKey).toBeNull();
});

it('reads personal receiver mute policy once across matching rules and reads the next intake fresh', async () => {
    const f = fixture();
    const source = { id: 'source', accountId: 'source-owner', account: { ...f.account, id: 'source-owner' }, archivedAt: null,
        seq: 2, agentStateVersion: 0, publisherGeneration: 1n, encryptionMode: 'plain', currentStorageState: 'hosted',
        shares: [{ sharedWithUserId: f.account.id, accessLevel: 'view', canApprovePermissions: false }], teamGrants: [], groupGrants: [],
        accountFollows: [{ following: true, followPolicy: '{"preset":"important"}' }], accountReadStates: [] };
    boundary.db.session.findUnique.mockResolvedValue(source);
    boundary.db.sessionMessage.findUnique.mockResolvedValue({ seq: 2, sidechainId: null, createdAt: new Date(10), messageRole: 'agent',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Update' } } }, inputAdmissionReceipt: null });
    const rules = ['first', 'second'].map(ruleId => ({ ruleId, ruleVersion: 0 }));
    boundary.db.userKVStore.findUnique.mockImplementation(async ({ where }: { where: { accountId_key: { key: string } } }) => {
        const rule = rules.find(rule => buildSessionFollowRulePhysicalKeyV1(rule.ruleId) === where.accountId_key.key);
        if (!rule) return null;
        const value = encodeAccountScopedKvJson({ version: 0, receiver: { kind: 'account' }, inception: { createdAt: 1 },
            content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } },
            sources: [{ sourceSessionId: source.id, delivered: { transcriptSeq: 2, readyEventSeq: 0, agentStateVersion: 0, turn: null } }] });
        if (!value) throw new Error('Expected encoded rule');
        return { version: 0, value: decodeBase64(value), createdAt: new Date(1) };
    });
    const accept = () => acceptAccountFollowPersonalProgress({ accountId: f.account.id,
        authentication: createPresentUserSessionAccessAuthentication(), occurrence: {
            evaluation: 'receiver', production: 'source', sourceSessionId: source.id, rules, sourceMessage: { localId: 'message', seq: 2 },
        } });
    const muteReads = () => boundary.db.account.findUnique.mock.calls.filter(([input]) =>
        input.select && Object.keys(input.select).join() === 'deliveryMutes').length;
    expect(await accept()).toEqual({ ok: true, value: { accepted: true, alreadyRepresented: true } });
    expect(muteReads()).toBe(1);
    f.account.deliveryMutes = JSON.stringify([{ kind: 'source', source: { kind: 'rule', ruleId: 'second' } }]);
    expect(await accept()).toEqual({ ok: true, value: { accepted: false, alreadyRepresented: false } });
    expect(muteReads()).toBe(2);
    f.account.deliveryMutes = null;
    expect(await accept()).toMatchObject({ value: { accepted: true } });
    expect(muteReads()).toBe(3);
    source.shares = [];
    expect(await accept()).toMatchObject({ value: { accepted: false } });
    expect(muteReads()).toBe(3);
});

it('shares the Session receiver mute read across source and rule admission while retaining each mute decision', async () => {
    const f = fixture();
    const receiver = { kind: 'session', sessionId: 'destination' } as const;
    const source = { id: 'source', accountId: f.account.id, account: f.account, archivedAt: null, encryptionMode: 'plain',
        seq: 2, agentStateVersion: 0, publisherGeneration: 1n, currentStorageState: 'hosted', publicShare: null,
        shares: [], teamGrants: [], groupGrants: [] };
    const destination = { ...source, id: receiver.sessionId, deliveryMutes: null as string | null };
    boundary.db.session.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === source.id ? source : where.id === destination.id ? destination : null);
    boundary.db.session.findMany.mockImplementation(async ({ where }: { where: { id: { in: readonly string[] } } }) =>
        [source, destination].filter(row => where.id.in.includes(row.id)));
    boundary.db.account.findMany.mockResolvedValue([{ id: f.account.id }]);
    boundary.db.sessionShare.findMany.mockResolvedValue([]);
    boundary.db.sessionTeamGrant.findMany.mockResolvedValue([]);
    boundary.db.sessionGroupGrant.findMany.mockResolvedValue([]);
    const value = encodeAccountScopedKvJson({ version: 0, receiver, inception: { createdAt: 1 }, content: { t: 'plain', v: {
        v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' },
    } } });
    if (!value) throw new Error('Expected encoded rule');
    boundary.db.userKVStore.findUnique.mockResolvedValue({ version: 0, value: decodeBase64(value), createdAt: new Date(1) });
    boundary.db.sessionMessage.findUnique.mockResolvedValue({ seq: 2, sidechainId: null, createdAt: new Date(10), messageRole: 'agent',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Update' } } }, inputAdmissionReceipt: null });
    const admit = () => inTx(tx => admitSessionFollowRuleOccurrenceInTx(tx, { accountId: f.account.id,
        authority: { kind: 'account', admitted: true, authentication: createPresentUserSessionAccessAuthentication() },
        witness: { sourceSessionId: source.id, destinationSessionId: destination.id, rule: { ruleId: 'first', ruleVersion: 0 }, selectedDelivery: 'next_turn',
            machineId: 'machine', installationId: 'installation', expectedSourcePublisherGeneration: '1', sourceMessage: { localId: 'message', seq: 2 } },
    }));
    const muteReads = () => boundary.db.session.findUnique.mock.calls.filter(([input]) =>
        input.select && Object.keys(input.select).join() === 'deliveryMutes').length;
    expect(await admit()).toMatchObject({ source: { id: source.id }, destination: { id: destination.id } });
    expect(muteReads()).toBe(1);
    destination.deliveryMutes = JSON.stringify([{ kind: 'source', source: { kind: 'rule', ruleId: 'first' } }]);
    expect(await admit()).toBeNull();
    expect(muteReads()).toBe(2);
    destination.deliveryMutes = JSON.stringify([{ kind: 'source', source: { kind: 'session', sessionId: source.id } }]);
    expect(await admit()).toBeNull();
    expect(muteReads()).toBe(3);
    destination.deliveryMutes = null;
    expect(await admit()).not.toBeNull();
    expect(muteReads()).toBe(4);
});
