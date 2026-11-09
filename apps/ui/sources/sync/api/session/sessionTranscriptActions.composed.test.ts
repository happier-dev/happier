import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';

const homes = createHomeGovernanceHarness();
const httpBoundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
installHomeGovernanceBoundaries(httpBoundary);
installDisconnectedServerSocketBoundary();
const { readSessionTranscriptForAction } = await import('./sessionTranscriptActions');
const { getStorage } = await import('@/sync/domains/state/storage');
const initial = getStorage().getState();
beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(httpBoundary); });
afterEach(() => { getStorage().setState(initial, true); standardCleanup(); });

const sourceText = 'The complete committed source answer. '.repeat(1000).trim();
type ResponseMode = 'current' | 'wrong-id' | 'multiple' | 'more' | 'before-cursor' | 'after-cursor' | 'missing' | 'encrypted-mismatch';

async function fixture(options: Readonly<{ sidechainId?: string }> = {}) {
    const serverId = await homes.addHome({ name: 'Source', serverUrl: 'https://transcript-source.test', accountId: 'alice', currentAccount: true });
    await homes.addHome({ name: 'Focused', serverUrl: 'https://transcript-focused.test', accountId: 'bob', currentAccount: true });
    const session = createSessionFixture({ id: 'source-session', encryptionMode: 'plain', access: createSessionAccessFixture('view') });
    let denied = false;
    homes.answer(serverId, `/v2/sessions/${session.id}`, { select: () => denied
        ? { status: 403, body: { error: 'forbidden' } }
        : { body: createPlainSessionByIdResponseFixture(session) } });
    const rows = Array.from({ length: 1000 }, (_, index) => SessionMessageV1Schema.parse({
        id: `message-${index + 1}`, seq: index + 1, localId: null, messageRole: 'agent', sidechainId: options.sidechainId ?? null,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: index === 24 ? sourceText : `Unrelated answer ${index + 1}` } } },
        createdAt: index + 1,
    }));
    const source = rows[24]!;
    const messageRequests: URL[] = [];
    let acquiredRows = 0;
    let responseMode: ResponseMode = 'current';
    let held: Promise<void> | undefined;
    const entered = createDeferred<void>();
    homes.answer(serverId, `/v1/sessions/${session.id}/messages`, { select: (_input, request) => {
        const url = new URL(request.url);
        messageRequests.push(url);
        const messageId = url.searchParams.get('messageId');
        const scope = url.searchParams.get('scope') ?? 'main';
        const scoped = rows.filter(row => scope === 'all' || (scope === 'sidechain'
            ? row.sidechainId === url.searchParams.get('sidechainId') : row.sidechainId === null));
        const selected = messageId ? scoped.filter(row => row.id === messageId)
            : scoped.filter(row => !url.searchParams.has('beforeSeq') || row.seq < Number(url.searchParams.get('beforeSeq')))
                .slice(-Number(url.searchParams.get('limit') ?? 200));
        const messages = responseMode === 'encrypted-mismatch' ? [{ ...source, content: { t: 'encrypted', c: 'opaque-ciphertext' } }]
            : responseMode === 'missing' ? [] : responseMode === 'wrong-id' ? [rows[0]!]
            : responseMode === 'multiple' ? [source, rows[0]!] : selected;
        acquiredRows += messages.length;
        entered.resolve();
        return { body: { messages, hasMore: responseMode === 'more' || (!messageId && (messages[0]?.seq ?? 1) > 1),
            nextBeforeSeq: responseMode === 'before-cursor' ? 10 : messageId ? null : messages[0]?.seq ?? null,
            nextAfterSeq: responseMode === 'after-cursor' ? 10 : null }, ...(held ? { respondAfter: held } : {}) };
    } });
    return { scope: { serverId, accountId: 'alice' }, session, source, messageRequests,
        costs: () => ({ messageRequests: messageRequests.length, acquiredRows }),
        deny: () => { denied = true; }, setResponse: (mode: ResponseMode) => { responseMode = mode; },
        hold: (promise: Promise<void>) => { held = promise; }, entered: entered.promise };
}

it('reads one old committed message through the exact Home semantic reader without acquiring unrelated bodies', async () => {
    const state = await fixture();
    const input = { context: { surface: 'ui' as const }, sessionId: state.session.id, messageId: state.source.id,
        roles: ['assistant'] as const, scope: 'main' as const };
    const result = await readSessionTranscriptForAction(input, state.scope);
    console.info('Exact semantic transcript read cost', state.costs(), result.ok ? result.diagnostics : result);
    expect(result.ok).toBe(true);
    expect(state.costs()).toEqual({ messageRequests: 1, acquiredRows: 1 });
    expect(result).toMatchObject({ ok: true, items: [{ id: state.source.id, seq: 25, semanticRole: 'assistant', text: sourceText }],
        hasMore: false, nextCursor: null, diagnostics: { rawRowsScanned: 1, pagesFetched: 1, payloadTruncations: 0 } });
    if (result.ok) { expect(result.items).toHaveLength(1); expect(result.items[0]).not.toHaveProperty('raw'); }
    const query = state.messageRequests[0]!.searchParams;
    expect(query.get('messageId')).toBe(state.source.id);
    expect(query.has('limit')).toBe(false);
    expect(homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname.endsWith('/messages'))
        .map(request => request.serverId)).toEqual([state.scope.serverId]);
});

