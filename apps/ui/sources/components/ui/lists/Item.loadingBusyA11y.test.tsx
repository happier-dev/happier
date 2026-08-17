import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

afterEach(async () => {
    await standardCleanup();
});

describe('Item loading state accessibility', () => {
    it('announces a loading row as busy so a spinner is not a sighted-only signal', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item testID="busy-row" title="Working" loading onPress={() => {}} />,
        );
        expect(screen.findByTestId('busy-row')?.props.accessibilityState?.busy).toBe(true);
    });

    it('keeps a caller-supplied disclosure state while adding busy', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item
                testID="busy-row"
                title="Working"
                loading
                accessibilityState={{ expanded: true }}
                onPress={() => {}}
            />,
        );
        const state = screen.findByTestId('busy-row')?.props.accessibilityState;
        expect(state?.expanded).toBe(true);
        expect(state?.busy).toBe(true);
    });

    it('leaves an idle row unmarked rather than publishing busy: false everywhere', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item testID="idle-row" title="Ready" onPress={() => {}} />,
        );
        expect(screen.findByTestId('idle-row')?.props.accessibilityState?.busy).toBeUndefined();
    });
});
