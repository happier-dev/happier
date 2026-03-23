import { describe, expect, it } from 'vitest';

import {
    captureWebTranscriptPrependAnchor,
    refreshWebTranscriptPrependAnchor,
    restoreWebTranscriptPrependAnchor,
} from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

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

describe('webTranscriptPrependAnchor', () => {
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
        expect(restoreWebTranscriptPrependAnchor(anchor)).toEqual({
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
        expect(restoreWebTranscriptPrependAnchor(anchor)).toEqual({
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

        expect(restoreWebTranscriptPrependAnchor(anchor)).toEqual({
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

        expect(restoreWebTranscriptPrependAnchor(pendingAnchor)).toEqual({
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

        expect(restoreWebTranscriptPrependAnchor(anchor)).toEqual({
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
