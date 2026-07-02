import { describe, expect, it } from 'vitest';

import {
    buildTranscriptRowShellSignature,
    resolveTranscriptRowItemType,
    type TranscriptRowShellItem,
} from './transcriptRowShellSignature';

const messagesById = {
    user: { kind: 'user-text', id: 'user', localId: null, createdAt: 1, text: 'short prompt' },
    agentLong: { kind: 'agent-text', id: 'agentLong', localId: null, createdAt: 2, text: 'x'.repeat(700), isThinking: false },
    thinking: { kind: 'agent-text', id: 'thinking', localId: null, createdAt: 3, text: 'thinking', isThinking: true },
    runningTool: {
        kind: 'tool-call',
        id: 'runningTool',
        localId: null,
        createdAt: 4,
        tool: { name: 'Bash', state: 'running' },
        children: [],
    },
} as const;

function getMessageById(messageId: string) {
    return (messagesById as Record<string, any>)[messageId] ?? null;
}

function buildSignature(item: TranscriptRowShellItem) {
    return buildTranscriptRowShellSignature({
        activeThinkingMessageId: null,
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        forkMessageMetadataById: {
            agentLong: { originSessionId: 'origin-session', isReadOnlyContext: true },
        },
        getMessageById,
        groupingMode: 'turns',
        item,
        latestCommittedActivityKey: null,
        resolveThinkingExpanded: () => false,
        sessionActive: false,
        widthBucket: 'width:512',
        fontScaleKey: 'font:100',
    });
}

function toolMessage(id: string, input: unknown = { value: id }) {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        tool: {
            id: `call:${id}`,
            name: 'shell',
            state: 'completed',
            input,
        },
        children: [],
    } as any;
}

function buildSignatureWithMessages(params: Readonly<{
    item: TranscriptRowShellItem;
    messagesById: Readonly<Record<string, any>>;
    expandedToolCallsAnchorMessageIds?: ReadonlySet<string>;
}>) {
    return buildTranscriptRowShellSignature({
        activeThinkingMessageId: null,
        expandedToolCallsAnchorMessageIds: params.expandedToolCallsAnchorMessageIds ?? new Set(),
        forkMessageMetadataById: null,
        getMessageById: (messageId) => params.messagesById[messageId] ?? null,
        groupingMode: 'turns',
        item: params.item,
        latestCommittedActivityKey: null,
        resolveThinkingExpanded: () => false,
        sessionActive: false,
        widthBucket: 'width:512',
        fontScaleKey: 'font:100',
    });
}

describe('transcriptRowShellSignature', () => {
    it('partitions row item types into a bounded set of transcript shapes', () => {
        const items: TranscriptRowShellItem[] = [
            { kind: 'message', id: 'user', messageId: 'user', createdAt: 1, seq: null } as any,
            { kind: 'message', id: 'agentLong', messageId: 'agentLong', createdAt: 2, seq: null } as any,
            { kind: 'message', id: 'thinking', messageId: 'thinking', createdAt: 3, seq: null } as any,
            { kind: 'tool-calls-group', id: 'tools', toolMessageIds: ['runningTool'], createdAt: 4, seq: null } as any,
            { kind: 'pending-queue', id: 'pending', pendingMessages: [], discardedMessages: [] } as any,
            { kind: 'action-draft', id: 'draft', draft: {} } as any,
            { kind: 'fork-divider', id: 'fork', parentSessionId: 'p', childSessionId: 'c', parentCutoffSeqInclusive: 10 } as any,
        ];

        const types = items.map((item) => resolveTranscriptRowItemType({
            activeThinkingMessageId: null,
            getMessageById,
            item,
        }));

        expect(types).toEqual([
            'message:user-short',
            'message:agent-long',
            'message:thinking',
            'tool-group',
            'pending-action',
            'pending-action',
            'fork-divider',
        ]);
        expect(new Set(types).size).toBeLessThanOrEqual(12);
    });

    it('includes dev fork context and expansion-sensitive fields in the validity signature', () => {
        const forkDivider = buildSignature({
            kind: 'fork-divider',
            id: 'fork',
            parentSessionId: 'parent',
            childSessionId: 'child',
            parentCutoffSeqInclusive: 12,
        } as any);
        const forkedMessage = buildSignature({
            kind: 'message',
            id: 'agentLong',
            messageId: 'agentLong',
            createdAt: 2,
            originSessionId: 'origin-session',
            isReadOnlyContext: true,
            seq: null,
        } as any);

        expect(forkDivider.forkContextKey).toBe('fork-divider:parent:child:12');
        expect(forkedMessage.forkContextKey).toBe('fork:origin-session:readonly');
        expect(forkedMessage.widthBucket).toBe('width:512');
        expect(forkedMessage.fontScaleKey).toBe('font:100');
        expect(forkedMessage.groupingMode).toBe('turns');
    });

    it('keeps collapsed large tool groups stable when hidden completed tool details change', () => {
        const toolMessageIds = Array.from({ length: 20 }, (_, index) => `tool-${index + 1}`);
        const item: TranscriptRowShellItem = {
            kind: 'tool-calls-group',
            id: 'tools:large',
            toolMessageIds,
            createdAt: 1,
        } as any;
        const messages = Object.fromEntries(toolMessageIds.map((id) => [id, toolMessage(id)]));
        const changedHiddenMessages = {
            ...messages,
            'tool-1': toolMessage('tool-1', { value: 'hidden changed' }),
        };

        const before = buildSignatureWithMessages({ item, messagesById: messages });
        const after = buildSignatureWithMessages({ item, messagesById: changedHiddenMessages });

        expect(after.structuralKey).toBe(before.structuralKey);
        expect(after.expansionKey).toBe(before.expansionKey);
    });

    it('keeps collapsed large tool groups stable inside turn rows when hidden completed tool details change', () => {
        const toolMessageIds = Array.from({ length: 20 }, (_, index) => `tool-${index + 1}`);
        const item: TranscriptRowShellItem = {
            kind: 'turn',
            id: 'turn:tools',
            turn: {
                id: 'turn:tools',
                userMessageId: null,
                content: [{
                    kind: 'tool_calls',
                    id: 'tools:large',
                    toolMessageIds,
                }],
            },
        } as any;
        const messages = Object.fromEntries(toolMessageIds.map((id) => [id, toolMessage(id)]));
        const changedHiddenMessages = {
            ...messages,
            'tool-1': toolMessage('tool-1', { value: 'hidden changed' }),
        };

        const before = buildSignatureWithMessages({ item, messagesById: messages });
        const after = buildSignatureWithMessages({ item, messagesById: changedHiddenMessages });

        expect(after.structuralKey).toBe(before.structuralKey);
        expect(after.expansionKey).toBe(before.expansionKey);
    });
});
