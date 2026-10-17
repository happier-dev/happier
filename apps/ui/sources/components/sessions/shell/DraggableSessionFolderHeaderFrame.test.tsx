import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithAppProviders } from '@/dev/testkit';

// The drag hook is externally owned for this contract test. The frame hands
// its gesture to the header via a render prop instead of wrapping the whole
// row: wrapping the row puts every header button inside the gesture view, and
// on WebKit the gesture layer's pointer capture suppresses click composition
// for those buttons (WKWebView incident 2026-10-18).
const useSessionInlineDragMock = vi.hoisted(() => vi.fn(() => ({
    gesture: { __testGesture: true },
    animatedStyle: {},
})));
vi.mock('./useSessionInlineDrag', () => ({
    useSessionInlineDrag: useSessionInlineDragMock,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { DraggableSessionFolderHeaderFrame } from './DraggableSessionFolderHeaderFrame';

describe('DraggableSessionFolderHeaderFrame drag-handle scoping', () => {
    it('passes the gesture to the header via render prop (no wrapping GestureDetector)', async () => {
        let receivedGesture: unknown = 'not-called';
        await renderWithAppProviders(
            <DraggableSessionFolderHeaderFrame
                folderId="folder-1"
                groupKey="group-1"
                treeRowId="row-1"
                dataIndex={0}
                overlayShared={{} as never}
                onDragStart={() => {}}
                onDropResult={() => {}}
                onDragCancel={() => {}}
                resolveDropResult={() => ({}) as never}
                onRegisterTreeRowBounds={() => {}}
                onUnregisterTreeRowBounds={() => {}}
            >
                {(dragHandleGesture) => {
                    receivedGesture = dragHandleGesture;
                    return <div>header</div>;
                }}
            </DraggableSessionFolderHeaderFrame>,
        );

        // The gesture reaches the header so it can be scoped to the drag handle;
        // the frame itself renders no GestureDetector around the row (the fix).
        expect(receivedGesture).toEqual({ __testGesture: true });
    });
});
