import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectHostText, createToolCallMessageFixture, makeToolCall, renderScreen, standardCleanup } from '@/dev/testkit';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let chromeMode: 'cards' | 'activity_feed' = 'cards';

installMessageViewCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: createUseSettingMock({
                fallback: (key) => {
                    if (key === 'toolViewTimelineChromeMode') return chromeMode;
                    if (key === 'toolViewDetailLevelDefault') return 'title';
                    if (key === 'toolViewTimelineFeedDefaultExpanded') return false;
                    if (key === 'toolViewTapAction') return 'expand';
                    return settingsDefaults[key];
                },
            }),
        });
    },
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

const runRef = { runId: 'r1', callId: 'c1', backendId: 'b1' };
const structuredResults = [
    {
        kind: 'delegate_output.v1',
        payload: {
            runRef,
            summary: 'Delegated investigation complete.',
            deliverables: [{ id: 'report', title: 'Investigation report', details: 'reports/investigation.md' }],
            generatedAtMs: 1,
        },
        visibleText: 'Delegated investigation complete.',
    },
    {
        kind: 'plan_output.v1',
        payload: {
            runRef,
            summary: 'Plan the disclosure correction.',
            sections: [{ title: 'Implementation', items: ['Reuse the tool disclosure.'] }],
            generatedAtMs: 1,
        },
        visibleText: 'Plan the disclosure correction.',
    },
] as const;

describe.each(['cards', 'activity_feed'] as const)('structured tool results in %s', (mode) => {
    afterEach(async () => {
        const { clearTranscriptJumpHighlight } = await import('./navigation/transcriptJumpHighlightStore');
        await act(async () => clearTranscriptJumpHighlight());
        standardCleanup();
    });

    it.each(structuredResults)('keeps $kind inside the tool disclosure', async (result) => {
        chromeMode = mode;
        const { MessageView } = await import('./MessageView');
        const message = createToolCallMessageFixture({
            id: 'm1',
            seq: 11,
            tool: makeToolCall({
                name: 'mcp__happier__execution_run_get',
                state: 'completed',
                input: { runId: 'r1' },
                result: { ok: true },
            }),
            meta: { happier: { kind: result.kind, payload: result.payload } },
        });
        const screen = await renderScreen(<MessageView sessionId="s1" metadata={null} message={message} />);
        const headerId = mode === 'cards' ? 'tool-view-header-primary' : 'tool-timeline-row';

        expect(collectHostText(screen.tree).join('\n')).not.toContain(result.visibleText);
        expect(screen.findByTestId(headerId)).not.toBeNull();

        await screen.pressByTestIdAsync(headerId);
        expect(collectHostText(screen.tree).join('\n')).toContain(result.visibleText);

        await screen.pressByTestIdAsync(headerId);
        expect(collectHostText(screen.tree).join('\n')).not.toContain(result.visibleText);
    });

    it('keeps pin actions and jump attention on the collapsed tool row', async () => {
        chromeMode = mode;
        const { MessageView } = await import('./MessageView');
        const { applyTranscriptJumpHighlightForJumpResult } = await import('./navigation/transcriptJumpHighlightStore');
        const { TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID } = await import('./navigation/TranscriptJumpHighlightOverlay');
        const onToggleToolPin = vi.fn();
        const message = createToolCallMessageFixture({
            id: 'm1',
            seq: 11,
            transcriptBlockIndex: 3,
            tool: makeToolCall({ id: 'c1', name: 'mcp__happier__execution_run_get', state: 'completed', input: {}, result: {} }),
            meta: { happier: { kind: structuredResults[0].kind, payload: structuredResults[0].payload } },
        });
        const screen = await renderScreen(
            <MessageView
                sessionId="s1"
                metadata={null}
                message={message}
                onToggleToolPin={onToggleToolPin}
                interaction={deriveTranscriptInteraction({ kind: 'session', accessLevel: null, canApprovePermissions: true, isSessionActive: true })}
            />,
        );
        await screen.pressByTestIdAsync('transcript-tool-call-pin:m1');
        expect(onToggleToolPin).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', seq: 11, role: 'tool' }));
        await act(async () => {
            applyTranscriptJumpHighlightForJumpResult('s1', {
                status: 'window-rendered', target: { kind: 'seq', seq: 11 }, windowId: 'w1',
            });
        });
        expect(screen.findAllByTestId(TRANSCRIPT_JUMP_HIGHLIGHT_TEST_ID)).toHaveLength(1);
    });
});
