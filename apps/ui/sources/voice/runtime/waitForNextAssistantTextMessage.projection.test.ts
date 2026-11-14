import { afterEach, describe, expect, it } from 'vitest';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { createReducer, reducer } from '@happier-dev/session-core/reducer';

import { createSessionMessagesFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { collectAssistantTextMessagesSinceBaseline } from './waitForNextAssistantTextMessage';

// Producer-shaped retained records, using the grammars covered by session-core's
// normalize.sidechainId/messageRole/contextCompaction tests. Keep normalization
// and reduction real: testing hand-built agent-text rows hides classification loss.
const output = (data: unknown) => ({ role: 'agent', content: { type: 'output', data } });
const codex = (data: unknown) => ({ role: 'agent', content: { type: 'codex', data } });
const acp = (agentId: string, data: unknown) => ({ role: 'agent', content: { type: 'acp', agentId, data } });
const internalRecords = [
    ['Codex reasoning', codex({ type: 'reasoning', message: 'Private reasoning' })],
    ['Claude thinking', output({ type: 'assistant', uuid: 'thinking', message: {
        role: 'assistant', content: [{ type: 'thinking', thinking: 'Private reasoning' }],
    } })],
    ['Claude compaction', output({ type: 'user', uuid: 'compact', isCompactSummary: true,
        message: { role: 'user', content: 'Internal summary' } })],
    ['Claude system notice', output({ type: 'system', subtype: 'stop_hook_summary', message: 'Internal notice' })],
    ['Claude tool progress', output({ type: 'progress', data: { text: 'Internal progress' } })],
    ['OpenCode reasoning', acp('opencode', { type: 'thinking', text: 'Private reasoning' })],
    ['Muse retained reasoning', acp('muse', { type: 'reasoning', message: 'Private reasoning' })],
    ['OpenCode tool progress', acp('opencode', { type: 'tool-call', callId: 'tool', name: 'read', input: {} })],
    ['Pi reasoning', acp('pi', { type: 'thinking', text: 'Private reasoning' })],
    ['Pi compaction notice', acp('pi', { type: 'context-compaction', phase: 'completed',
        lifecycleId: 'pi:context-compaction', source: 'agent-event' })],
] as const;

describe('retained provider records projected to Voice', () => {
    const previousState = storage.getState();
    afterEach(() => storage.setState(previousState, true));

    it.each(internalRecords)('does not speak %s while preserving a real answer', (_label, raw) => {
        const normalized = [raw, codex({ type: 'message', message: 'The answer.' })]
            .flatMap((record, index) => {
                const message = normalizeRawMessage(`raw-${index}`, null, index + 1, record);
                return message ? [message] : [];
            });
        const { messages } = reducer(createReducer(), normalized);
        storage.setState({ sessionMessages: { projection: createSessionMessagesFixture({
            messageIdsOldestFirst: messages.map(message => message.id),
            messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
        }) } });
        expect(collectAssistantTextMessagesSinceBaseline('projection', new Set(), 0)).toEqual(['The answer.']);
        if (_label === 'Codex reasoning' || _label === 'Muse retained reasoning') {
            expect(messages).toContainEqual(expect.objectContaining({ kind: 'agent-text', isThinking: true, text: 'Private reasoning' }));
        }
    });
});
