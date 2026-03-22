import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
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
                                }
    );
});

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

describe('SelectableRow (web cursor)', () => {
  it('uses a not-allowed cursor when disabled', async () => {
    const { SelectableRow } = await import('./SelectableRow');

    let tree: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SelectableRow title="Row" disabled onPress={() => {}} />)).tree;

    const pressable = (tree! as any).root.findByType('Pressable' as any);
    const styleFn = pressable.props.style;
    expect(typeof styleFn).toBe('function');

    const resolved = styleFn({ pressed: false });
    const styles = Array.isArray(resolved) ? resolved : [resolved];
    expect(styles.some((s: any) => s && typeof s === 'object' && s.cursor === 'not-allowed')).toBe(true);
  });
});
