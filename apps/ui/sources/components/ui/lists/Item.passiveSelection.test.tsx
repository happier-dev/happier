import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';
import { readSurfaceStyleProperty } from '@/components/ui/surfaces/surfaceStyle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { Item } = await import('./Item');

function rowBackground(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): unknown {
    const host = screen.findHostByTestId(testID);
    const style = typeof host?.props.style === 'function' ? host.props.style({ pressed: false }) : host?.props.style;
    return readSurfaceStyleProperty(style, 'backgroundColor');
}

describe('Item selection without an action', () => {
    it('keeps a caller-supplied selected row coat translucent inside its material plane', async () => {
        const authoredStyle = Object.defineProperty({}, 'backgroundColor', { value: '#112233', enumerable: false });
        const screen = await renderScreen(<HappierMaterialRoleProvider role="sidebar" resolveMaterialColor={() => 'rgba(235, 230, 225, 0.1)'}>
            <Item testID="material-row" title="Project" selected onPress={() => {}} pressableStyle={authoredStyle} />
        </HappierMaterialRoleProvider>);
        expect(rowBackground(screen, 'material-row')).toBe('rgba(235, 230, 225, 0.1)');
    });
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
