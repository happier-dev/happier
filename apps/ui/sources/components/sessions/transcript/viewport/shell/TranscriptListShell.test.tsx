import { readFileSync } from 'node:fs';

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

let capturedFlashListProps: any = null;
let assignedRef: any = null;

const SIDECHAIN_INITIAL_BOTTOM_PIN = readFileSync(new URL('./sidechainInitialBottomPin.ts', import.meta.url), 'utf8');
const SIDECHAIN_JUMP_TO_MESSAGE = readFileSync(new URL('./sidechainJumpToMessage.ts', import.meta.url), 'utf8');

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        capturedFlashListProps = props;
        const instance = {
            scrollToIndex: vi.fn(),
            scrollToOffset: vi.fn(),
            scrollToEnd: vi.fn(),
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        assignedRef = instance;
        return React.createElement('FlashList', props, props.ListHeaderComponent ?? null, props.ListFooterComponent ?? null);
    }),
    flashListRuntime: {
        Component: 'FlashList',
        usingFallback: false,
        reason: null,
    },
    LayoutCommitObserver: (props: { children?: React.ReactNode; onCommitLayoutEffect?: () => void }) => {
        React.useLayoutEffect(() => {
            props.onCommitLayoutEffect?.();
        });
        return React.createElement(React.Fragment, null, props.children);
    },
}));

