import * as React from 'react';
import { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { Item } = await import('./Item');

function rowBackground(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): unknown {
    const host = screen.findHostByTestId(testID);
    return (StyleSheet.flatten(host?.props.style) as { backgroundColor?: unknown } | undefined)?.backgroundColor;
}

describe('Item selection without an action', () => {
    it.each(['ContextMenu', 'Shift+F10', 'pointer'] as const)('keeps passive row actions reachable through %s without making the row a button', async (entry) => {
        function ContextualRow() {
            const [open, setOpen] = React.useState(false);
            return <>
                <Item testID="context-row" title="Member" rightElement={React.createElement('View')} rightElementOutsidePressable
                    onContextMenu={() => setOpen(true)}
                    onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) setOpen(true); }} />
                {open ? React.createElement('View', { testID: 'row-actions-open' }) : null}
            </>;
        }
        const screen = await renderScreen(<ContextualRow />);
        const row = screen.findHostByTestId('context-row');
        expect(row?.type).toBe('View');
        expect(row?.props.tabIndex).toBe(0);
        act(() => {
            if (entry === 'pointer') row?.props.onContextMenu?.({});
            else row?.props.onKeyDown?.({ key: entry === 'Shift+F10' ? 'F10' : entry, shiftKey: entry === 'Shift+F10' });
        });
        expect(screen.findHostByTestId('row-actions-open')).toBeTruthy();
    });
    it('keeps the selected mark on a row that cannot be pressed right now (a read-only or unavailable choice)', async () => {
        const screen = await renderScreen(
            <>
                <Item testID="chosen" title="Admins create Teams" selected disabled showChevron={false} />
                <Item testID="other" title="Anyone can create Teams" selected={false} disabled showChevron={false} />
            </>,
        );
        const chosen = rowBackground(screen, 'chosen');
        expect(chosen).toBeTruthy();
        expect(chosen).not.toBe('transparent');
        expect(rowBackground(screen, 'other') ?? 'transparent').toBe('transparent');
    });
});
