import * as React from 'react';
import { StyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const { Item } = await import('@/components/ui/lists/Item');
const { InboxSection } = await import('./InboxSection');

/** Inbox rows are domain components around `Item`, as the work-item and approval rows are. */
function InboxRow(props: Readonly<{ testID: string; selected: boolean }>) {
    return <Item testID={props.testID} title="Review the plan" selected={props.selected} onPress={() => {}} />;
}

function rowBackground(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): unknown {
    const host = screen.findHostByTestId(testID);
    const style = typeof host?.props.style === 'function' ? host.props.style({ pressed: false }) : host?.props.style;
    return (StyleSheet.flatten(style) as { backgroundColor?: unknown } | undefined)?.backgroundColor;
}

describe('InboxSection', () => {
    it('marks the row whose item is open beside the list, even when it is the only row of its group', async () => {
        const screen = await renderScreen(
            <InboxSection testID="group" title="Other sessions" surface="page">
                <InboxRow testID="open-row" selected />
            </InboxSection>,
        );
        const selected = rowBackground(screen, 'open-row');
        expect(selected).toBeTruthy();
        expect(selected).not.toBe('transparent');
    });

    it('lays a phone page section flat on the page, with no sheet around its rows (DESIGN: browse flat)', async () => {
        const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
        const render = async (surface: 'page' | 'pageFlat') => {
            const screen = await renderScreen(
                <InboxSection testID="group" title="Today" surface={surface}>
                    <InboxRow testID="row" selected={false} />
                </InboxSection>,
            );
            const group = screen.tree.findAllByType(ItemGroup)[0];
            const sheet = group?.props.surface ?? 'sheet';
            await screen.unmount();
            return sheet;
        };
        expect(await render('pageFlat')).toBe('none');
        expect(await render('page')).toBe('sheet');
    });
});
