import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createReducer } from '@happier-dev/session-core/reducer';
import type { Message, ToolCallMessage } from '@happier-dev/session-core/messages';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionCompletedBrowserActionKey } from './hooks';
import type { SessionMessages } from './domains/messages';

afterEach(standardCleanup);

describe('useSessionCompletedBrowserActionKey', () => {
    it('ignores streaming/result and sibling updates, but publishes newly completed browser actions', async () => {
        const previousState = storage.getState();
        const action: ToolCallMessage = {
            kind: 'tool-call', id: 'browser-call', localId: null, createdAt: 2, children: [],
            tool: { name: 'mcp__happier__action_execute', state: 'running',
                input: { actionId: 'browser.automation.click', input: {} },
                createdAt: 2, startedAt: 2, completedAt: null, description: null },
        };
        const text: Message = { kind: 'agent-text', id: 'streaming', localId: null, createdAt: 1, text: 'first' };
        const foreign: ToolCallMessage = { ...action, id: 'foreign-call',
            tool: { ...action.tool, name: 'mcp__foreign__action_execute', state: 'completed' } };
        const snapshot = (messages: readonly Message[], version: number): SessionMessages => {
            const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
            return { messageIdsOldestFirst: messages.map(message => message.id), messagesById, messagesMap: messagesById,
                messagesVersion: version, isLoaded: true, reducerState: createReducer(),
                latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null };
        };
        try {
            storage.setState({ sessionMessages: { 'browser-signal': snapshot([text, action, foreign], 1) } });
            let renders = 0;
            const hook = await renderHook(() => { renders++; return useSessionCompletedBrowserActionKey('browser-signal'); });
            expect(hook.getCurrent()).toBe('');
            const before = renders;
            for (let index = 0; index < 20; index++) {
                await act(async () => storage.setState({ sessionMessages: {
                    'browser-signal': snapshot([{ ...text, text: `stream ${index}` }, action, foreign], index + 2),
                    sibling: snapshot([{ ...text, text: `sibling ${index}` }], index),
                } }));
            }
            expect(renders - before).toBe(0);
            await act(async () => storage.setState({ sessionMessages: { 'browser-signal': snapshot([
                text, { ...action, tool: { ...action.tool, state: 'completed', completedAt: 3 } }, foreign,
            ], 22) } }));
            expect(hook.getCurrent()).toBe('browser-call');
            const completedRenders = renders;
            await act(async () => storage.setState({ sessionMessages: { 'browser-signal': snapshot([
                text, { ...action, tool: { ...action.tool, state: 'completed', result: { largeResult: 'changed' } } }, foreign,
            ], 23) } }));
            expect(hook.getCurrent()).toBe('browser-call');
            expect(renders).toBe(completedRenders);
            await hook.unmount();
        } finally {
            await act(async () => storage.setState(previousState));
        }
    });
});
