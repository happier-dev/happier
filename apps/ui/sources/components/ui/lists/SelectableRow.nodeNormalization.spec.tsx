import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
  Platform: { OS: 'web', select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) =>
      typeof factory === 'function'
        ? factory({
          colors: {
            text: '#fff',
            textSecondary: '#aaa',
            textDestructive: '#f44',
            surfacePressed: '#111',
            surfacePressedOverlay: '#222',
            surfaceSelected: '#333',
            surfaceHigh: '#444',
            surfaceHighest: '#555',
            divider: '#666',
            accent: { blue: '#08f' },
          },
          dark: false,
        })
        : factory,
  },
  useUnistyles: () => ({
    theme: {
      colors: {
        text: '#fff',
        textSecondary: '#aaa',
        textDestructive: '#f44',
        surfacePressed: '#111',
        surfacePressedOverlay: '#222',
        surfaceSelected: '#333',
        surfaceHigh: '#444',
        surfaceHighest: '#555',
        divider: '#666',
        accent: { blue: '#08f' },
      },
      dark: false,
    },
  }),
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

describe('SelectableRow node normalization', () => {
  it('wraps primitive left and right content before placing it inside view slots', async () => {
    const { SelectableRow } = await import('./SelectableRow');

    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <SelectableRow
          title="Row"
          left={<>{'.'}</>}
          right={<>{'.'}</>}
        />,
      );
    });

    const json = (tree! as any).toJSON();
    const seen: { dotCount: number; badDotCount: number; badParents: Array<string | null> } = {
      dotCount: 0,
      badDotCount: 0,
      badParents: [],
    };

    const walk = (node: any, parentType: string | null) => {
      if (node == null) return;
      if (typeof node === 'string') {
        if (node === '.') {
          seen.dotCount += 1;
          if (parentType !== 'Text') {
            seen.badDotCount += 1;
            seen.badParents.push(parentType);
          }
        }
        return;
      }
      const nextParent = typeof node.type === 'string' ? node.type : null;
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) walk(child, nextParent);
    };

    walk(json, null);

    expect(seen.dotCount).toBeGreaterThan(0);
    expect({ badDotCount: seen.badDotCount, badParents: seen.badParents }).toEqual({
      badDotCount: 0,
      badParents: [],
    });
  });
});
