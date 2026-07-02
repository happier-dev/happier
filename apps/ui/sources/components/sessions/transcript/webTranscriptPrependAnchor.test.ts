import { describe, expect, it } from 'vitest';

import * as webTranscriptPrependAnchorModule from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import {
    captureWebTranscriptPrependAnchor,
    refreshWebTranscriptPrependAnchor,
    restoreWebTranscriptPrependAnchor,
} from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

type CaptureWebTranscriptViewportAnchor = (params: Readonly<{
    container: HTMLElement;
}>) => {
    kind: 'message' | 'toolGroup' | 'item';
    messageId: string | null;
    itemId: string;
    itemOffsetPx: number;
} | null;

type RestoreWebTranscriptViewportAnchor = (params: Readonly<{
    container: HTMLElement;
    anchor: Readonly<{
        kind: 'message' | 'toolGroup' | 'item';
        messageId?: string | null;
        itemId: string;
        itemOffsetPx: number;
    }>;
}>, options?: Readonly<{
    writeScrollTop: (targetScrollTop: number) => boolean;
}>) => {
    didAdjustScroll: boolean;
    status: 'restored' | 'already_aligned' | 'not_found' | 'not_applied';
};

function resolveModuleFunction<TFunction extends (...args: never[]) => unknown>(name: string): TFunction | null {
    const moduleExports = webTranscriptPrependAnchorModule as unknown as Record<string, unknown>;
    const exported = moduleExports[name];
    expect(exported).toEqual(expect.any(Function));
    return typeof exported === 'function' ? exported as TFunction : null;
}

class FakeElement {
    public scrollTop = 0;
    public scrollHeight = 0;
    public clientHeight = 0;
    public scrollWidth = 0;
    public clientWidth = 0;
    public isConnected = true;
    public parentElement: FakeElement | null = null;

    private rect: { top: number; bottom: number };
    private readonly nodesBySelector = new Map<string, FakeElement[]>();

    constructor(
        private readonly testId: string | null,
        rect: { top: number; bottom: number },
    ) {
        this.rect = rect;
    }

    getAttribute(name: string) {
        return name === 'data-testid' ? this.testId : null;
    }

    getBoundingClientRect() {
        return {
            top: this.rect.top,
            bottom: this.rect.bottom,
            left: 0,
            right: 0,
            width: 0,
            height: this.rect.bottom - this.rect.top,
            x: 0,
            y: this.rect.top,
            toJSON: () => ({}),
        };
    }

    querySelectorAll(selector: string) {
        return this.nodesBySelector.get(selector) ?? [];
    }

    setQuerySelectorAll(selector: string, nodes: FakeElement[]) {
        this.nodesBySelector.set(selector, nodes);
    }

    setRect(rect: { top: number; bottom: number }) {
        this.rect = rect;
    }
}

function createContainer(params: Readonly<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    anchors: FakeElement[];
}>): FakeElement {
    const container = new FakeElement(null, { top: 0, bottom: params.clientHeight });
    container.scrollTop = params.scrollTop;
    container.scrollHeight = params.scrollHeight;
    container.clientHeight = params.clientHeight;
    container.setQuerySelectorAll('[data-testid]', params.anchors);
    return container;
}

function installFakeHTMLElement() {
    const globalWithHTMLElement = globalThis as unknown as Record<'HTMLElement', unknown>;
    const originalHTMLElement = globalWithHTMLElement.HTMLElement;
    globalWithHTMLElement.HTMLElement = FakeElement;
    return () => {
        globalWithHTMLElement.HTMLElement = originalHTMLElement;
    };
}

function writeScrollTopFor(container: FakeElement) {
    return {
        writeScrollTop: (targetScrollTop: number) => {
            container.scrollTop = targetScrollTop;
            return true;
        },
    };
}

