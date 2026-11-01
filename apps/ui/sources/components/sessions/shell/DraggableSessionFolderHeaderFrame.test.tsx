import React from 'react';
import { Platform, Pressable } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGestureByKind, renderScreen } from '@/dev/testkit';
import type { TreeDropOverlaySharedValues } from '@/components/ui/treeDragDrop';
import { DraggableSessionFolderHeaderFrame } from './DraggableSessionFolderHeaderFrame';
import type { UseSessionInlineDragResolvedDrop } from './useSessionInlineDrag';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});
// Worklets cross the native UI/JS runtime boundary; execute scheduled JS here.
vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

async function renderHeader(dragKey = 'folder:folder-1') {
    const overlayShared: TreeDropOverlaySharedValues = {
        overlayVisible: { value: 0 }, overlayKind: { value: 0 },
        overlayTop: { value: 0 }, overlayHeight: { value: 0 },
        overlayLeft: { value: 0 }, overlayRight: { value: 0 }, overlayDepth: { value: 0 },
    };
    const resolved: UseSessionInlineDragResolvedDrop = {
        result: { instruction: { kind: 'idle' }, visual: { kind: 'none' } },
        geometry: { kind: 'none' },
        destinationKey: null,
    };
    const onDragStart = vi.fn();
    const onDropResult = vi.fn();
    const onDragCancel = vi.fn();
    const onPress = vi.fn();
    const screen = await renderScreen(
        <DraggableSessionFolderHeaderFrame
            dragKey={dragKey}
            folderId="folder-1" groupKey="group-1" treeRowId="row-1" dataIndex={2}
            overlayShared={overlayShared} onDragStart={onDragStart}
            resolveDropResult={() => resolved} onDropResult={onDropResult} onDragCancel={onDragCancel}
            onRegisterTreeRowBounds={() => {}} onUnregisterTreeRowBounds={() => {}}
        >
            {(gesture) => <>
                <Pressable testID="header-button" onPress={onPress} />
                {gesture ? <GestureDetector gesture={gesture}><Pressable testID="grip" /></GestureDetector> : null}
            </>}
        </DraggableSessionFolderHeaderFrame>,
    );
    return { screen, onDragStart, onDropResult, onDragCancel, onPress, resolved, overlayShared };
}

describe('DraggableSessionFolderHeaderFrame', () => {
    beforeEach(() => { Platform.OS = 'web'; });

    it('keeps web buttons outside the detector while its grip starts, drops and cancels the real drag', async () => {
        const { screen, onDragStart, onDropResult, onDragCancel, onPress, resolved } = await renderHeader();
        const detector = screen.root.findByType('GestureDetector');
        expect(detector.findAllByProps({ testID: 'header-button' })).toHaveLength(0);
        await act(async () => { screen.findByTestId('header-button')?.props.onPress(); });
        expect(onPress).toHaveBeenCalledOnce();
        expect(onDragStart).not.toHaveBeenCalled();
        const pan = findGestureByKind(detector.props.gesture, 'pan');
        expect(pan).toBeTruthy();
        expect(pan?.__config.activateAfterLongPress).toBeUndefined();
        await act(async () => {
            pan?.__handlers.onStart?.({});
            pan?.__handlers.onUpdate?.({ translationY: 20, absoluteX: 10, absoluteY: 40 });
            pan?.__handlers.onEnd?.({ absoluteX: 10, absoluteY: 40 });
            pan?.__handlers.onFinalize?.({});
        });
        expect(onDragStart).toHaveBeenCalledWith('folder:folder-1');
        expect(onDropResult).toHaveBeenCalledWith({ sessionKey: 'folder:folder-1', groupKey: 'group-1', dataIndex: 2, result: resolved.result });
        expect(onDragCancel).not.toHaveBeenCalled();
        await act(async () => {
            pan?.__handlers.onStart?.({});
            pan?.__handlers.onUpdate?.({ translationY: 20, absoluteX: 10, absoluteY: 40 });
            pan?.__handlers.onTouchesCancelled?.({});
            pan?.__handlers.onFinalize?.({});
        });
        expect(onDragCancel).toHaveBeenCalledExactlyOnceWith({ sessionKey: 'folder:folder-1', groupKey: 'group-1', dataIndex: 2 });
        expect(onDropResult).toHaveBeenCalledOnce();
    });

    it.each(['ios', 'android'] as const)('retains whole-header hold-to-drag on %s', async (platform) => {
        Platform.OS = platform;
        const { screen, onDragStart } = await renderHeader();
        const detector = screen.root.findByType('GestureDetector');
        expect(detector.findAllByProps({ testID: 'header-button' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('grip')).toBeNull();
        const pan = findGestureByKind(detector.props.gesture, 'pan');
        expect(pan?.__config.activateAfterLongPress).toBe(350);
        await act(async () => {
            pan?.__handlers.onStart?.({});
            pan?.__handlers.onUpdate?.({ translationY: 3, absoluteX: 10, absoluteY: 40 });
        });
        expect(onDragStart).not.toHaveBeenCalled();
        await act(async () => { pan?.__handlers.onUpdate?.({ translationY: 20, absoluteX: 10, absoluteY: 40 }); });
        expect(onDragStart).toHaveBeenCalledWith('folder:folder-1');
    });

    it('leaves a header without a drag identity interactive', async () => {
        const { screen, onPress } = await renderHeader('');
        expect(screen.findAllByType('GestureDetector')).toHaveLength(0);
        await act(async () => { screen.findByTestId('header-button')?.props.onPress(); });
        expect(onPress).toHaveBeenCalledOnce();
    });
});
