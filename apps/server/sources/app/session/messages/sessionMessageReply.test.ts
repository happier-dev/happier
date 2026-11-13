import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionMessageReplyProgressV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { createDbMocks, createDbTransactionMock, inTxPostgresControlStatementMock, installDbModuleMock,
    matchesDbMockWhere } from '@/app/api/testkit/dbMocks';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { decodeBase64 } from 'privacy-kit';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { SessionMessageReplyMutationV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

const boundary = createDbMocks({ sessionMessage: ['findMany', 'findUnique', 'findFirst', 'updateMany'],
    sessionPendingMessage: ['findMany', 'findUnique'], session: ['findUnique', 'findFirst'], machine: ['findUnique', 'findMany'], accessKey: ['findUnique'] });
const transactions = createDbTransactionMock(() => ({ ...boundary.db, ...inTxPostgresControlStatementMock }));
// Only Prisma's persistent connection is replaced; custody, strict parsing,
// transaction context, final selection and replay decisions remain production code.
installDbModuleMock({ db: transactions.wrapDb(boundary.db) });
const { inTx } = await import('@/storage/inTx');
const { projectSessionInputRepliesFromTurnInTx, mutateSessionMessageReplyInTx } = await import('./sessionMessageReply');

beforeEach(() => { boundary.reset(); vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres'); });
afterEach(() => vi.unstubAllEnvs());

it.each(['partial', 'empty', 'explicit', 'late-partial', 'late-returned'] as const)('retains the exact cancelled foreground outcome through replay (%s)', async kind => {
    const progress: SessionMessageReplyProgressV1 = { v: 1, mode: 'wait', acceptedTurnId: 'stopped-turn', disposition: 'observing',
        ...(kind === 'explicit' ? { outcome: { kind: 'pass' } } : {}) };
    const input = { id: 'input-row', sessionId: 'session', seq: 1, localId: 'input', messageRole: 'user', sidechainId: null,
        targetExecutionRunId: null, replyDisposition: 'observing', inputAdmissionReceipt: null, replyProgress: progress };
    const foreign: typeof input = { ...input, id: 'foreign-input', seq: 4, localId: 'foreign',
        replyProgress: { ...progress, acceptedTurnId: 'another-turn' } };
    const final = { id: 'stopped-partial', sessionId: 'session', seq: 2, localId: 'partial', messageRole: 'agent', sidechainId: null };
    const rows = [input, foreign, final, { ...final, id: 'unrelated-later', seq: 5 }];
    boundary.db.session.findUnique.mockResolvedValue(null);
    boundary.db.sessionPendingMessage.findUnique.mockResolvedValue(null);
    boundary.db.sessionPendingMessage.findMany.mockResolvedValue([]);
    boundary.db.sessionMessage.findMany.mockImplementation(async ({ where }: { where: unknown }) => rows.filter(row => matchesDbMockWhere(row, where)));
    boundary.db.sessionMessage.findFirst.mockImplementation(async ({ where }: { where: unknown }) => rows.find(row => matchesDbMockWhere(row, where)) ?? null);
    boundary.db.sessionMessage.findUnique.mockImplementation(async ({ where }: { where: { sessionId_localId: unknown } }) =>
        rows.find(row => matchesDbMockWhere(row, where.sessionId_localId)) ?? null);
    boundary.db.sessionMessage.updateMany.mockImplementation(async ({ where, data }: { where: unknown; data: { replyProgress: SessionMessageReplyProgressV1 } }) => {
        const row = [input, foreign].find(row => matchesDbMockWhere(row, where));
        if (!row) return { count: 0 };
        row.replyProgress = data.replyProgress;
        return { count: 1 };
    });
    const stopped = { sessionId: 'session', turnId: 'stopped-turn', status: 'cancelled',
        transcriptAnchorsJson: JSON.stringify({ userMessageSeqs: [1, 4], ...(kind !== 'empty' ? { finalAssistantMessageSeq: 2 } : {}) }) };
    if (kind === 'late-partial' || kind === 'late-returned') {
        await inTx(tx => projectSessionInputRepliesFromTurnInTx(tx, {
            ...stopped, transcriptAnchorsJson: JSON.stringify({ userMessageSeqs: [1, 4] }),
        }));
        expect(input.replyProgress.outcome).toEqual({ kind: 'cancelled' });
        if (kind === 'late-returned') input.replyProgress = { ...input.replyProgress, disposition: 'returned' };
    }
    await inTx(tx => projectSessionInputRepliesFromTurnInTx(tx, stopped));
    await inTx(tx => projectSessionInputRepliesFromTurnInTx(tx, stopped));
    expect(input.replyProgress.outcome).toEqual(kind === 'explicit' ? { kind: 'pass' } : kind === 'empty' || kind === 'late-returned' ? { kind: 'cancelled' }
        : { kind: 'cancelled', result: { sessionId: 'session', messageId: 'stopped-partial' } });
    expect(foreign.replyProgress).toEqual({ ...progress, acceptedTurnId: 'another-turn' });
    expect(JSON.stringify(input.replyProgress)).not.toContain('partialText');
});

it('proves a native cancelled partial by its exact admitted Run, sidechain, turn and committed row without reading ciphertext', async () => {
    vi.stubEnv('HAPPIER_DB_PROVIDER', 'sqlite');
    const account = { status: 'active', encryptionMode: 'plain' };
    const session = { id: 'session', accountId: 'account', account, active: true, archivedAt: null, lastActiveAt: new Date(1),
        grants: [],   currentStorageState: 'hosted' };
    const machine = { id: 'machine', kind: 'persistent', accountId: 'account', account, active: true,
        revokedAt: null, replacedByMachineId: null, installationId: 'installation', metadata: encodePlainMachineStoredContent({}), daemonState: null,
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), accountGrants: [], teamGrants: [], groupGrants: [] };
    const input = { id: 'input', sessionId: session.id, localId: 'ask', seq: 2, targetExecutionRunId: 'run', sidechainId: 'sidechain',
        inputAdmissionReceipt: null, replyProgress: { v: 1, mode: 'wait', acceptedTurnId: 'native-turn', disposition: 'observing' } as SessionMessageReplyProgressV1 };
    const result = { id: 'partial', sessionId: session.id, localId: 'native-partial', seq: 3, sidechainId: 'sidechain', messageRole: 'agent' };
    boundary.db.session.findUnique.mockResolvedValue(session);
    boundary.db.session.findFirst.mockResolvedValue(session);
    boundary.db.machine.findUnique.mockResolvedValue(machine);
    boundary.db.machine.findMany.mockResolvedValue([machine]);
    boundary.db.accessKey.findUnique.mockResolvedValue({ session, machine });
    boundary.db.sessionPendingMessage.findUnique.mockResolvedValue(null);
    boundary.db.sessionMessage.findUnique.mockResolvedValue(input);
    boundary.db.sessionMessage.findFirst.mockImplementation(async ({ where }: { where: unknown }) => matchesDbMockWhere(result, where) ? result : null);
    boundary.db.sessionMessage.updateMany.mockImplementation(async ({ data }: { data: { replyProgress: SessionMessageReplyProgressV1 } }) => {
        input.replyProgress = data.replyProgress; return { count: 1 };
    });
    const nativeResult = { runId: 'run', sidechainId: 'sidechain', localId: 'native-partial' };
    const outcome = { kind: 'cancelled' as const, result: { sessionId: session.id, messageId: result.id } };
    const fulfill = (proof = nativeResult, turnId = 'native-turn') => inTx(tx => mutateSessionMessageReplyInTx(tx, {
        accountId: 'account', authentication: createPresentUserSessionAccessAuthentication(),
        publisherAuthority: { accountId: 'account', machineId: 'machine', sessionId: session.id, committedFence: new Date(1) },
        mutation: SessionMessageReplyMutationV1Schema.parse({ v: 1, sessionId: session.id, requestSessionId: session.id, requestLocalId: input.localId,
            operation: { kind: 'fulfill', turnId, outcome, nativeResult: proof } }),
    }));
    expect(await fulfill({ ...nativeResult, runId: 'other-run' })).toMatchObject({ ok: false, error: 'conflict' });
    expect(await fulfill({ ...nativeResult, sidechainId: 'other-sidechain' })).toMatchObject({ ok: false, error: 'conflict' });
    expect(await fulfill({ ...nativeResult, localId: 'unrelated-row' })).toMatchObject({ ok: false, error: 'conflict' });
    expect(await fulfill(nativeResult, 'other-turn')).toMatchObject({ ok: false, error: 'conflict' });
    result.seq = 1;
    expect(await fulfill()).toMatchObject({ ok: false, error: 'conflict' });
    result.seq = 3;
    expect(await fulfill()).toMatchObject({ ok: true, progress: { outcome } });
    expect(await fulfill()).toMatchObject({ ok: true, progress: { outcome } });
    input.replyProgress = { ...input.replyProgress, outcome: { kind: 'pass' } };
    expect(await fulfill()).toMatchObject({ ok: false, error: 'conflict' });
    expect(input.replyProgress.outcome).toEqual({ kind: 'pass' });
});
