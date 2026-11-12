import { expect, it } from 'vitest';
import { applyReducedMessages, createRawMessageNormalizationSequenceState, createReducer,
  normalizeRawMessageInSequence, reducer, type OrderedTranscript } from './index.js';
import { multiAgentPage } from './raw/__fixtures__/multiAgentPage.js';
import { normalizeRawMessages } from './raw/normalize.js';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';

it.each([1, 2] as const)('keeps persisted Usage V%s evidence readable without conversational rows', (v) => {
  const usage = { v, evidenceId: 'usage-window', sessionId: 'session', turnId: 'turn', observedAtMs: 1003,
    window: { startMs: 1000, endMs: 1003 }, coverage: 'complete' as const, bindings: [] };
  const composition = { v: 1 as const, evidenceId: 'composition', sessionId: 'session', turnId: null, inputId: 'input',
    observedAtMs: 1003, boundary: 'host_pre_dispatch' as const, deliveryKind: 'newTurn' as const,
    coverage: 'host_only' as const, components: [], nativePrefix: null, contextWindowTokens: null };
  // Serialize the actual stored envelopes, then enter through the history normalizer.
  const rawTail = [
    { type: 'acp', agentId: 'codex', data: { type: 'tool-call', callId: 'read', name: 'Read', input: { file_path: '/file' } } },
    { type: 'acp', agentId: 'codex', data: { type: 'tool-result', callId: 'read', output: 'file contents' } },
    { type: 'event', id: 'usage-window', data: { type: 'mcp-binding-usage', usage } },
    { type: 'event', id: 'composition', data: { type: 'prompt-composition', composition } },
    { type: 'acp', agentId: 'codex', data: { type: 'message', message: 'Read complete' } },
  ].map((content, index) => ({ id: `stored-${index}`, localId: null, createdAt: 1000 + index,
    seq: index + 1, raw: JSON.parse(JSON.stringify({ role: 'agent', content })) as unknown }));
  const state = createReducer();
  const normalized = normalizeRawMessages(rawTail);
  expect(normalized).toHaveLength(rawTail.length);
  const rows = reducer(state, normalized).messages;
  expect(rows.map(row => row.kind)).toEqual(['tool-call', 'agent-text']);
  expect(rows[0]).toMatchObject({ tool: { result: 'file contents' } });
  expect(rows[1]).toMatchObject({ text: 'Read complete' });
  expect(reducer(state, normalizeRawMessages(rawTail)).messages).toEqual([]);
  const evidence = projectSessionUsageWorkEvidence({ id: 'session', metadata: null, agentState: null },
    rawTail.map(row => ({ id: row.id, createdAt: row.createdAt, content: row.raw })));
  expect(evidence.coach?.detail?.mcpUsage).toEqual([usage]);
  expect(evidence.coach?.composition).toEqual([composition]);
});

it('normalizes a persisted multi-agent page and ignores redelivery of canonical normalization inputs', () => {
  const sequence = createRawMessageNormalizationSequenceState();
  const state = createReducer();
  let transcript: OrderedTranscript = { messageIdsOldestFirst: [], messagesById: {} };
  const fold = (rows: typeof multiAgentPage) => {
    const normalized = rows.flatMap((row) => {
      const message = normalizeRawMessageInSequence(row, sequence);
      return message ? [message] : [];
    });
    transcript = applyReducedMessages(transcript, reducer(state, normalized, null).messages);
  };
  fold(multiAgentPage);
  const before = transcript;
  const messages = transcript.messageIdsOldestFirst.map((id) => transcript.messagesById[id]);
  expect(messages.map((message) => 'text' in message ? message.text : null))
    .toEqual(['Question', 'Claude answer', 'ACP answer']);

  // This is the core's idempotent input contract, not an adapter test. The SDK's
  // real HTTP/Socket.IO controller tests verify stored row identity at transport ingress.
  fold(multiAgentPage.map((row) => ({ ...row, id: row.id, seq: row.seq })));
  expect(transcript).toBe(before);
  expect(transcript.messageIdsOldestFirst.map((id) => transcript.messagesById[id])).toEqual(messages);
});
