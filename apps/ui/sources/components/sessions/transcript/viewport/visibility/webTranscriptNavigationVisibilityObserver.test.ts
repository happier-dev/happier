import { describe, expect, it, vi } from 'vitest';

import { TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';

import { createTranscriptNavigationVisibilityStore } from './transcriptNavigationVisibilityStore';
import { observeWebTranscriptNavigationVisibility } from './webTranscriptNavigationVisibilityObserver';
import type { TranscriptNavigationRuntimeAnchor } from './transcriptNavigationRuntimeAnchors';

type FakeNode = Readonly<{
    testId: string;
    rect: Readonly<{ top: number; bottom: number }>;
}>;

function createMetrics(nodes: readonly FakeNode[]) {
    const selectorCalls: string[] = [];
    const rectCalls: string[] = [];
    const element = {
        clientHeight: 100,
        getBoundingClientRect: vi.fn(() => ({ top: 0, bottom: 100 })),
        querySelectorAll: vi.fn((selector: string) => {
            selectorCalls.push(selector);
            return nodes
                .filter((node) => selector.includes(JSON.stringify(node.testId)))
                .map((node) => ({
                    getAttribute: (name: string) => name === 'data-testid' ? node.testId : null,
                    getBoundingClientRect: () => {
                        rectCalls.push(node.testId);
                        return node.rect;
                    },
                }));
        }),
    };
    return {
        metrics: {
            clientHeight: 100,
            element: element as unknown as HTMLElement,
            scrollHeight: 400,
            scrollTop: 0,
        },
        rectCalls,
        selectorCalls,
    };
}

const anchors: readonly TranscriptNavigationRuntimeAnchor[] = [
    {
        id: 'session-1:user-turn:7',
        kind: 'user-turn',
        sourceIndex: 0,
        messageIds: ['message-7'],
    },
    {
        id: 'session-1:user-turn:9',
        kind: 'user-turn',
        sourceIndex: 1,
        messageIds: ['message-9'],
    },
];

describe('web transcript navigation visibility observer', () => {
    it('does no DOM measurement when the visibility store has no subscribers', () => {
        const store = createTranscriptNavigationVisibilityStore();
        const { metrics } = createMetrics([
            {
                testId: `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}message-7`,
                rect: { top: 0, bottom: 40 },
            },
        ]);

        observeWebTranscriptNavigationVisibility({
            anchors,
            metrics,
            scrollIntent: { isTrusted: true },
            store,
        });

        expect(metrics.element.getBoundingClientRect).not.toHaveBeenCalled();
        expect(metrics.element.querySelectorAll).not.toHaveBeenCalled();
    });

    it('queries only registered message-anchor test ids and writes current visibility facts', () => {
        const store = createTranscriptNavigationVisibilityStore();
        const unsubscribe = store.subscribe(vi.fn());
        const { metrics, rectCalls, selectorCalls } = createMetrics([
            {
                testId: `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}message-7`,
                rect: { top: 0, bottom: 40 },
            },
            {
                testId: `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}message-9`,
                rect: { top: 160, bottom: 220 },
            },
            {
                testId: 'unrelated-control',
                rect: { top: 0, bottom: 40 },
            },
        ]);

        observeWebTranscriptNavigationVisibility({
            anchors,
            metrics,
            scrollIntent: { isTrusted: false },
            store,
        });

        expect(selectorCalls).toHaveLength(1);
        expect(selectorCalls[0]).toContain(`${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}message-7`);
        expect(selectorCalls[0]).toContain(`${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}message-9`);
        expect(selectorCalls[0]).not.toContain('unrelated-control');
        expect(rectCalls).toEqual([
            `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}message-7`,
            `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}message-9`,
        ]);
        expect(store.get()).toEqual({
            currentAnchorId: 'session-1:user-turn:7',
            visibleAnchorIds: ['session-1:user-turn:7'],
        });

        unsubscribe();
    });
});
