import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { CommandMenu } from '../CommandMenu';
import type { CommandMenuItem, CommandMenuProps } from '../commandMenuTypes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
// The recycler is the external boundary: it renders only a viewport's worth of rows.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return await createLegendListModuleMock({ renderItems: true, renderItemLimit: 20 });
});
vi.mock('../CommandMenuSurface', () => ({
    CommandMenuSurface: (props: { children: React.ReactNode }) => React.createElement(React.Fragment, null, props.children),
}));

const rowCount = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
    screen.root.findAll((node) => typeof node.props.testID === 'string' && /^command-menu:row:/.test(node.props.testID)
        && typeof node.type === 'string').length;

describe('a command menu with one long group', () => {
    it('mounts a viewport of rows rather than every row of a long Recent group', async () => {
        // A bare `@` leads with Recent: every Session of a busy Home (940 on the shared QA Account).
        const items: CommandMenuItem[] = [
            ...Array.from({ length: 400 }, (_, index) => ({ id: `recent-${index}`, label: `Session ${index}`, group: 'Recent' })),
            ...Array.from({ length: 8 }, (_, index) => ({ id: `file-${index}`, label: `file-${index}.ts`, group: 'Files' })),
        ];
        const props: CommandMenuProps = {
            open: true, anchor: { kind: 'rect', rect: { left: 0, top: 0, width: 1, height: 1 } }, query: '@', items, selectedIndex: 0,
            onMoveUp: () => {}, onMoveDown: () => {}, onSelect: () => {}, onRequestClose: () => {},
        };
        const screen = await renderScreen(<CommandMenu {...props} />);
        const mounted = rowCount(screen);
        expect(mounted).toBeGreaterThan(0);
        expect(mounted).toBeLessThanOrEqual(20);
    });
});
