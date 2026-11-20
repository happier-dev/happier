import { afterEach, beforeEach, expect, it } from 'vitest';
import { createSessionToolOutputBindingV1 } from '@happier-dev/protocol/sessions/messages/sessionToolOutputBindingV1';
import { standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const homes = createHomeGovernanceHarness();
const boundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
installHomeGovernanceBoundaries(boundary);
installDisconnectedServerSocketBoundary();
const { readSessionToolOutput } = await import('./sessionToolOutput');
const { getStorage } = await import('@/sync/domains/state/storage');
const initial = getStorage().getState();
beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(boundary); });
afterEach(() => { getStorage().setState(initial, true); standardCleanup(); });

it('expands only a bound result on the captured Home and leaves an expired row empty', async () => {
    const serverId = await homes.addHome({ name: 'Source', serverUrl: 'https://output-source.test', accountId: 'viewer', currentAccount: true });
    await homes.addHome({ name: 'Focused', serverUrl: 'https://output-focused.test', accountId: 'other', currentAccount: true });
    const session = createSessionFixture({ id: 'source-session', encryptionMode: 'plain', access: createSessionAccessFixture('view') });
    homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
    const localId = 'result-local';
    const toolUseId = 'shell-use';
    const part = { t: 'plain', v: { v: 1, fields: { stdout: 'synthetic output' }, textBlocks: [{ index: 0, text: 'synthetic text block' }] } } as const;
    const shell = { role: 'agent', content: { type: 'acp', data: { type: 'tool-result', callId: toolUseId,
        output: { exitCode: 0, content: [{ type: 'text', text: '' }] } } },
    meta: { happierToolOutputV1: createSessionToolOutputBindingV1(session.id, localId, part) } };
    const row = { id: 'result-row', seq: 2, localId, content: { t: 'plain', v: shell }, createdAt: 100 };
    let mode: 'available' | 'expired' | 'mismatched' | 'blocked' = 'available';
    const queries: URLSearchParams[] = [];
    homes.answer(serverId, `/v1/sessions/${session.id}/messages`, { select: (_input, request) => {
        queries.push(new URL(request.url).searchParams);
        const messages = mode === 'blocked' ? [] : mode === 'expired'
            ? [{ ...row, toolOutputAvailability: { status: 'expired', days: 7 } }]
            : [{ ...row, localId: mode === 'mismatched' ? 'other-local' : localId,
                toolOutputAvailability: { status: 'available' }, toolOutputPart: part }];
        return { body: { messages, hasMore: false, publicationBlocked: mode === 'blocked' } };
    } });
    const target = { scope: { serverId, accountId: 'viewer' }, sessionId: session.id, messageId: row.id,
        toolUseId, signal: new AbortController().signal };
    await expect(readSessionToolOutput(target)).resolves.toEqual({ status: 'available', result: {
        exitCode: 0, stdout: 'synthetic output', content: [{ type: 'text', text: 'synthetic text block' }],
    } });
    mode = 'mismatched';
    await expect(readSessionToolOutput(target)).resolves.toEqual({ status: 'corrupt' });
    mode = 'expired';
    await expect(readSessionToolOutput(target)).resolves.toEqual({ status: 'expired', days: 7 });
    mode = 'blocked';
    await expect(readSessionToolOutput(target)).resolves.toEqual({ status: 'unavailable' });
    expect(queries.map(query => Object.fromEntries(query))).toEqual(Array(4).fill({
        scope: 'all', messageId: row.id, includeToolOutput: 'true',
    }));
});
