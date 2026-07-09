import { describe, expect, it } from 'vitest';

import type { AgentTextMessage, Message, ToolCallMessage, UserTextMessage } from '@/sync/domains/messages/messageTypes';
import type { ChatListItem } from '@/components/sessions/chatListItems';

import { buildTranscriptTurnsCached } from './buildTranscriptTurns';
import type { TranscriptTurnUnitListItem, TranscriptTurnUnitSourceItem } from './buildTranscriptTurnUnits';
import { buildTranscriptTurnUnits } from './buildTranscriptTurnUnits';

function userMessage(id: string, createdAt: number, seq?: number): UserTextMessage {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt,
        ...(seq != null ? { seq } : {}),
        text: `user:${id}`,
    };
}

function agentMessage(id: string, createdAt: number, seq?: number): AgentTextMessage {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt,
        ...(seq != null ? { seq } : {}),
        text: `agent:${id}`,
    };
}

function toolMessage(id: string, createdAt: number, seq?: number): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        ...(seq != null ? { seq } : {}),
        tool: {
            id: `call:${id}`,
            name: 'tool',
            state: 'completed',
            input: {},
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt + 1,
            description: null,
            result: {},
        },
        children: [],
    };
}

function indexMessages(messages: readonly Message[]): Record<string, Message> {
    return Object.fromEntries(messages.map((m) => [m.id, m]));
}

function lookupIn(messagesById: Readonly<Record<string, Message>>): (messageId: string) => Message | null {
    return (messageId) => messagesById[messageId] ?? null;
}

function turnItem(turn: Readonly<{
    id: string;
    userMessageId: string | null;
    content: ReadonlyArray<
        | { kind: 'message'; messageId: string }
        | { kind: 'tool_calls'; id: string; toolMessageIds: string[] }
    >;
}>): TranscriptTurnUnitSourceItem {
    return {
        kind: 'turn',
        id: turn.id,
        turn: {
            id: turn.id,
            userMessageId: turn.userMessageId,
            content: turn.content.map((content) => content.kind === 'tool_calls' ? { ...content } : content),
        },
    };
}

function expandedAlways(): boolean {
    return true;
}

function collapsedAlways(): boolean {
    return false;
}

