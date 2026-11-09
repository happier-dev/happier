import React from 'react';
import type { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installCodeViewCommonModuleMocks } from './codeViewTestHelpers';
import { buildCodeLinesFromUnifiedDiff } from '../model/buildCodeLinesFromUnifiedDiff';
import { CodeLinesViewCore } from './CodeLinesViewCore';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
installCodeViewCommonModuleMocks();
const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -1 +1 @@\n-old\n+new' });
const settleScroll = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });

describe('code line navigation', () => {
    it('honors a new reveal request for the same line without repeating equivalent requests', async () => {
        let scrollY = 0;
        let landings = 0;
        const externalScrollView = {
            scrollRef: { current: { scrollTo: ({ y }: { y: number }) => { scrollY = y; landings += 1; } } },
            contentRef: { current: {} as View }, offsetRef: { current: 0 },
        };
        const render = (requestId: number) => <CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId="a:2"
            scrollToLineRequestId={requestId} externalScrollView={externalScrollView} />;
        const screen = await renderScreen(render(1), {
            createNodeMock: () => ({ measureLayout: (_relative: unknown, callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 240, 400, 22) }),
        });
        try {
            expect(scrollY).toBe(240);
            scrollY = 320;
            await screen.update(render(2));
            expect(scrollY).toBe(240);
            const completed = landings;
            scrollY = 320;
            await screen.update(render(2));
            expect(scrollY).toBe(320);
            expect(landings).toBe(completed);
        } finally { await screen.unmount(); }
    });
    it('reveals the next occurrence on the same line without repeating on equivalent decorations', async () => {
        let scrollY = 0;
        const externalScrollView = {
            scrollRef: { current: { scrollTo: ({ y }: { y: number }) => { scrollY = y; } } },
            contentRef: { current: {} as View },
            offsetRef: { current: 0 },
        };
        const render = (start: number) => <CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId="a:2"
            findRangesByLineId={new Map([['a:2', [{ start, end: start + 1, current: true }]]])} externalScrollView={externalScrollView} />;
        const screen = await renderScreen(render(0), {
            createNodeMock: () => ({ measureLayout: (_relative: unknown, callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 240, 400, 22) }),
        });
        await settleScroll();
        scrollY = 320;
        await screen.update(render(1));
        await settleScroll();
        expect(scrollY).toBe(240);
        scrollY = 320;
        await screen.update(render(1));
        await settleScroll();
        expect(scrollY).toBe(320);
    });

    it('jumps through the enclosing native ScrollView and preserves later manual scrolling on refresh', async () => {
        let scrollY = 0;
        const externalScrollView = {
            scrollRef: { current: { scrollTo: ({ y }: { y: number }) => { scrollY = y; } } },
            // Native measurement boundary supplied by createNodeMock.
            contentRef: { current: {} as View },
            offsetRef: { current: 0 },
        };
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId="a:2" externalScrollView={externalScrollView} />, {
            createNodeMock: () => ({ measureLayout: (_relative: unknown, callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 240, 400, 22) }),
        });
        await settleScroll();
        expect(scrollY).toBe(240);
        expect(externalScrollView.offsetRef.current).toBe(240);
        scrollY = 320;
        externalScrollView.offsetRef.current = scrollY;
        await screen.update(<CodeLinesViewCore lines={[...lines]} virtualized={false} scrollToLineId="a:2" externalScrollView={externalScrollView} />);
        await settleScroll();
        expect(scrollY).toBe(320);
    });

    it('measures an inline native target for its outer scroll owner and does not repeat after a refresh', async () => {
        const onScrollToLine = vi.fn();
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId="a:2" onScrollToLine={onScrollToLine} />, {
            createNodeMock: () => ({ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 240, 400, 22) }),
        });
        await settleScroll();
        expect(onScrollToLine).toHaveBeenCalledWith(240);
        onScrollToLine.mockClear();
        await screen.update(<CodeLinesViewCore lines={[...lines]} virtualized={false} scrollToLineId="a:2" onScrollToLine={onScrollToLine} />);
        await settleScroll();
        expect(onScrollToLine).not.toHaveBeenCalled();
    });

    it('uses different DOM targets for identical line IDs in separate viewers', async () => {
        const getElementById = vi.fn((_id: string) => ({ scrollIntoView: vi.fn() }));
        vi.stubGlobal('document', { getElementById });
        try {
            const screen = await renderScreen(<>
                <CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId="a:2" />
                <CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId="a:2" />
            </>);
            await settleScroll();
            const nativeIDs = screen.tree.findAll((node) => typeof node.type === 'string' && typeof node.props.nativeID === 'string').map((node) => node.props.nativeID);
            expect(new Set(nativeIDs).size).toBe(nativeIDs.length);
            // The selection-paint style element is looked up by id too; only the scroll targets are under test.
            const targetIds = new Set(getElementById.mock.calls.map(([id]) => id).filter((id) => id.endsWith('-a:2')));
            expect(targetIds.size).toBe(2);
            for (const nativeID of targetIds) {
                expect(screen.findByProps({ nativeID })).toBeTruthy();
            }

        } finally {
            vi.unstubAllGlobals();
        }
    });
});