describe('TranscriptListShell', () => {
    beforeEach(() => {
        capturedFlashListProps = null;
        assignedRef = null;
    });

    it('forwards renderer-owned props from the caller supplied shell frame', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const { resolveMainTranscriptListShellFrame } = await import('./transcriptListShellCapabilities');
        const listRef = { current: null as any };
        const keyExtractor = vi.fn((item: { id: string }) => item.id);
        const renderItem = vi.fn(({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id }));
        const onLayout = vi.fn();

        const screen = await renderScreen(
            <TranscriptListShell
                ref={listRef}
                data={[{ id: 'row-1' }]}
                extraData={5}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                frame={resolveMainTranscriptListShellFrame({
                    configuredDrawDistance: 900,
                    nativeID: 'ChatList.s1.r1',
                    platformOS: 'ios',
                })}
                onLayout={onLayout}
                header={React.createElement('HeaderSlot')}
                footer={React.createElement('FooterSlot')}
                olderLoadOverlay={React.createElement('OlderOverlay')}
                catchUpOverlay={React.createElement('CatchUpOverlay')}
                transcriptLegendListSpikeSurface="flashList"
            />,
        );

        expect(listRef.current).toBe(assignedRef);
        expect(capturedFlashListProps).toMatchObject({
            data: [{ id: 'row-1' }],
            drawDistance: 900,
            extraData: 5,
            inverted: true,
            keyboardDismissMode: 'none',
            keyboardShouldPersistTaps: 'handled',
            nativeID: 'ChatList.s1.r1',
            onLayout,
            scrollEventThrottle: 16,
            testID: 'transcript-chat-list',
        });
        expect(capturedFlashListProps.keyExtractor).toBe(keyExtractor);
        expect(capturedFlashListProps.renderItem).toBe(renderItem);
        expect(screen.findByType('HeaderSlot' as any)).toBeTruthy();
        expect(screen.findByType('FooterSlot' as any)).toBeTruthy();
        expect(screen.findByType('OlderOverlay' as any)).toBeTruthy();
        expect(screen.findByType('CatchUpOverlay' as any)).toBeTruthy();
    });

    it('passes optional main FlashList callbacks and platform interactions through by identity', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const { resolveMainTranscriptListShellFrame } = await import('./transcriptListShellCapabilities');
        const overrideProps = { scrollViewProps: { testOnly: true } };
        const platformInteractionProps = {
            onMouseDown: vi.fn(),
            onPointerDown: vi.fn(),
            onTouchCancel: vi.fn(),
            onTouchEnd: vi.fn(),
            onTouchMove: vi.fn(),
            onTouchStart: vi.fn(),
            onWheel: vi.fn(),
        };
        const onLoad = vi.fn();
        const onViewableItemsChanged = vi.fn();
        const viewabilityConfig = { itemVisiblePercentThreshold: 1 };
        const onScrollBeginDrag = vi.fn();
        const onScrollEndDrag = vi.fn();
        const onMomentumScrollBegin = vi.fn();
        const onMomentumScrollEnd = vi.fn();
        const onScrollToIndexFailed = vi.fn();

        await renderScreen(
            <TranscriptListShell
                data={[{ id: 'row-1' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({ platformOS: 'ios' })}
                overrideProps={overrideProps}
                platformInteractionProps={platformInteractionProps}
                onLoad={onLoad}
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={viewabilityConfig}
                onScrollBeginDrag={onScrollBeginDrag}
                onScrollEndDrag={onScrollEndDrag}
                onMomentumScrollBegin={onMomentumScrollBegin}
                onMomentumScrollEnd={onMomentumScrollEnd}
                onScrollToIndexFailed={onScrollToIndexFailed}
                transcriptLegendListSpikeSurface="flashList"
            />,
        );

        expect(capturedFlashListProps.overrideProps).toBe(overrideProps);
        expect(capturedFlashListProps.onLoad).toBe(onLoad);
        expect(capturedFlashListProps.onViewableItemsChanged).toBe(onViewableItemsChanged);
        expect(capturedFlashListProps.viewabilityConfig).toBe(viewabilityConfig);
        expect(capturedFlashListProps.onScrollBeginDrag).toBe(onScrollBeginDrag);
        expect(capturedFlashListProps.onScrollEndDrag).toBe(onScrollEndDrag);
        expect(capturedFlashListProps.onMomentumScrollBegin).toBe(onMomentumScrollBegin);
        expect(capturedFlashListProps.onMomentumScrollEnd).toBe(onMomentumScrollEnd);
        expect(capturedFlashListProps.onScrollToIndexFailed).toBe(onScrollToIndexFailed);
        expect(capturedFlashListProps.onMouseDown).toBe(platformInteractionProps.onMouseDown);
        expect(capturedFlashListProps.onPointerDown).toBe(platformInteractionProps.onPointerDown);
        expect(capturedFlashListProps.onTouchCancel).toBe(platformInteractionProps.onTouchCancel);
        expect(capturedFlashListProps.onTouchEnd).toBe(platformInteractionProps.onTouchEnd);
        expect(capturedFlashListProps.onTouchMove).toBe(platformInteractionProps.onTouchMove);
        expect(capturedFlashListProps.onTouchStart).toBe(platformInteractionProps.onTouchStart);
        expect(capturedFlashListProps.onWheel).toBe(platformInteractionProps.onWheel);
    });

    it('resolves the Legend renderer for web main by default while preserving the FlashList escape hatch', async () => {
        const { resolveTranscriptListRenderer } = await import('./renderer/resolveTranscriptListRenderer');
        const { resolveMainTranscriptListShellFrame, resolveReadOnlyTranscriptListShellFrame } = await import('./transcriptListShellCapabilities');

        const webMain = resolveMainTranscriptListShellFrame({ platformOS: 'web' });
        const nativeMain = resolveMainTranscriptListShellFrame({ platformOS: 'ios' });
        const readOnly = resolveReadOnlyTranscriptListShellFrame({
            accessKind: 'public',
            bottomNoticeVisible: false,
            platformOS: 'web',
        });

        expect(resolveTranscriptListRenderer({
            frame: webMain,
            platformOS: 'web',
            transcriptLegendListSpikeSurface: 'off',
        }).kind).toBe('legendList');
        expect(resolveTranscriptListRenderer({
            frame: nativeMain,
            platformOS: 'ios',
            transcriptLegendListSpikeSurface: 'off',
        }).kind).toBe('legendList');
        expect(resolveTranscriptListRenderer({
            frame: readOnly,
            platformOS: 'web',
            transcriptLegendListSpikeSurface: 'readOnly',
        }).kind).toBe('legendList');
        expect(resolveTranscriptListRenderer({
            frame: webMain,
            platformOS: 'web',
            transcriptLegendListSpikeSurface: 'flashList',
        }).kind).toBe('flashList');
    });

    it('owns the layout commit observer wrapper while preserving the host callback', async () => {
        const { TranscriptListShell } = await import('./TranscriptListShell');
        const { resolveMainTranscriptListShellFrame } = await import('./transcriptListShellCapabilities');
        const onCommitLayoutEffect = vi.fn();

        await renderScreen(
            <TranscriptListShell
                data={[{ id: 'row-1' }]}
                keyExtractor={(item: { id: string }) => item.id}
                renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
                frame={resolveMainTranscriptListShellFrame({ platformOS: 'ios' })}
                onCommitLayoutEffect={onCommitLayoutEffect}
                transcriptLegendListSpikeSurface="flashList"
            />,
        );

        expect(onCommitLayoutEffect).toHaveBeenCalled();
    });

    it('keeps sidechain shell helpers out of raw list command execution', () => {
        for (const source of [SIDECHAIN_INITIAL_BOTTOM_PIN, SIDECHAIN_JUMP_TO_MESSAGE]) {
            expect(source).not.toMatch(/\.scrollTo(?:Index|Offset)\s*\(/);
            expect(source).not.toMatch(/scrollTo(?:Index|Offset)\?:/);
        }
    });
});
