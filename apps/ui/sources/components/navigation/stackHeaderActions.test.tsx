import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import {
    HeaderActionsScope,
    useClaimedStackHeaderActions,
    useLentHeaderMenuRows,
    useStackHeaderActionsClaimed,
    useStackHeaderActionsPublisher,
    type LentHeaderMenuRow,
} from './stackHeaderActions';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('lent stack header actions', () => {
    it('keeps published menu rows through claim, release and reclaim, until the publisher withdraws', async () => {
        const scopeKey = 'lent-menu-lifecycle';
        const onSelect = vi.fn();
        const rows: readonly LentHeaderMenuRow[] = [
            { id: 'close', title: 'Close', testID: 'close-tab', iconName: 'x', onSelect },
        ];
        const render = () => 'Pane actions';
        const publisher = await renderHook(({ published }: { published: boolean }) => {
            useStackHeaderActionsPublisher(scopeKey, published ? render : null, rows);
            return useStackHeaderActionsClaimed(scopeKey);
        }, { initialProps: { published: true } });
        const wrapper = ({ children }: React.PropsWithChildren) => (
            <HeaderActionsScope scopeKey={scopeKey}>{children}</HeaderActionsScope>
        );
        const reader = await renderHook(useLentHeaderMenuRows, { wrapper });
        const claimant = await renderHook(({ release }: { release: boolean }) =>
            useClaimedStackHeaderActions({ release, drawsMenuRows: true }),
        { initialProps: { release: true }, wrapper });
        try {
            expect(reader.getCurrent()).toBe(rows);
            await claimant.rerender({ release: false });
            expect(publisher.getCurrent()).toBe(true);
            expect(claimant.getCurrent()).toBe('Pane actions');
            expect(reader.getCurrent()).toBe(rows);
            await claimant.rerender({ release: true });
            expect(publisher.getCurrent()).toBe(false);
            expect(reader.getCurrent()).toBe(rows);
            await claimant.rerender({ release: false });
            expect(reader.getCurrent()).toBe(rows);
            reader.getCurrent()?.[0]?.onSelect();
            expect(onSelect).toHaveBeenCalledOnce();
            await publisher.rerender({ published: false });
            expect(reader.getCurrent()).toBeNull();
            expect(claimant.getCurrent()).toBeNull();
        } finally {
            await claimant.unmount();
            await reader.unmount();
            await publisher.unmount();
        }
    });
});
