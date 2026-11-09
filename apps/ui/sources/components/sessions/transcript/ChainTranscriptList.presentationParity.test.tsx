import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { makeToolCall, renderScreen } from '@/dev/testkit';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource, wrapWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import type { Message } from "@happier-dev/session-core/messages";
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settings = {
    transcriptGroupingMode: 'linear',
    transcriptGroupToolCalls: true,
    transcriptTurnToolCallsGroupStrategy: 'consecutive_tools',
    toolViewTimelineChromeMode: 'activity_feed',
    sessionThinkingDisplayMode: 'inline',
    sessionThinkingInlinePresentation: 'summary',
    transcriptThinkingPulseStaleMs: 30_000,
} as Record<string, unknown>;

const turnViewSpy = vi.fn();
const turnViewWithCommonSpy = vi.fn();
const toolCallsGroupRowSpy = vi.fn();
const toolCallsGroupRowWithCommonSpy = vi.fn();
const toolGroupUnitHeaderSpy = vi.fn();
const toolGroupUnitToolSpy = vi.fn();
const messageViewSpy = vi.fn();
const messageViewWithCommonSpy = vi.fn();
const messageSourceSpy = vi.fn();

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptEstimatedItemSizePx: 120,
            transcriptMaxTurnEntriesPerListItem: 8,
        }),
    },
}));

installTranscriptCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        return createStorageModuleStub({
            useSetting: (key: string) => settings[key] ?? Reflect.get(settingsDefaults, key),
            useSessionForkSupportSource: () => null,
            useSessionMessagesById: () => ({}),
            useSessionMessagesReducerState: () => null,
            useSessionWorkspacePath: () => null,
        });
    },
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const original = await importOriginal<typeof import('@legendapp/list/react-native')>();
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original }).module;
});

vi.mock('@/components/sessions/transcript/MessageView', async () => {
    const { useSessionTranscriptSource } = await import('./source/SessionTranscriptSourceContext');
    return {
    MessageView: (props: any) => {
        messageViewSpy(props);
        return React.createElement('MessageView', props);
    },
    MessageViewWithSessionCommon: (props: any) => {
        const source = useSessionTranscriptSource();
        messageSourceSpy({ messages: source.useMessagesById(), actions: source.actions, navigate: source.navigate, loadSidechain: source.loadSidechain, loadOlder: source.history.loadOlder });
        messageViewWithCommonSpy(props);
        return React.createElement('MessageViewWithSessionCommon', props);
    },
    };
});

vi.mock('@/components/sessions/transcript/turns/TurnView', () => ({
    TurnView: (props: any) => {
        turnViewSpy(props);
        return React.createElement('TurnView', props);
    },
    TurnViewWithSessionCommon: (props: any) => {
        turnViewWithCommonSpy(props);
        return React.createElement('TurnViewWithSessionCommon', props);
    },
}));

vi.mock('@/components/sessions/transcript/toolCalls/ToolCallsGroupRow', () => ({
    ToolCallsGroupRow: (props: any) => {
        toolCallsGroupRowSpy(props);
        return React.createElement('ToolCallsGroupRow', props);
    },
    ToolCallsGroupRowWithSessionCommon: (props: any) => {
        toolCallsGroupRowWithCommonSpy(props);
        return React.createElement('ToolCallsGroupRowWithSessionCommon', props);
    },
}));

// N2c: turn-mode tool groups render as per-unit rows.
vi.mock('@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitHeaderRow', () => ({
    ToolCallsGroupUnitHeaderRow: (props: any) => {
        toolGroupUnitHeaderSpy(props);
        return React.createElement('ToolCallsGroupUnitHeaderRow', props);
    },
    ToolCallsGroupUnitHeaderRowWithSessionCommon: (props: any) => {
        toolGroupUnitHeaderSpy(props);
        return React.createElement('ToolCallsGroupUnitHeaderRowWithSessionCommon', props);
    },
}));

vi.mock('@/components/sessions/transcript/toolCalls/units/ToolCallsGroupUnitToolRow', () => ({
    ToolCallsGroupUnitToolRow: (props: any) => {
        toolGroupUnitToolSpy(props);
        return React.createElement('ToolCallsGroupUnitToolRow', props);
    },
    ToolCallsGroupUnitToolRowWithSessionCommon: (props: any) => {
        toolGroupUnitToolSpy(props);
        return React.createElement('ToolCallsGroupUnitToolRowWithSessionCommon', props);
    },
}));


