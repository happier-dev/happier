// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { CapturingLegendListMockState } from '@/dev/testkit/mocks/legendList';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const legendListCapture = vi.hoisted(() => ({
    state: null as CapturingLegendListMockState | null,
}));

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: (props: Record<string, unknown>) => React.createElement('MessageView', props),
    MessageViewWithSessionCommon: (props: Record<string, unknown>) => React.createElement('MessageViewWithSessionCommon', props),
}));

vi.mock('@/components/sessions/transcript/ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const mock = createCapturingLegendListMock();
    legendListCapture.state = mock.state;
    return mock.module;
});

describe('public TranscriptList web keyboard ownership', () => {
    afterEach(() => {
        standardCleanup();
        document.body.replaceChildren();
    });

    it('forwards only keyboard input owned by its shell scroller to the renderer takeover contract', async () => {
        const { Platform } = await import('react-native');
        const { registerWebTranscriptKeyboardOwner } = await import(
            '@/components/sessions/transcript/viewport/lifecycle/webTranscriptKeyboardOwner'
        );
        const { TranscriptList } = await import('./TranscriptList');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const publicScroller = document.createElement('div');
        const otherScroller = document.createElement('div');
        document.body.append(publicScroller, otherScroller);
        const capture = legendListCapture.state;
        if (!capture) throw new Error('LegendList mock did not initialize');
        capture.refHandle.getScrollableNode.mockReturnValue(publicScroller);
        const otherInput = vi.fn();
        const unregisterOther = registerWebTranscriptKeyboardOwner({
            document,
            onViewportKeyboardInput: otherInput,
            resolveScroller: () => otherScroller,
        });

        try {
            await renderScreen(<TranscriptList
                sessionId="public-keyboard-session"
                datasetKey="public:public-keyboard-session:1"
                metadata={null}
                messages={[
                    { kind: 'agent-text', id: 'answer', localId: null, createdAt: 1, text: 'answer', isThinking: false },
                ]}
                interaction={{ canSendMessages: false, canApprovePermissions: false }}
            />);
            expect(capture.props.maintainScrollAtEnd).toMatchObject({ animated: false });

            act(() => {
                otherScroller.dispatchEvent(new KeyboardEvent('keydown', {
                    bubbles: true,
                    key: 'PageUp',
                }));
            });
            expect(otherInput).toHaveBeenCalledWith('toward-start');
            expect(capture.props.maintainScrollAtEnd).toMatchObject({ animated: false });

            act(() => {
                publicScroller.dispatchEvent(new KeyboardEvent('keydown', {
                    bubbles: true,
                    key: 'PageUp',
                }));
            });
            expect(capture.props.maintainScrollAtEnd).toBe(false);
        } finally {
            unregisterOther();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});
