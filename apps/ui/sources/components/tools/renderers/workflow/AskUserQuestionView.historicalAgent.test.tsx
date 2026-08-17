import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';

import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { makeToolCall, makeToolViewProps, renderScreen } from '@/dev/testkit';
import { createMixedAgentTranscriptFixture } from '@/dev/testkit/fixtures/sessionAgentTransitionFixtures';
import { buildSessionTranscriptAgentAttributionIndex } from '@/components/sessions/transcript/attribution/sessionTranscriptAgentAttribution';
import {
    SessionTranscriptAgentAttributionProvider,
    TranscriptRowSeqProvider,
} from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';
import { installWorkflowRendererCommonModuleMocks } from './workflowRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Which Agent's presentation transform a HISTORICAL AskUserQuestion row uses.
 *
 * Only Claude contributes `workflow.resolveAskUserQuestionPresentation`, and its
 * transform rewrites an open-terminal notice's header/question into the notice
 * copy. So the presence of that copy is a clean read of which Agent's behavior
 * the row resolved.
 *
 * A Session keeps its identity across a switch, so a Claude-era notice row must
 * keep its copy after the Session becomes Codex. The ANSWER path is deliberately
 * excluded from this: only the Agent running now may answer a live prompt.
 */
const currentSessionFlavor = { value: 'codex' as string };

installWorkflowRendererCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            Text: (props: any) => React.createElement('Text', props, props.children),
            TouchableOpacity: (props: any) => React.createElement('TouchableOpacity', props, props.children),
            TextInput: (props: any) => React.createElement('TextInput', props, null),
            ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, null),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => ({
                    sessions: {
                        s1: { metadata: { flavor: currentSessionFlavor.value }, agentState: { requests: {} } },
                    },
                }),
            },
        });
    },
});

vi.mock('@/sync/ops', () => ({ sessionAllowWithAnswers: vi.fn(async () => {}) }));

vi.mock('@/components/sessions/terminal/openAttachedSessionTerminal', () => ({
    useOpenAttachedSessionTerminal: () => ({ available: false, unavailableReason: null, open: vi.fn() }),
}));

const NOTICE_HEADER_KEY = 'tools.askUserQuestion.claudeDialogNotice.header';

/** A completed Claude open-terminal notice, in its untransformed legacy shape. */
function noticeTool(): ToolCall {
    return makeToolCall({
        name: 'AskUserQuestion',
        state: 'completed',
        input: {
            happierDialog: {
                kind: 'unrecognized',
                dialogId: 'unrecognized_confirmation',
                mode: 'notice',
                action: 'open_terminal',
            },
            questions: [{ header: 'raw-header', question: 'raw-question', multiSelect: false, options: [] }],
        },
        permission: { id: 'toolu_1', status: 'pending' },
    });
}

function collectText(node: unknown, out: string[]): void {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { for (const child of node) collectText(child, out); return; }
    if (node && typeof node === 'object' && 'children' in node) {
        collectText((node as { children?: unknown }).children, out);
    }
}

function hasNoticeCopy(tree: ReactTestRenderer): boolean {
    const out: string[] = [];
    collectText(tree.toJSON(), out);
    return out.includes(NOTICE_HEADER_KEY);
}

async function renderNoticeRow(params: Readonly<{ seq: number | null; sessionFlavor: string }>) {
    currentSessionFlavor.value = params.sessionFlavor;
    const { AskUserQuestionView } = await import('./AskUserQuestionView');
    // The Session ran Claude, then switched to Codex. Codex is current.
    const index = buildSessionTranscriptAgentAttributionIndex(
        createMixedAgentTranscriptFixture({ sourceAgentId: 'claude', targetAgentId: 'codex' }).messages,
    );
    const { tree } = await renderScreen(
        <SessionTranscriptAgentAttributionProvider value={index}>
            <TranscriptRowSeqProvider value={params.seq}>
                {React.createElement(AskUserQuestionView, makeToolViewProps(noticeTool(), { sessionId: 's1' }))}
            </TranscriptRowSeqProvider>
        </SessionTranscriptAgentAttributionProvider>,
    );
    return tree;
}

describe('AskUserQuestionView historical Agent', () => {
    const CLAUDE_ERA_SEQ = 10;

    it('keeps a Claude-era notice row’s copy after the Session switched to Codex', async () => {
        expect(hasNoticeCopy(await renderNoticeRow({ seq: CLAUDE_ERA_SEQ, sessionFlavor: 'codex' }))).toBe(true);
    });

    it('falls back to live authority when the row has no divider evidence', async () => {
        // Control: with no historical attribution the live Agent still decides,
        // so this must NOT pass merely because the lookup stopped reading live
        // metadata. Claude is current here, so the copy is expected.
        expect(hasNoticeCopy(await renderNoticeRow({ seq: null, sessionFlavor: 'claude' }))).toBe(true);
    });

    it('does not apply Claude’s transform to a Codex-era row on a Codex Session', async () => {
        expect(hasNoticeCopy(await renderNoticeRow({ seq: 30, sessionFlavor: 'codex' }))).toBe(false);
    });
});
