import { describe, expect, it } from 'vitest';

import * as webTranscriptPrependAnchorModule from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';

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
    public querySelectorAllCount = 0;
    public querySelectorCount = 0;
    public querySelectorShouldThrow = false;

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
        this.querySelectorAllCount += 1;
        return this.nodesBySelector.get(selector) ?? [];
    }

    querySelector(selector: string) {
        this.querySelectorCount += 1;
        if (this.querySelectorShouldThrow) {
            throw new Error('querySelector unavailable');
        }
        const testId = parseDataTestIdAttributeSelector(selector);
        if (testId == null) return this.nodesBySelector.get(selector)?.[0] ?? null;
        return this.nodesBySelector.get('[data-testid]')?.find((node) => node.getAttribute('data-testid') === testId) ?? null;
    }

    setQuerySelectorAll(selector: string, nodes: FakeElement[]) {
        this.nodesBySelector.set(selector, nodes);
    }

    setRect(rect: { top: number; bottom: number }) {
        this.rect = rect;
    }
}

function parseDataTestIdAttributeSelector(selector: string): string | null {
    const match = selector.match(/^\[data-testid="((?:\\.|[^"\\])*)"\]$/);
    if (!match) return null;
    return match[1]
        .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_value, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\(.)/g, '$1');
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


    it('restores through the saved message anchor when its containing item id changed', () => {
        const restoreWebTranscriptViewportAnchor =
            resolveModuleFunction<RestoreWebTranscriptViewportAnchor>('restoreWebTranscriptViewportAnchor');
        if (!restoreWebTranscriptViewportAnchor) return;
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const currentItemAnchor = new FakeElement('transcript-item-turn:current', { top: 180, bottom: 640 });
            const messageAnchor = new FakeElement('transcript-anchor-message-m1', { top: 240, bottom: 320 });
            messageAnchor.parentElement = currentItemAnchor;
            const container = createContainer({
                scrollTop: 500,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [currentItemAnchor, messageAnchor],
            });
            currentItemAnchor.parentElement = container;

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
            expect(container.scrollTop).toBe(608);
        } finally {
            restoreHTMLElement();
        }
    });

    it('restores saved viewport anchors with exact DOM lookups instead of scanning every test id descendant', () => {
        const restoreWebTranscriptViewportAnchor =
            resolveModuleFunction<RestoreWebTranscriptViewportAnchor>('restoreWebTranscriptViewportAnchor');
        if (!restoreWebTranscriptViewportAnchor) return;
        const restoreHTMLElement = installFakeHTMLElement();

        try {
            const itemId = 'turn:1/[quoted]"\\slash';
            const messageId = 'm1/[quoted]"\\slash';
            const itemAnchor = new FakeElement(`transcript-item-${itemId}`, { top: 180, bottom: 640 });
            const messageAnchor = new FakeElement(`transcript-anchor-message-${messageId}`, { top: 240, bottom: 320 });
            messageAnchor.parentElement = itemAnchor;
            const unrelatedAnchors = Array.from(
                { length: 300 },
                (_value, index) => new FakeElement(`unrelated-${index}`, { top: 0, bottom: 1 }),
            );
            const container = createContainer({
                scrollTop: 500,
                scrollHeight: 1600,
                clientHeight: 600,
                anchors: [...unrelatedAnchors, itemAnchor, messageAnchor],
            });
            itemAnchor.parentElement = container;

            expect(restoreWebTranscriptViewportAnchor({
                container: container as unknown as HTMLElement,
                anchor: {
                    kind: 'message',
                    messageId,
                    itemId,
                    itemOffsetPx: 72,
                },
            }, writeScrollTopFor(container))).toEqual({
                didAdjustScroll: true,
                status: 'restored',
            });
            expect(container.scrollTop).toBe(608);
            expect(container.querySelectorCount).toBe(2);
            expect(container.querySelectorAllCount).toBe(0);
        } finally {
            restoreHTMLElement();
        }
    });

    it('falls back to a test-id scan when exact DOM lookup is unavailable', () => {
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
            container.querySelectorShouldThrow = true;
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
            expect(container.querySelectorCount).toBe(2);
            expect(container.querySelectorAllCount).toBe(2);
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

});