it('retains ordinary transcript pagination when no exact message is requested', async () => {
    const state = await fixture();
    const input = { context: { surface: 'ui' as const }, sessionId: state.session.id, limit: 7 };
    const first = await readSessionTranscriptForAction(input, state.scope);
    expect(first).toMatchObject({ ok: true, hasMore: true, nextCursor: '994' });
    if (!first.ok) throw new Error(first.errorCode);
    expect(first.items.map(row => row.seq)).toEqual([994, 995, 996, 997, 998, 999, 1000]);
    const next = await readSessionTranscriptForAction({ ...input, cursor: first.nextCursor }, state.scope);
    expect(next).toMatchObject({ ok: true, hasMore: true, nextCursor: '987' });
    if (!next.ok) throw new Error(next.errorCode);
    expect(next.items.map(row => row.seq)).toEqual([987, 988, 989, 990, 991, 992, 993]);
    expect(state.costs()).toEqual({ messageRequests: 2, acquiredRows: 14 });
});

it.each(['wrong-id', 'multiple', 'more', 'before-cursor', 'after-cursor'] as const)('refuses an exact read whose response is %s instead of falling back to history', async mode => {
    const state = await fixture();
    state.setResponse(mode);
    const input = { context: { surface: 'ui' as const }, sessionId: state.session.id, messageId: state.source.id };
    expect(await readSessionTranscriptForAction(input, state.scope)).toMatchObject({ ok: false, errorCode: 'session_transcript_unavailable' });
    expect(state.messageRequests).toHaveLength(1);
});

it('keeps role filtering, sidechain scope, explicit truncation and an empty exact result on the same semantic path', async () => {
    const state = await fixture({ sidechainId: 'branch-a' });
    const input = { context: { surface: 'ui' as const }, sessionId: state.session.id, messageId: state.source.id,
        scope: 'sidechain' as const, sidechainId: 'branch-a' };
    expect(await readSessionTranscriptForAction({ ...input, roles: ['user'] }, state.scope)).toMatchObject({ ok: true, items: [], hasMore: false });
    expect(await readSessionTranscriptForAction({ ...input, maxCharsPerMessage: 12 }, state.scope))
        .toMatchObject({ ok: true, items: [{ id: state.source.id, text: sourceText.slice(0, 12), truncated: true }] });
    expect(state.messageRequests.map(url => [url.searchParams.get('scope'), url.searchParams.get('sidechainId')]))
        .toEqual([['sidechain', 'branch-a'], ['sidechain', 'branch-a']]);
    state.setResponse('missing');
    expect(await readSessionTranscriptForAction(input, state.scope)).toMatchObject({ ok: true, items: [], hasMore: false, nextCursor: null });
});

it('rechecks current Session grants before repeating an exact read', async () => {
    const state = await fixture();
    const input = { context: { surface: 'ui' as const }, sessionId: state.session.id, messageId: state.source.id };
    expect(await readSessionTranscriptForAction(input, state.scope)).toMatchObject({ ok: true });
    state.deny();
    expect(await readSessionTranscriptForAction(input, state.scope)).toMatchObject({ ok: false });
    expect(state.messageRequests).toHaveLength(1);
});

it('fails an exact stored-envelope mode mismatch without exposing ciphertext as source text', async () => {
    const state = await fixture();
    state.setResponse('encrypted-mismatch');
    const input = { context: { surface: 'ui' as const }, sessionId: state.session.id, messageId: state.source.id };
    expect(await readSessionTranscriptForAction(input, state.scope)).toMatchObject({ ok: false, errorCode: 'session_transcript_content_unavailable' });
    expect(state.messageRequests).toHaveLength(1);
});

it('does not disclose an exact response after the captured Account is replaced while HTTP is in flight', async () => {
    const state = await fixture();
    const release = createDeferred<void>();
    state.hold(release.promise);
    const input = { context: { surface: 'ui' as const }, sessionId: state.session.id, messageId: state.source.id };
    const pending = readSessionTranscriptForAction(input, state.scope);
    await state.entered;
    await homes.switchAccount(state.scope.serverId, 'replacement');
    release.resolve();
    expect(await pending).toMatchObject({ ok: false });
});
