import * as React from 'react';
import renderer from 'react-test-renderer';
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
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
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
        });
    },
});

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

describe('SelectableRow node normalization', () => {
  function flattenStyle(style: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(style)) return style && typeof style === 'object' ? [style as Record<string, unknown>] : [];
    return style.flatMap(flattenStyle);
  }

  it('wraps primitive left and right content before placing it inside view slots', async () => {
    const { SelectableRow } = await import('./SelectableRow');

    let tree: renderer.ReactTestRenderer;
    tree = (await renderScreen(<SelectableRow
          title="Row"
          left={<>{'.'}</>}
          right={<>{'.'}</>}
        />)).tree;

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

  it('title-aligns left and right accessories when a subtitle is present', async () => {
    const { SelectableRow } = await import('./SelectableRow');

    const screen = await renderScreen(<SelectableRow
          title="Row"
          subtitle="Additional context"
          left={<>{'.'}</>}
          right={<>{'.'}</>}
        />);

    const alignedAccessorySlots = screen.findAllByType('View').filter((node: any) => (
        flattenStyle(node.props?.style).some((style) => (
            style.alignSelf === 'flex-start' && style.marginTop === 2
        ))
    ));

    expect(alignedAccessorySlots).toHaveLength(2);
  });
});
