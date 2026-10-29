import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { SelectionToolbar } = await import('./SelectionToolbar');
afterEach(standardCleanup);

describe('selection toolbar with surface-owned actions', () => {
    it('keeps Copy after the surface actions, in their order', async () => {
        await withPopoverWebGlobals(async () => {
            const pressed: string[] = [];
            const screen = await renderScreen(<SelectionToolbar anchor={{ x: 10, y: 10, width: 80, height: 16 }}
                onCopy={() => pressed.push('copy')}
                actions={[
                    { id: 'quote', label: 'Quote', icon: 'quotes', primary: true, onPress: () => pressed.push('quote') },
                    { id: 'annotate', label: 'Annotate', icon: 'chat', onPress: () => pressed.push('annotate') },
                ]} />);
            const ids = screen.findAll((node) => typeof node.props.testID === 'string'
                && /^selection-toolbar-(quote|annotate|copy)$/u.test(node.props.testID) && typeof node.type === 'string')
                .map((node) => node.props.testID as string);
            expect([...new Set(ids)]).toEqual(['selection-toolbar-quote', 'selection-toolbar-annotate', 'selection-toolbar-copy']);
            await screen.pressByTestId('selection-toolbar-copy');
            await screen.pressByTestId('selection-toolbar-quote');
            expect(pressed).toEqual(['copy', 'quote']);
        });
    });
});