function createChainTestRoot(Content: typeof import('./ChainTranscriptList')['ChainTranscriptList']) {
    return function ChainTestRoot(props: React.ComponentProps<typeof Content>) {
        const [source] = React.useState(() => createTestSessionTranscriptSource({
            sessionId: props.sessionId, serverId: props.serverId, messages: props.messages,
            metadata: props.metadata, interaction: props.interaction,
            loadSidechain: async () => 'not_ready',
            history: { loadOlder: props.loadOlder ?? (async () => ({ loaded: 0, hasMore: false, status: 'not_ready' })) },
        }));
        return wrapWithSessionTranscriptSource(React.createElement(Content, props), source);
    };
}

// Collect the real Chain graph before any timed test or renderer/act lifetime.
const { ChainTranscriptList } = await import('./ChainTranscriptList');
const ChainTestRoot = createChainTestRoot(ChainTranscriptList);

describe('ChainTranscriptList presentation parity', () => {
    beforeEach(() => {
        resetTranscriptCommonModuleMockState();
        settings.transcriptGroupingMode = 'linear';
        settings.transcriptGroupToolCalls = true;
        settings.transcriptTurnToolCallsGroupStrategy = 'consecutive_tools';
        settings.toolViewTimelineChromeMode = 'activity_feed';
        settings.sessionThinkingDisplayMode = 'inline';
        settings.sessionThinkingInlinePresentation = 'summary';
        settings.transcriptThinkingPulseStaleMs = 30_000;
        delete settings.transcriptMessageTimestampDisplayMode;
        turnViewSpy.mockReset();
        turnViewWithCommonSpy.mockReset();
        toolCallsGroupRowSpy.mockReset();
        toolCallsGroupRowWithCommonSpy.mockReset();
        toolGroupUnitHeaderSpy.mockReset();
        toolGroupUnitToolSpy.mockReset();
        messageViewSpy.mockReset();
        messageViewWithCommonSpy.mockReset();
        messageSourceSpy.mockReset();
    });

    it('keeps sidechain snapshots isolated and never elevates a read-only parent capability', async () => {
        settings.transcriptGroupToolCalls = false;
        const message: Message = { kind: 'agent-text', id: 'snapshot-child', localId: null, createdAt: 1, text: 'Shared child', isThinking: false };
        const source = createTestSessionTranscriptSource({ sessionId: 's1', messages: [] });
        const loadOlder = vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'not_ready' as const }));
        await renderWithSessionTranscriptSource(React.createElement(ChainTranscriptList, {
            sessionId: 's1', datasetKey: 'shared-child', messages: [message], metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true }, loadOlder,
        }), source);
        expect(messageSourceSpy).toHaveBeenCalledWith({ messages: { 'snapshot-child': message }, actions: null, navigate: null, loadSidechain: null, loadOlder: null });
        expect(loadOlder).not.toHaveBeenCalled();
    });

    it('renders linear messages through parent-provided transcript session common', async () => {
        settings.transcriptGroupToolCalls = false;
        settings.toolViewTimelineChromeMode = 'cards';
        settings.transcriptMessageTimestampDisplayMode = 'always';

        const agentMessage: Message = {
            kind: 'agent-text',
            id: 'agent-1',
            localId: null,
            createdAt: 1,
            text: 'Done',
            isThinking: false,
        };

        await renderScreen(React.createElement(ChainTestRoot, {
            sessionId: 's1',
            datasetKey: JSON.stringify(['s1', 'test-sidechain']),
            messages: [agentMessage],
            metadata: null,
            interaction: { canSendMessages: true, canApprovePermissions: true },
        }));

        expect(messageViewSpy).not.toHaveBeenCalled();
        expect(messageViewWithCommonSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                message: expect.objectContaining({ id: 'agent-1' }),
                messageDisplayCommon: expect.objectContaining({
                    transcriptMessageTimestampDisplayMode: 'always',
                }),
                toolChromeCommon: expect.objectContaining({
                    toolViewTimelineChromeMode: 'cards',
                }),
            }),
        );
    });

    it('groups consecutive tool calls the same way as the main transcript when grouping is enabled', async () => {
        const toolMessageOne: Message = {
            kind: 'tool-call',
            id: 'tool-msg-1',
            localId: null,
            createdAt: 1,
            tool: makeToolCall({ id: 'tool-1', name: 'Read', input: { file: 'a.ts' }, createdAt: 1 }),
            children: [],
        };
        const toolMessageTwo: Message = {
            kind: 'tool-call',
            id: 'tool-msg-2',
            localId: null,
            createdAt: 2,
            tool: makeToolCall({ id: 'tool-2', name: 'Read', input: { file: 'b.ts' }, createdAt: 2 }),
            children: [],
        };

        await renderScreen(React.createElement(ChainTestRoot, {
                    sessionId: 's1',
                    datasetKey: JSON.stringify(['s1', 'test-sidechain']),
                    messages: [toolMessageOne, toolMessageTwo],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }));

        expect(toolCallsGroupRowSpy).not.toHaveBeenCalled();
        expect(toolCallsGroupRowWithCommonSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                toolMessageIds: ['tool-msg-1', 'tool-msg-2'],
                toolChromeCommon: expect.objectContaining({
                    toolViewTimelineChromeMode: 'activity_feed',
                }),
            }),
        );
        expect(messageViewSpy).not.toHaveBeenCalled();
    });

    it('keeps a long turn-level tool run as one semantic group in turn layout', async () => {
        settings.transcriptGroupingMode = 'turns';
        settings.transcriptTurnToolCallsGroupStrategy = 'all_tools_in_turn';

        const userMessage: Message = {
            kind: 'user-text',
            id: 'user-1',
            localId: null,
            createdAt: 1,
            text: 'Run the audit',
        };
        const toolMessages: Message[] = Array.from({ length: 200 }, (_, index) => ({
            kind: 'tool-call',
            id: `tool-msg-${index + 1}`,
            localId: null,
            createdAt: index + 2,
            tool: makeToolCall({
                id: `tool-${index + 1}`,
                name: 'Read',
                input: { file: `file-${index + 1}.ts` },
                createdAt: index + 2,
            }),
            children: [],
        }));

        await renderScreen(React.createElement(ChainTestRoot, {
                    sessionId: 's1',
                    datasetKey: JSON.stringify(['s1', 'test-sidechain']),
                    messages: [userMessage, ...toolMessages],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }));

        // N2c per-unit rows: ONE semantic group = ONE header..footer span. The header
        // carries the full 200-tool membership — no every-N size splits (R5).
        expect(toolCallsGroupRowWithCommonSpy).not.toHaveBeenCalled();
        const headerGroupIds = new Set(toolGroupUnitHeaderSpy.mock.calls.map(([props]) => props?.groupId));
        expect(headerGroupIds.size).toBe(1);
        const headerToolIds = toolGroupUnitHeaderSpy.mock.calls[0]?.[0]?.toolMessages?.map((message: any) => message.id);
        expect(headerToolIds).toEqual(toolMessages.map((message) => message.id));
    });

    it('uses turn layout in tool transcripts when transcript layout is set to turns', async () => {
        settings.transcriptGroupingMode = 'turns';

        const userMessage: Message = {
            kind: 'user-text',
            id: 'user-1',
            localId: null,
            createdAt: 1,
            text: 'Start a task',
        };
        const toolMessage: Message = {
            kind: 'tool-call',
            id: 'tool-msg-1',
            localId: null,
            createdAt: 2,
            tool: makeToolCall({ id: 'tool-1', name: 'Read', input: { file: 'a.ts' }, createdAt: 2 }),
            children: [],
        };

        await renderScreen(React.createElement(ChainTestRoot, {
                    sessionId: 's1',
                    datasetKey: JSON.stringify(['s1', 'test-sidechain']),
                    messages: [userMessage, toolMessage],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                }));

        expect(turnViewSpy).not.toHaveBeenCalled();
        // N2c: the turn decomposes into per-unit rows — the user message renders as a
        // message row carrying the parent-provided session common, and the turn's tool
        // run renders as a tool-group unit span.
        expect(messageViewWithCommonSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.objectContaining({ id: 'user-1' }),
                messageDisplayCommon: expect.objectContaining({
                    sessionThinkingDisplayMode: 'inline',
                }),
            }),
        );
        expect(toolGroupUnitHeaderSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                toolMessages: [expect.objectContaining({ id: 'tool-msg-1' })],
            }),
        );
    });

    it('passes forced transcript permission prompts through to turn layouts', async () => {
        settings.transcriptGroupingMode = 'turns';

        const userMessage: Message = {
            kind: 'user-text',
            id: 'user-1',
            localId: null,
            createdAt: 1,
            text: 'Start a subagent',
        };

        const toolMessage: Message = {
            kind: 'tool-call',
            id: 'tool-msg-1',
            localId: null,
            createdAt: 2,
            tool: makeToolCall({ id: 'tool-1', name: 'Read', input: { file: 'a.ts' }, createdAt: 2 }),
            children: [],
        };

        await renderScreen(React.createElement(ChainTestRoot, {
                    sessionId: 's1',
                    datasetKey: JSON.stringify(['s1', 'test-sidechain']),
                    messages: [userMessage, toolMessage],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true },
                    forcePermissionPromptsInTranscript: true,
                }));

        // N2c: forced permission prompts flow to the decomposed rows — the message row
        // and the per-unit tool row.
        expect(messageViewWithCommonSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                forcePermissionPromptsInTranscript: true,
            }),
        );
        expect(toolGroupUnitToolSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.objectContaining({ id: 'tool-msg-1' }),
                forcePermissionPromptsInTranscript: true,
            }),
        );
    });

});