describe('buildTranscriptTurnUnits', () => {
    it('passes non-turn, non-group items through unchanged by reference', () => {
        const forkDivider: ChatListItem = {
            kind: 'fork-divider',
            id: 'fork:p:c',
            parentSessionId: 'p',
            childSessionId: 'c',
            parentCutoffSeqInclusive: 7,
        };
        const pendingQueue: ChatListItem = {
            kind: 'pending-queue',
            id: 'pending-queue',
            pendingMessages: [],
            discardedMessages: [],
        };
        const messageItem: ChatListItem = {
            kind: 'message',
            id: 'msg:m1',
            messageId: 'm1',
            createdAt: 5,
            seq: 3,
        };

        const result = buildTranscriptTurnUnits({
            items: [forkDivider, messageItem, pendingQueue],
            getMessageById: () => null,
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 2,
        });

        expect(result).toHaveLength(3);
        expect(result[0]).toBe(forkDivider);
        expect(result[1]).toBe(messageItem);
        expect(result[2]).toBe(pendingQueue);
    });

    it('decomposes a mixed turn into user message, agent message, and group units in order', () => {
        const messagesById = indexMessages([
            userMessage('u1', 1, 10),
            agentMessage('a1', 2, 11),
            toolMessage('t1', 3, 12),
            toolMessage('t2', 4, 13),
        ]);

        const result = buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:u1',
                userMessageId: 'u1',
                content: [
                    { kind: 'message', messageId: 'a1' },
                    { kind: 'tool_calls', id: 'toolCalls:turn:u1:t1', toolMessageIds: ['t1', 't2'] },
                ],
            })],
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 2,
        });

        expect(result.map((item) => item.kind)).toEqual([
            'message',
            'message',
            'tool-group-header',
            'tool-group-tool',
            'tool-group-tool',
            'tool-group-footer',
        ]);
        expect(result.map((item) => item.id)).toEqual([
            'msg:u1',
            'msg:a1',
            'toolCalls:turn:u1:t1#header',
            'toolCalls:turn:u1:t1#tool:t1',
            'toolCalls:turn:u1:t1#tool:t2',
            'toolCalls:turn:u1:t1#footer',
        ]);
    });

    it('builds message items exactly like the splitter: msg ids, createdAt/seq normalization, 0/null fallbacks', () => {
        const messagesById = indexMessages([
            userMessage('u1', 9, 4.9),
            agentMessage('a1', 12),
        ]);

        const result = buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:u1',
                userMessageId: 'u1',
                content: [
                    { kind: 'message', messageId: 'a1' },
                    { kind: 'message', messageId: 'missing' },
                ],
            })],
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 0,
        });

        expect(result).toEqual([
            { kind: 'message', id: 'msg:u1', messageId: 'u1', createdAt: 9, seq: 4 },
            { kind: 'message', id: 'msg:a1', messageId: 'a1', createdAt: 12, seq: null },
            { kind: 'message', id: 'msg:missing', messageId: 'missing', createdAt: 0, seq: null },
        ]);
    });

    it('applies fork metadata to message items via metadataByMessageId', () => {
        const messagesById = indexMessages([userMessage('u1', 1, 1)]);

        const result = buildTranscriptTurnUnits({
            items: [turnItem({ id: 'turn:u1', userMessageId: 'u1', content: [] })],
            getMessageById: lookupIn(messagesById),
            metadataByMessageId: {
                u1: { originSessionId: 'parent-session', isReadOnlyContext: true },
            },
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 0,
        });

        expect(result).toEqual([
            {
                kind: 'message',
                id: 'msg:u1',
                messageId: 'u1',
                createdAt: 1,
                seq: 1,
                originSessionId: 'parent-session',
                isReadOnlyContext: true,
            },
        ]);
    });

    it('emits header, all tool units in order, and footer for an expanded group', () => {
        const messagesById = indexMessages([
            toolMessage('t1', 3, 30),
            toolMessage('t2', 4, 31.7),
            toolMessage('t3', 5),
        ]);
        const groupId = 'toolCalls:turn:x:t1';

        const result = buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:x',
                userMessageId: null,
                content: [{ kind: 'tool_calls', id: groupId, toolMessageIds: ['t1', 't2', 't3'] }],
            })],
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 1,
        });

        expect(result).toEqual([
            {
                kind: 'tool-group-header',
                id: `${groupId}#header`,
                groupId,
                toolMessageIds: ['t1', 't2', 't3'],
                expanded: true,
                hiddenCount: 0,
                createdAt: 3,
            },
            {
                kind: 'tool-group-tool',
                id: `${groupId}#tool:t1`,
                groupId,
                toolMessageId: 't1',
                toolMessageIds: ['t1', 't2', 't3'],
                expanded: true,
                createdAt: 3,
                seq: 30,
            },
            {
                kind: 'tool-group-tool',
                id: `${groupId}#tool:t2`,
                groupId,
                toolMessageId: 't2',
                toolMessageIds: ['t1', 't2', 't3'],
                expanded: true,
                createdAt: 4,
                seq: 31,
            },
            {
                kind: 'tool-group-tool',
                id: `${groupId}#tool:t3`,
                groupId,
                toolMessageId: 't3',
                toolMessageIds: ['t1', 't2', 't3'],
                expanded: true,
                createdAt: 5,
                seq: null,
            },
            {
                kind: 'tool-group-footer',
                id: `${groupId}#footer`,
                groupId,
                toolMessageIds: ['t1', 't2', 't3'],
                expanded: true,
                createdAt: 3,
            },
        ]);
    });

    it('emits header, expand unit, last-K preview tail, and footer for a collapsed group', () => {
        const messagesById = indexMessages([
            toolMessage('t1', 1, 1),
            toolMessage('t2', 2, 2),
            toolMessage('t3', 3, 3),
            toolMessage('t4', 4, 4),
        ]);
        const groupId = 'toolCalls:turn:x:t1';

        const result = buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:x',
                userMessageId: null,
                content: [{ kind: 'tool_calls', id: groupId, toolMessageIds: ['t1', 't2', 't3', 't4'] }],
            })],
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: collapsedAlways,
            collapsedPreviewCount: 2,
        });

        expect(result.map((item) => item.id)).toEqual([
            `${groupId}#header`,
            `${groupId}#expand`,
            `${groupId}#tool:t3`,
            `${groupId}#tool:t4`,
            `${groupId}#footer`,
        ]);
        expect(result[0]).toMatchObject({ kind: 'tool-group-header', expanded: false, hiddenCount: 2 });
        expect(result[1]).toMatchObject({
            kind: 'tool-group-expand',
            groupId,
            toolMessageIds: ['t1', 't2', 't3', 't4'],
            hiddenCount: 2,
            createdAt: 1,
        });
        expect(result[2]).toMatchObject({ kind: 'tool-group-tool', toolMessageId: 't3', expanded: false, createdAt: 3, seq: 3 });
        expect(result[3]).toMatchObject({ kind: 'tool-group-tool', toolMessageId: 't4', expanded: false, createdAt: 4, seq: 4 });
        expect(result[4]).toMatchObject({ kind: 'tool-group-footer', expanded: false });
    });

    it('emits no tail rows when collapsedPreviewCount <= 0 and truncates fractional counts', () => {
        const messagesById = indexMessages([
            toolMessage('t1', 1, 1),
            toolMessage('t2', 2, 2),
            toolMessage('t3', 3, 3),
        ]);
        const groupId = 'toolCalls:turn:x:t1';
        const items = [turnItem({
            id: 'turn:x',
            userMessageId: null,
            content: [{ kind: 'tool_calls', id: groupId, toolMessageIds: ['t1', 't2', 't3'] }],
        })];

        const noTail = buildTranscriptTurnUnits({
            items,
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: collapsedAlways,
            collapsedPreviewCount: 0,
        });
        expect(noTail.map((item) => item.kind)).toEqual(['tool-group-header', 'tool-group-expand', 'tool-group-footer']);
        expect(noTail[0]).toMatchObject({ hiddenCount: 3 });
        expect(noTail[1]).toMatchObject({ hiddenCount: 3 });

        const negative = buildTranscriptTurnUnits({
            items,
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: collapsedAlways,
            collapsedPreviewCount: -4,
        });
        expect(negative.map((item) => item.kind)).toEqual(['tool-group-header', 'tool-group-expand', 'tool-group-footer']);

        const fractional = buildTranscriptTurnUnits({
            items,
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: collapsedAlways,
            collapsedPreviewCount: 1.9,
        });
        expect(fractional.flatMap((item) => item.kind === 'tool-group-tool' ? [item.toolMessageId] : [])).toEqual(['t3']);
        expect(fractional[0]).toMatchObject({ hiddenCount: 2 });
    });

    it('emits all tools as tail with no expand unit when collapsedPreviewCount exceeds the group size', () => {
        const messagesById = indexMessages([
            toolMessage('t1', 1, 1),
            toolMessage('t2', 2, 2),
        ]);
        const groupId = 'toolCalls:turn:x:t1';

        const result = buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:x',
                userMessageId: null,
                content: [{ kind: 'tool_calls', id: groupId, toolMessageIds: ['t1', 't2'] }],
            })],
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: collapsedAlways,
            collapsedPreviewCount: 5,
        });

        expect(result.map((item) => item.id)).toEqual([
            `${groupId}#header`,
            `${groupId}#tool:t1`,
            `${groupId}#tool:t2`,
            `${groupId}#footer`,
        ]);
        expect(result[0]).toMatchObject({ kind: 'tool-group-header', expanded: false, hiddenCount: 0 });
        expect(result.some((item) => item.kind === 'tool-group-expand')).toBe(false);
    });

    it('emits nothing for a group with empty toolMessageIds', () => {
        const result = buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:x',
                userMessageId: null,
                content: [{ kind: 'tool_calls', id: 'toolCalls:turn:x:', toolMessageIds: [] }],
            })],
            getMessageById: () => null,
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 2,
        });

        expect(result).toEqual([]);
    });

    it('keeps two tool_calls contents in one turn as two separate header..footer spans (R5)', () => {
        const messagesById = indexMessages([
            toolMessage('t1', 1, 1),
            agentMessage('a1', 2, 2),
            toolMessage('t2', 3, 3),
        ]);

        const result = buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:x',
                userMessageId: null,
                content: [
                    { kind: 'tool_calls', id: 'toolCalls:turn:x:t1', toolMessageIds: ['t1'] },
                    { kind: 'message', messageId: 'a1' },
                    { kind: 'tool_calls', id: 'toolCalls:turn:x:t2', toolMessageIds: ['t2'] },
                ],
            })],
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 2,
        });

        expect(result.map((item) => item.id)).toEqual([
            'toolCalls:turn:x:t1#header',
            'toolCalls:turn:x:t1#tool:t1',
            'toolCalls:turn:x:t1#footer',
            'msg:a1',
            'toolCalls:turn:x:t2#header',
            'toolCalls:turn:x:t2#tool:t2',
            'toolCalls:turn:x:t2#footer',
        ]);
    });

    it('decomposes a linear tool-calls-group item and carries its fork metadata onto all units', () => {
        const messagesById = indexMessages([
            toolMessage('t1', 1, 1),
            toolMessage('t2', 2, 2),
        ]);
        const groupItem: ChatListItem = {
            kind: 'tool-calls-group',
            id: 'toolCalls:linear:t1',
            toolMessageIds: ['t1', 't2'],
            createdAt: 1,
            originSessionId: 'origin-session',
            isReadOnlyContext: true,
        };

        const result = buildTranscriptTurnUnits({
            items: [groupItem],
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 2,
        });

        expect(result.map((item) => item.kind)).toEqual([
            'tool-group-header',
            'tool-group-tool',
            'tool-group-tool',
            'tool-group-footer',
        ]);
        for (const unit of result) {
            expect(unit).toMatchObject({
                groupId: 'toolCalls:linear:t1',
                originSessionId: 'origin-session',
                isReadOnlyContext: true,
            });
        }
    });

    it('prefers per-message metadata for linear-group tool units, falling back to the group item metadata', () => {
        const messagesById = indexMessages([
            toolMessage('t1', 1, 1),
            toolMessage('t2', 2, 2),
        ]);
        const groupItem: ChatListItem = {
            kind: 'tool-calls-group',
            id: 'toolCalls:linear:t1',
            toolMessageIds: ['t1', 't2'],
            createdAt: 1,
            originSessionId: 'group-origin',
            isReadOnlyContext: false,
        };

        const result = buildTranscriptTurnUnits({
            items: [groupItem],
            getMessageById: lookupIn(messagesById),
            metadataByMessageId: {
                t1: { originSessionId: 'per-message-origin', isReadOnlyContext: true },
            },
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 2,
        });

        const toolUnits = result.filter((item) => item.kind === 'tool-group-tool');
        expect(toolUnits[0]).toMatchObject({
            toolMessageId: 't1',
            originSessionId: 'per-message-origin',
            isReadOnlyContext: true,
        });
        expect(toolUnits[1]).toMatchObject({
            toolMessageId: 't2',
            originSessionId: 'group-origin',
            isReadOnlyContext: false,
        });
        expect(result[0]).toMatchObject({ kind: 'tool-group-header', originSessionId: 'group-origin', isReadOnlyContext: false });
    });

    it('derives turn-group header/expand/footer metadata from the FIRST tool message and tool units from their own message', () => {
        const messagesById = indexMessages([
            toolMessage('t1', 1, 1),
            toolMessage('t2', 2, 2),
            toolMessage('t3', 3, 3),
        ]);
        const groupId = 'toolCalls:turn:x:t1';

        const result = buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:x',
                userMessageId: null,
                content: [{ kind: 'tool_calls', id: groupId, toolMessageIds: ['t1', 't2', 't3'] }],
            })],
            getMessageById: lookupIn(messagesById),
            metadataByMessageId: {
                t1: { originSessionId: 'first-tool-origin', isReadOnlyContext: true },
                t3: { originSessionId: 'third-tool-origin', isReadOnlyContext: false },
            },
            isGroupExpanded: collapsedAlways,
            collapsedPreviewCount: 1,
        });

        expect(result.map((item) => item.kind)).toEqual([
            'tool-group-header',
            'tool-group-expand',
            'tool-group-tool',
            'tool-group-footer',
        ]);
        expect(result[0]).toMatchObject({ originSessionId: 'first-tool-origin', isReadOnlyContext: true });
        expect(result[1]).toMatchObject({ originSessionId: 'first-tool-origin', isReadOnlyContext: true });
        // Tail tool t3 uses its OWN metadata.
        expect(result[2]).toMatchObject({ toolMessageId: 't3', originSessionId: 'third-tool-origin', isReadOnlyContext: false });
        expect(result[3]).toMatchObject({ originSessionId: 'first-tool-origin', isReadOnlyContext: true });
    });

    it('keeps all previously-emitted unit ids unchanged when a tool is appended to an expanded group (streaming growth)', () => {
        const grow = (toolIds: string[]): TranscriptTurnUnitListItem[] => buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:x',
                userMessageId: null,
                content: [{ kind: 'tool_calls', id: 'toolCalls:turn:x:t1', toolMessageIds: toolIds }],
            })],
            getMessageById: lookupIn(indexMessages(toolIds.map((id, index) => toolMessage(id, index + 1, index + 1)))),
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 2,
        });

        const before = grow(['t1', 't2']);
        const after = grow(['t1', 't2', 't3']);

        const beforeIds = before.map((item) => item.id);
        const afterIds = after.map((item) => item.id);
        // Every previously-emitted id survives.
        for (const id of beforeIds) {
            expect(afterIds).toContain(id);
        }
        // The single new row is the new tool, inserted before the footer.
        expect(afterIds).toEqual([
            'toolCalls:turn:x:t1#header',
            'toolCalls:turn:x:t1#tool:t1',
            'toolCalls:turn:x:t1#tool:t2',
            'toolCalls:turn:x:t1#tool:t3',
            'toolCalls:turn:x:t1#footer',
        ]);
    });

    it('slides the preview tail on collapsed append: surviving tail ids and the expand id stay identical, only hiddenCount changes', () => {
        const grow = (toolIds: string[]): TranscriptTurnUnitListItem[] => buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:x',
                userMessageId: null,
                content: [{ kind: 'tool_calls', id: 'toolCalls:turn:x:t1', toolMessageIds: toolIds }],
            })],
            getMessageById: lookupIn(indexMessages(toolIds.map((id, index) => toolMessage(id, index + 1, index + 1)))),
            isGroupExpanded: collapsedAlways,
            collapsedPreviewCount: 2,
        });

        const before = grow(['t1', 't2', 't3', 't4']);
        const after = grow(['t1', 't2', 't3', 't4', 't5']);

        expect(before.map((item) => item.id)).toEqual([
            'toolCalls:turn:x:t1#header',
            'toolCalls:turn:x:t1#expand',
            'toolCalls:turn:x:t1#tool:t3',
            'toolCalls:turn:x:t1#tool:t4',
            'toolCalls:turn:x:t1#footer',
        ]);
        expect(after.map((item) => item.id)).toEqual([
            'toolCalls:turn:x:t1#header',
            'toolCalls:turn:x:t1#expand',
            'toolCalls:turn:x:t1#tool:t4',
            'toolCalls:turn:x:t1#tool:t5',
            'toolCalls:turn:x:t1#footer',
        ]);
        // The surviving tail row keeps the exact same id in both builds.
        expect(before.map((item) => item.id)).toContain('toolCalls:turn:x:t1#tool:t4');
        expect(after.map((item) => item.id)).toContain('toolCalls:turn:x:t1#tool:t4');
        const expandBefore = before.find((item) => item.kind === 'tool-group-expand');
        const expandAfter = after.find((item) => item.kind === 'tool-group-expand');
        expect(expandBefore?.id).toBe(expandAfter?.id);
        expect(expandBefore).toMatchObject({ hiddenCount: 2 });
        expect(expandAfter).toMatchObject({ hiddenCount: 3 });
    });

    it('keeps the id of a tool row that exists in both collapsed and expanded states across a toggle', () => {
        const build = (expanded: boolean): TranscriptTurnUnitListItem[] => buildTranscriptTurnUnits({
            items: [turnItem({
                id: 'turn:x',
                userMessageId: null,
                content: [{ kind: 'tool_calls', id: 'toolCalls:turn:x:t1', toolMessageIds: ['t1', 't2', 't3'] }],
            })],
            getMessageById: lookupIn(indexMessages([
                toolMessage('t1', 1, 1),
                toolMessage('t2', 2, 2),
                toolMessage('t3', 3, 3),
            ])),
            isGroupExpanded: () => expanded,
            collapsedPreviewCount: 1,
        });

        const collapsed = build(false);
        const expanded = build(true);

        const collapsedToolIds = collapsed.flatMap((item) => item.kind === 'tool-group-tool' ? [item.id] : []);
        const expandedToolIds = expanded.flatMap((item) => item.kind === 'tool-group-tool' ? [item.id] : []);
        expect(collapsedToolIds).toEqual(['toolCalls:turn:x:t1#tool:t3']);
        // The collapsed preview-tail row has the SAME id as its expanded body row.
        expect(expandedToolIds).toContain(collapsedToolIds[0]!);
    });

    it('keeps pre-existing tool unit ids identical across a prepend that extends a group upward (sticky group ids)', () => {
        const chronological: Message[] = [
            userMessage('u1', 1),
            agentMessage('a1', 2),
            toolMessage('t1', 3),
            toolMessage('t2', 4),
            toolMessage('t3', 5),
            userMessage('u3', 6),
        ];
        const messagesById = indexMessages(chronological);

        const windowCache = buildTranscriptTurnsCached({
            cache: null,
            messageIdsOldestFirst: ['t2', 't3', 'u3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });
        const prependedCache = buildTranscriptTurnsCached({
            cache: windowCache,
            messageIdsOldestFirst: ['u1', 'a1', 't1', 't2', 't3', 'u3'],
            messagesById,
            groupToolCalls: true,
            toolCallsGroupStrategy: 'consecutive_tools',
        });

        const toSourceItems = (turns: typeof windowCache.turns): TranscriptTurnUnitSourceItem[] =>
            turns.map((turn) => ({ kind: 'turn', id: turn.id, turn }));

        const buildUnits = (turns: typeof windowCache.turns): TranscriptTurnUnitListItem[] => buildTranscriptTurnUnits({
            items: toSourceItems(turns),
            getMessageById: lookupIn(messagesById),
            isGroupExpanded: expandedAlways,
            collapsedPreviewCount: 2,
        });

        const beforeUnits = buildUnits(windowCache.turns);
        const afterUnits = buildUnits(prependedCache.turns);

        const beforeIds = beforeUnits.map((item) => item.id);
        const afterIds = afterUnits.map((item) => item.id);

        // Every pre-existing unit id survives the prepend merge unchanged.
        for (const id of beforeIds) {
            expect(afterIds).toContain(id);
        }
        // The merged group kept the sticky id, so t2/t3 rows kept their exact keys...
        expect(afterIds).toContain('toolCalls:turn:t2:t2#tool:t2');
        expect(afterIds).toContain('toolCalls:turn:t2:t2#tool:t3');
        // ...and the prepended tool appears as a NEW row above t2 under the same group id.
        const t1Index = afterIds.indexOf('toolCalls:turn:t2:t2#tool:t1');
        const t2Index = afterIds.indexOf('toolCalls:turn:t2:t2#tool:t2');
        expect(t1Index).toBeGreaterThanOrEqual(0);
        expect(beforeIds).not.toContain('toolCalls:turn:t2:t2#tool:t1');
        expect(t1Index).toBeLessThan(t2Index);
    });
});
