import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { TreeDropMeasurableRef } from '@/components/ui/treeDragDrop';
import { SessionListHeaderFrame } from './SessionListHeaderFrame';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('session list row measurement lifetime', () => {
    it('keeps a recycled same-sized view registered under its new item without another layout event', async () => {
        const measured = new Map<string, TreeDropMeasurableRef>();
        const node: TreeDropMeasurableRef = {
            getBoundingClientRectFn: () => ({ x: 0, y: 40, width: 300, height: 40 }),
        };
        const register = (rowId: string, ref: TreeDropMeasurableRef | null) => {
            if (ref) measured.set(rowId, ref);
        };
        const unregister = (rowId: string) => { measured.delete(rowId); };
        const frame = (rowId: string) => (
            <SessionListHeaderFrame
                treeRowId={rowId}
                onRegisterTreeRowBounds={register}
                onUnregisterTreeRowBounds={unregister}
            >
                {null}
            </SessionListHeaderFrame>
        );
        const screen = await renderScreen(frame('row-a'), { createNodeMock: () => node });
        // A first layout occurs on mount. Reusing this host view at the same
        // dimensions does not produce another ResizeObserver/onLayout event.
        await act(async () => { screen.findByType('View').props.onLayout(); });
        expect([...measured.keys()]).toEqual(['row-a']);
        await screen.update(frame('row-b'));
        expect(measured.get('row-b')).toBe(node);
        expect(measured.has('row-a')).toBe(false);
        await screen.unmount();
        expect(measured.size).toBe(0);
    });
});
