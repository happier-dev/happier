import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

// Load the real sheet during collection, as Settings renderer tests do, outside interaction deadlines.
const { ShortcutsSheet } = await import('./ShortcutsSheet');

describe('ShortcutsSheet (the ? sheet, lab KB1)', () => {
    it('lists bound commands by group with the keys of the host it shows', async () => {
        const render = (host: 'desktop' | 'browser') => renderScreen(<ShortcutsSheet onClose={vi.fn()} platform="macos" host={host}
            singleKeyShortcutsEnabled={true} disabledCommandIds={['panes.side.toggle']} overrides={{}} />);
        const keysOf = (screen: Awaited<ReturnType<typeof render>>) => screen.findByTestId('shortcuts-sheet-row-shell.column.toggle')
            ?.findAll(node => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.includes('+'))
            .map(node => node.props.accessibilityLabel as string)[0];
        const browser = await render('browser');
        expect(browser.findByTestId('shortcuts-sheet-group-panes')).not.toBeNull();
        // A command with no binding here is not a shortcut, so the sheet leaves it out.
        expect(browser.findByTestId('shortcuts-sheet-row-panes.side.toggle')).toBeNull();
        expect(keysOf(browser)).toBe('Option+B');
        expect(keysOf(await render('desktop'))).toBe('Cmd+B');
    });
});
