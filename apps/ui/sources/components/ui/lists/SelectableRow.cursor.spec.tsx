import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            Pressable: 'Pressable',
            Text: 'Text',
            View: 'View',
        });
    },
});

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

describe('SelectableRow (web cursor)', () => {
  it('uses a not-allowed cursor when disabled', async () => {
    const { SelectableRow } = await import('./SelectableRow');

    const screen = await renderScreen(
        <SelectableRow testID="selectable-row-cursor" title="Row" disabled onPress={() => {}} />,
    );
    const styleSource = screen.findAll((node) => (
        node.props?.testID === 'selectable-row-cursor' && typeof node.props?.style === 'function'
    ))[0];
    const styleFn = styleSource?.props.style;
    expect(typeof styleFn).toBe('function');

    const resolved = styleFn({ pressed: false });
    const styles = Array.isArray(resolved) ? resolved : [resolved];
    expect(styles.some((s: any) => s && typeof s === 'object' && s.cursor === 'not-allowed')).toBe(true);
  });
});
