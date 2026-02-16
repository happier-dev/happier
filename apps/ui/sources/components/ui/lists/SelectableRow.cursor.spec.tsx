import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  Platform: { OS: 'web', select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: { colors: { surfacePressed: '#eee', surfacePressedOverlay: '#eee', divider: '#ddd', text: '#111', textSecondary: '#666', textDestructive: '#c00' } } }),
  StyleSheet: { create: (fn: any) => fn({ colors: { surfacePressed: '#eee', surfacePressedOverlay: '#eee', divider: '#ddd', text: '#111', textSecondary: '#666', textDestructive: '#c00' } }, {}) },
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

describe('SelectableRow (web cursor)', () => {
  it('uses a not-allowed cursor when disabled', async () => {
    const { SelectableRow } = await import('./SelectableRow');

    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SelectableRow title="Row" disabled onPress={() => {}} />);
    });

    const pressable = (tree! as any).root.findByType('Pressable' as any);
    const styleFn = pressable.props.style;
    expect(typeof styleFn).toBe('function');

    const resolved = styleFn({ pressed: false });
    const styles = Array.isArray(resolved) ? resolved : [resolved];
    expect(styles.some((s: any) => s && typeof s === 'object' && s.cursor === 'not-allowed')).toBe(true);
  });
});
