import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { PageAsideColumns } = await import('./PageAsideColumns');

afterEach(standardCleanup);

function StatefulControl(props: Readonly<{ id: string }>) {
    const [value, setValue] = React.useState(0);
    return <View testID={props.id} accessibilityValue={{ now: value }} onTouchEnd={() => setValue(value + 1)} />;
}

describe('PageAsideColumns continuity', () => {
    it('retains main and aside control state when the collection switches between split and compact layouts', async () => {
        const page = (compact: boolean) => <PageAsideColumns compact={compact} compactAside="first" aside={<StatefulControl id="aside" />}>
            <StatefulControl id="main" />
        </PageAsideColumns>;
        const screen = await renderScreen(page(false));
        await act(async () => {
            screen.findByTestId('main')!.props.onTouchEnd();
            screen.findByTestId('aside')!.props.onTouchEnd();
        });
        for (const compact of [true, false]) {
            await screen.update(page(compact));
            expect(screen.findByTestId('main')!.props.accessibilityValue.now).toBe(1);
            expect(screen.findByTestId('aside')!.props.accessibilityValue.now).toBe(1);
            expect(screen.findAllByType(StatefulControl).map(control => control.props.id)).toEqual(compact ? ['aside', 'main'] : ['main', 'aside']);
        }
        // Native layout reports the real pane width; the same controls survive a pane resize too.
        for (const width of [320, 1200]) {
            const frame = screen.findAllByType('View').find(node => typeof node.props.onLayout === 'function')!;
            await act(async () => { frame.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } } }); });
            expect(screen.findByTestId('main')!.props.accessibilityValue.now).toBe(1);
            expect(screen.findByTestId('aside')!.props.accessibilityValue.now).toBe(1);
        }
    });

    it('retains the main control when an asynchronous receipt arrives or leaves', async () => {
        const page = (hasAside: boolean) => <PageAsideColumns compact={false} aside={hasAside ? <StatefulControl id="aside" /> : null}>
            <StatefulControl id="main" />
        </PageAsideColumns>;
        const screen = await renderScreen(page(false));
        await act(async () => { screen.findByTestId('main')!.props.onTouchEnd(); });
        for (const hasAside of [true, false]) {
            await screen.update(page(hasAside));
            expect(screen.findByTestId('main')!.props.accessibilityValue.now).toBe(1);
        }
    });

    it('keeps the closing control, ending the page under the sections or after the aside, across the split', async () => {
        const page = (compact: boolean) => <PageAsideColumns compact={compact} aside={<StatefulControl id="aside" />}
            closing={<StatefulControl id="closing" />}>
            <StatefulControl id="main" />
        </PageAsideColumns>;
        const screen = await renderScreen(page(false));
        await act(async () => { screen.findByTestId('closing')!.props.onTouchEnd(); });
        for (const compact of [true, false]) {
            await screen.update(page(compact));
            expect(screen.findByTestId('closing')!.props.accessibilityValue.now).toBe(1);
            // It always ends the page: after the sections and the aside in reading order.
            expect(screen.findAllByType(StatefulControl).map(control => control.props.id)).toEqual(['main', 'aside', 'closing']);
        }
        for (const width of [320, 1200]) {
            const frame = screen.findAllByType('View').find(node => typeof node.props.onLayout === 'function')!;
            await act(async () => { frame.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } } }); });
            expect(screen.findByTestId('closing')!.props.accessibilityValue.now).toBe(1);
        }
    });

    it('withdraws an aside reserved for the split layout while retaining the main control', async () => {
        const page = (compact: boolean) => <PageAsideColumns compact={compact} compactAside="none" aside={<StatefulControl id="aside" />}>
            <StatefulControl id="main" />
        </PageAsideColumns>;
        const screen = await renderScreen(page(false));
        expect(screen.findByTestId('aside')).not.toBeNull();
        await act(async () => { screen.findByTestId('main')!.props.onTouchEnd(); });
        await screen.update(page(true));
        expect(screen.findByTestId('aside')).toBeNull();
        expect(screen.findByTestId('main')!.props.accessibilityValue.now).toBe(1);
    });
});