describe('webTranscriptPrependAnchor', () => {
    it('captures the focused message viewport anchor with its containing item and saved item offset', () => {
        const captureWebTranscriptViewportAnchor =
            resolveModuleFunction<CaptureWebTranscriptViewportAnchor>('captureWebTranscriptViewportAnchor');
        if (!captureWebTranscriptViewportAnchor) return;
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const itemAnchor = new FakeElement('transcript-item-turn:1', { top: -180, bottom: 420 });
            const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 78, bottom: 148 });
            messageAnchor.parentElement = itemAnchor;
            const container = createContainer({
                scrollTop: 320,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [itemAnchor, messageAnchor],
            });
            itemAnchor.parentElement = container;

            expect(captureWebTranscriptViewportAnchor({ container: container as unknown as HTMLElement })).toEqual({
                kind: 'message',
                messageId: 'm1',
                itemId: 'turn:1',
                itemOffsetPx: -180,
            });
        } finally {
            restoreHTMLElement();
        }
    });

    it('captures the focused tool group viewport anchor when no message anchor is available', () => {
        const captureWebTranscriptViewportAnchor =
            resolveModuleFunction<CaptureWebTranscriptViewportAnchor>('captureWebTranscriptViewportAnchor');
        if (!captureWebTranscriptViewportAnchor) return;
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const itemAnchor = new FakeElement('transcript-item-turn:1', { top: -120, bottom: 380 });
            const toolGroupAnchor = new FakeElement('transcript-anchor-tool-group-tool-1', { top: 92, bottom: 190 });
            toolGroupAnchor.parentElement = itemAnchor;
            const container = createContainer({
                scrollTop: 320,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [itemAnchor, toolGroupAnchor],
            });
            itemAnchor.parentElement = container;

            expect(captureWebTranscriptViewportAnchor({ container: container as unknown as HTMLElement })).toEqual({
                kind: 'toolGroup',
                messageId: 'tool-1',
                itemId: 'turn:1',
                itemOffsetPx: -120,
            });
        } finally {
            restoreHTMLElement();
        }
    });

    it('captures the focused generic item viewport anchor when no finer anchor is available', () => {
        const captureWebTranscriptViewportAnchor =
            resolveModuleFunction<CaptureWebTranscriptViewportAnchor>('captureWebTranscriptViewportAnchor');
        if (!captureWebTranscriptViewportAnchor) return;
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const itemAnchor = new FakeElement('transcript-item-system:1', { top: 54, bottom: 190 });
            const container = createContainer({
                scrollTop: 320,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [itemAnchor],
            });
            itemAnchor.parentElement = container;

            expect(captureWebTranscriptViewportAnchor({ container: container as unknown as HTMLElement })).toEqual({
                kind: 'item',
                messageId: null,
                itemId: 'system:1',
                itemOffsetPx: 54,
            });
        } finally {
            restoreHTMLElement();
        }
    });

    it('restores a saved viewport anchor to its item offset when the DOM node exists', () => {
        const restoreWebTranscriptViewportAnchor =
            resolveModuleFunction<RestoreWebTranscriptViewportAnchor>('restoreWebTranscriptViewportAnchor');
        if (!restoreWebTranscriptViewportAnchor) return;
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const itemAnchor = new FakeElement('transcript-item-turn:1', { top: 180, bottom: 640 });
            const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 240, bottom: 320 });
            messageAnchor.parentElement = itemAnchor;
            const container = createContainer({
                scrollTop: 500,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [itemAnchor, messageAnchor],
            });
            itemAnchor.parentElement = container;

            expect(restoreWebTranscriptViewportAnchor({
                container: container as unknown as HTMLElement,
                anchor: {
                    kind: 'message',
                    messageId: 'm1',
                    itemId: 'turn:1',
                    itemOffsetPx: 72,
                },
            }, writeScrollTopFor(container))).toEqual({
                didAdjustScroll: true,
                status: 'restored',
            });
            expect(container.scrollTop).toBe(608);
        } finally {
            restoreHTMLElement();
        }
    });

    it('restores through the saved message anchor when its containing item id changed', () => {
        const restoreWebTranscriptViewportAnchor =
            resolveModuleFunction<RestoreWebTranscriptViewportAnchor>('restoreWebTranscriptViewportAnchor');
        if (!restoreWebTranscriptViewportAnchor) return;
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const regroupedItemAnchor = new FakeElement('transcript-item-turn:regrouped', { top: 210, bottom: 640 });
            const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 260, bottom: 320 });
            messageAnchor.parentElement = regroupedItemAnchor;
            const container = createContainer({
                scrollTop: 500,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [regroupedItemAnchor, messageAnchor],
            });
            regroupedItemAnchor.parentElement = container;

            expect(restoreWebTranscriptViewportAnchor({
                container: container as unknown as HTMLElement,
                anchor: {
                    kind: 'message',
                    messageId: 'm1',
                    itemId: 'turn:stale',
                    itemOffsetPx: 72,
                },
            }, writeScrollTopFor(container))).toEqual({
                didAdjustScroll: true,
                status: 'restored',
            });
            expect(container.scrollTop).toBe(638);
        } finally {
            restoreHTMLElement();
        }
    });

    it('delegates viewport anchor scroll writes to the supplied writer', () => {
        const restoreWebTranscriptViewportAnchor =
            resolveModuleFunction<RestoreWebTranscriptViewportAnchor>('restoreWebTranscriptViewportAnchor');
        if (!restoreWebTranscriptViewportAnchor) return;
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const itemAnchor = new FakeElement('transcript-item-turn:1', { top: 180, bottom: 640 });
            const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 240, bottom: 320 });
            messageAnchor.parentElement = itemAnchor;
            const container = createContainer({
                scrollTop: 500,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [itemAnchor, messageAnchor],
            });
            itemAnchor.parentElement = container;
            const requestedTargets: number[] = [];

            expect(restoreWebTranscriptViewportAnchor({
                container: container as unknown as HTMLElement,
                anchor: {
                    kind: 'message',
                    messageId: 'm1',
                    itemId: 'turn:1',
                    itemOffsetPx: 72,
                },
            }, {
                writeScrollTop: (targetScrollTop) => {
                    requestedTargets.push(targetScrollTop);
                    return false;
                },
            })).toEqual({
                didAdjustScroll: false,
                status: 'not_applied',
            });
            expect(requestedTargets).toEqual([608]);
            expect(container.scrollTop).toBe(500);
        } finally {
            restoreHTMLElement();
        }
    });

    it('resolves read-only viewport anchor alignment without adjusting scroll', () => {
        const resolveWebTranscriptViewportAnchorAlignment = resolveModuleFunction<(params: Readonly<{
            container: HTMLElement;
            anchor: Readonly<{
                kind: 'message' | 'toolGroup' | 'item';
                messageId?: string | null;
                itemId: string;
                itemOffsetPx: number;
            }>;
            tolerancePx?: number;
        }>) => { status: 'aligned' | 'misaligned'; deltaPx: number } | { status: 'not_found' }>(
            'resolveWebTranscriptViewportAnchorAlignment',
        );
        if (!resolveWebTranscriptViewportAnchorAlignment) return;
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const itemAnchor = new FakeElement('transcript-item-turn:1', { top: 180, bottom: 640 });
            const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 240, bottom: 320 });
            messageAnchor.parentElement = itemAnchor;
            const container = createContainer({
                scrollTop: 500,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [itemAnchor, messageAnchor],
            });
            itemAnchor.parentElement = container;

            const anchor = {
                kind: 'message' as const,
                messageId: 'm1',
                itemId: 'turn:1',
                itemOffsetPx: 72,
            };
            expect(resolveWebTranscriptViewportAnchorAlignment({
                container: container as unknown as HTMLElement,
                anchor,
                tolerancePx: 4,
            })).toEqual({ status: 'misaligned', deltaPx: 108 });
            expect(container.scrollTop).toBe(500);

            expect(resolveWebTranscriptViewportAnchorAlignment({
                container: container as unknown as HTMLElement,
                anchor: { ...anchor, itemOffsetPx: 178 },
                tolerancePx: 4,
            })).toEqual({ status: 'aligned', deltaPx: 2 });
            expect(container.scrollTop).toBe(500);

            const emptyContainer = createContainer({
                scrollTop: 500,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [],
            });
            expect(resolveWebTranscriptViewportAnchorAlignment({
                container: emptyContainer as unknown as HTMLElement,
                anchor,
                tolerancePx: 4,
            })).toEqual({ status: 'not_found' });
        } finally {
            restoreHTMLElement();
        }
    });

    it('reports not found without paging when a saved viewport anchor is not mounted in the DOM', () => {
        const restoreWebTranscriptViewportAnchor =
            resolveModuleFunction<RestoreWebTranscriptViewportAnchor>('restoreWebTranscriptViewportAnchor');
        if (!restoreWebTranscriptViewportAnchor) return;
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const container = createContainer({
                scrollTop: 500,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [],
            });

            expect(restoreWebTranscriptViewportAnchor({
                container: container as unknown as HTMLElement,
                anchor: {
                    kind: 'message',
                    messageId: 'm1',
                    itemId: 'turn:1',
                    itemOffsetPx: 72,
                },
            }, writeScrollTopFor(container))).toEqual({
                didAdjustScroll: false,
                status: 'not_found',
            });
            expect(container.scrollTop).toBe(500);
        } finally {
            restoreHTMLElement();
        }
    });

    it('falls back to scroll-height growth when a virtualized prepend keeps the tracked anchor at the same top', () => {
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const itemAnchor = new FakeElement('transcript-item-turn:1', { top: 120, bottom: 360 });
            const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 160, bottom: 220 });
            messageAnchor.parentElement = itemAnchor;
            const container = createContainer({
                scrollTop: 100,
                scrollHeight: 1800,
                clientHeight: 600,
                anchors: [itemAnchor, messageAnchor],
            });
            itemAnchor.parentElement = container;

            const result = restoreWebTranscriptPrependAnchor({
                metrics: {
                    element: container as unknown as HTMLElement,
                    scrollTop: 100,
                    scrollHeight: 1200,
                    clientHeight: 600,
                },
                anchorTestId: 'transcript-anchor-message-m1',
                anchorTop: 160,
                itemTestId: 'transcript-item-turn:1',
                itemTop: 120,
                stabilizeForMs: 1000,
                userIntentAtMs: 0,
                expiresAtMs: Date.now() + 1000,
            }, writeScrollTopFor(container));

            expect(result).toEqual({ didAdjustScroll: true, strategy: 'growth' });
            expect(container.scrollTop).toBe(700);
        } finally {
            restoreHTMLElement();
        }
    });

    it('leaves scroll position unchanged when the prepend growth fallback writer refuses the write', () => {
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const itemAnchor = new FakeElement('transcript-item-turn:1', { top: 120, bottom: 360 });
            const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 160, bottom: 220 });
            messageAnchor.parentElement = itemAnchor;
            const container = createContainer({
                scrollTop: 100,
                scrollHeight: 1800,
                clientHeight: 600,
                anchors: [itemAnchor, messageAnchor],
            });
            itemAnchor.parentElement = container;
            const requestedTargets: number[] = [];

            const result = restoreWebTranscriptPrependAnchor({
                metrics: {
                    element: container as unknown as HTMLElement,
                    scrollTop: 100,
                    scrollHeight: 1200,
                    clientHeight: 600,
                },
                anchorTestId: 'transcript-anchor-message-m1',
                anchorTop: 160,
                itemTestId: 'transcript-item-turn:1',
                itemTop: 120,
                stabilizeForMs: 1000,
                userIntentAtMs: 0,
                expiresAtMs: Date.now() + 1000,
            }, {
                writeScrollTop: (targetScrollTop) => {
                    requestedTargets.push(targetScrollTop);
                    return false;
                },
            });

            expect(result).toEqual({ didAdjustScroll: false, strategy: 'none' });
            expect(requestedTargets).toEqual([700]);
            expect(container.scrollTop).toBe(100);
        } finally {
            restoreHTMLElement();
        }
    });

    it('captures a message anchor instead of a coarse turn wrapper when the message is closest to the upper viewport focus', () => {
        const originalHTMLElement = (globalThis as any).HTMLElement;
        (globalThis as any).HTMLElement = FakeElement;

        const turnAnchor = new FakeElement('transcript-item-turn:1', { top: -220, bottom: 500 });
        const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 30, bottom: 130 });
        const container = createContainer({
            scrollTop: 100,
            scrollHeight: 1200,
            clientHeight: 600,
            anchors: [turnAnchor, messageAnchor],
        });

        const metrics: WebTranscriptScrollMetrics = {
            element: container as unknown as HTMLElement,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };

        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: 1,
            stabilizeForMs: 3000,
        });

        container.scrollHeight = 1400;
        messageAnchor.setRect({ top: 130, bottom: 230 });
        turnAnchor.setRect({ top: -140, bottom: 580 });

        expect(anchor.anchorTestId).toBe('transcript-anchor-message-m1');
        expect(restoreWebTranscriptPrependAnchor(anchor, writeScrollTopFor(container))).toEqual({
            didAdjustScroll: true,
            strategy: 'anchor',
        });
        expect(container.scrollTop).toBe(200);

        (globalThis as any).HTMLElement = originalHTMLElement;
    });

    it('captures the upper tool-group anchor instead of a lower visible message anchor', () => {
        const originalHTMLElement = (globalThis as any).HTMLElement;
        (globalThis as any).HTMLElement = FakeElement;

        const toolGroupAnchor = new FakeElement('transcript-anchor-tool-group-tool-1', { top: 20, bottom: 220 });
        const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 540, bottom: 640 });
        const container = createContainer({
            scrollTop: 100,
            scrollHeight: 1200,
            clientHeight: 600,
            anchors: [toolGroupAnchor, messageAnchor],
        });

        const metrics: WebTranscriptScrollMetrics = {
            element: container as unknown as HTMLElement,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };

        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: 1,
            stabilizeForMs: 3000,
        });

        container.scrollHeight = 1400;
        toolGroupAnchor.setRect({ top: 120, bottom: 320 });
        messageAnchor.setRect({ top: 760, bottom: 860 });

        expect(anchor.anchorTestId).toBe('transcript-anchor-tool-group-tool-1');
        expect(restoreWebTranscriptPrependAnchor(anchor, writeScrollTopFor(container))).toEqual({
            didAdjustScroll: true,
            strategy: 'anchor',
        });
        expect(container.scrollTop).toBe(200);

        (globalThis as any).HTMLElement = originalHTMLElement;
    });

    it('keeps the original anchor across a growth fallback so a later remount can restore precisely', () => {
        const originalHTMLElement = (globalThis as any).HTMLElement;
        (globalThis as any).HTMLElement = FakeElement;

        const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 80, bottom: 180 });
        const container = createContainer({
            scrollTop: 100,
            scrollHeight: 1200,
            clientHeight: 600,
            anchors: [messageAnchor],
        });

        const metrics: WebTranscriptScrollMetrics = {
            element: container as unknown as HTMLElement,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };

        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: 1,
            stabilizeForMs: 3000,
        });

        container.scrollHeight = 5200;
        container.setQuerySelectorAll('[data-testid]', []);

        expect(restoreWebTranscriptPrependAnchor(anchor, writeScrollTopFor(container))).toEqual({
            didAdjustScroll: true,
            strategy: 'growth',
        });
        expect(container.scrollTop).toBe(4100);

        const pendingAnchor = refreshWebTranscriptPrependAnchor(anchor, {
            element: container as unknown as HTMLElement,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        }, {
            preserveBaselineMetrics: true,
        });

        messageAnchor.setRect({ top: 260, bottom: 360 });
        container.setQuerySelectorAll('[data-testid]', [messageAnchor]);

        expect(restoreWebTranscriptPrependAnchor(pendingAnchor, writeScrollTopFor(container))).toEqual({
            didAdjustScroll: true,
            strategy: 'anchor',
        });
        expect(container.scrollTop).toBe(4280);

        (globalThis as any).HTMLElement = originalHTMLElement;
    });

    it('falls back to the captured list item when the primary anchor is missing but the item wrapper is visible', () => {
        const originalHTMLElement = (globalThis as any).HTMLElement;
        (globalThis as any).HTMLElement = FakeElement;

        const itemAnchor = new FakeElement('transcript-item-turn:1', { top: 40, bottom: 340 });
        const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 96, bottom: 156 });
        const container = createContainer({
            scrollTop: 400,
            scrollHeight: 1800,
            clientHeight: 600,
            anchors: [itemAnchor, messageAnchor],
        });

        const metrics: WebTranscriptScrollMetrics = {
            element: container as unknown as HTMLElement,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };

        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: 1,
            stabilizeForMs: 3000,
        });

        container.scrollHeight = 2200;
        container.setQuerySelectorAll('[data-testid]', [itemAnchor]);
        itemAnchor.setRect({ top: 140, bottom: 440 });

        expect(restoreWebTranscriptPrependAnchor(anchor, writeScrollTopFor(container))).toEqual({
            didAdjustScroll: true,
            strategy: 'item',
        });
        expect(container.scrollTop).toBe(500);

        (globalThis as any).HTMLElement = originalHTMLElement;
    });

    it('captures the containing transcript item for the chosen anchor instead of an unrelated closer item wrapper', () => {
        const originalHTMLElement = (globalThis as any).HTMLElement;
        (globalThis as any).HTMLElement = FakeElement;

        const unrelatedItemAnchor = new FakeElement('transcript-item-turn:wrong', { top: 10, bottom: 250 });
        const containingItemAnchor = new FakeElement('transcript-item-turn:right', { top: -120, bottom: 420 });
        const toolGroupAnchor = new FakeElement('transcript-anchor-tool-group-tool-1', { top: 72, bottom: 172 });

        containingItemAnchor.parentElement = null;
        unrelatedItemAnchor.parentElement = null;
        toolGroupAnchor.parentElement = containingItemAnchor;

        const container = createContainer({
            scrollTop: 400,
            scrollHeight: 1800,
            clientHeight: 600,
            anchors: [unrelatedItemAnchor, containingItemAnchor, toolGroupAnchor],
        });
        unrelatedItemAnchor.parentElement = container;
        containingItemAnchor.parentElement = container;

        const metrics: WebTranscriptScrollMetrics = {
            element: container as unknown as HTMLElement,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };

        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: 1,
            stabilizeForMs: 3000,
        });

        expect(anchor.anchorTestId).toBe('transcript-anchor-tool-group-tool-1');
        expect(anchor.itemTestId).toBe('transcript-item-turn:right');

        (globalThis as any).HTMLElement = originalHTMLElement;
    });

    it('prefers a visible per-tool anchor inside a large semantic tool group wrapper', () => {
        const originalHTMLElement = (globalThis as any).HTMLElement;
        (globalThis as any).HTMLElement = FakeElement;

        const enclosingItemAnchor = new FakeElement('transcript-item-toolCalls:turn:large', { top: -5200, bottom: 460 });
        const coarseToolGroupAnchor = new FakeElement('transcript-anchor-tool-group-tool-last', { top: -5200, bottom: 460 });
        const visibleToolAnchor = new FakeElement('transcript-anchor-tool-call-tool-42', { top: 118, bottom: 146 });
        coarseToolGroupAnchor.parentElement = enclosingItemAnchor;
        visibleToolAnchor.parentElement = enclosingItemAnchor;

        const container = createContainer({
            scrollTop: 6800,
            scrollHeight: 12000,
            clientHeight: 600,
            anchors: [enclosingItemAnchor, coarseToolGroupAnchor, visibleToolAnchor],
        });
        enclosingItemAnchor.parentElement = container;

        const metrics: WebTranscriptScrollMetrics = {
            element: container as unknown as HTMLElement,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };

        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: 1,
            stabilizeForMs: 3000,
        });

        expect(anchor.anchorTestId).toBe('transcript-anchor-tool-call-tool-42');
        expect(anchor.anchorTop).toBe(118);
        expect(anchor.itemTestId).toBe('transcript-item-toolCalls:turn:large');
        expect(anchor.itemTop).toBe(-5200);

        (globalThis as any).HTMLElement = originalHTMLElement;
    });

    it('prefers a stable message anchor over an enclosing transcript item wrapper for the primary anchor', () => {
        const originalHTMLElement = (globalThis as any).HTMLElement;
        (globalThis as any).HTMLElement = FakeElement;

        const enclosingItemAnchor = new FakeElement('transcript-item-turn:stale', { top: 20, bottom: 360 });
        const stableMessageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 120, bottom: 180 });
        stableMessageAnchor.parentElement = enclosingItemAnchor;

        const container = createContainer({
            scrollTop: 100,
            scrollHeight: 1200,
            clientHeight: 600,
            anchors: [enclosingItemAnchor, stableMessageAnchor],
        });
        enclosingItemAnchor.parentElement = container;

        const metrics: WebTranscriptScrollMetrics = {
            element: container as unknown as HTMLElement,
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight,
        };

        const anchor = captureWebTranscriptPrependAnchor({
            metrics,
            userIntentAtMs: 1,
            stabilizeForMs: 3000,
        });

        expect(anchor.anchorTestId).toBe('transcript-anchor-message-m1');
        expect(anchor.itemTestId).toBe('transcript-item-turn:stale');

        (globalThis as any).HTMLElement = originalHTMLElement;
    });
});
