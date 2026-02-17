import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
  const React = require('react');
  return {
    Platform: { OS: 'web' },
    Text: (props: any) => React.createElement('Text', props, props.children),
    View: (props: any) => React.createElement('View', props, props.children),
  };
});

vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (fn: any) => fn({}) },
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/lists/SelectableRow', () => ({
  SelectableRow: (props: any) => {
    const React = require('react');
    return React.createElement('SelectableRow', props);
  },
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => {
    const React = require('react');
    return React.createElement('Item', props);
  },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
  ItemGroupRowPositionBoundary: (props: any) => {
    const React = require('react');
    return React.createElement('ItemGroupRowPositionBoundary', props, props.children);
  },
}));

describe('SelectableMenuResults', () => {
  it('does not invoke onPressItem for disabled items (rowKind=item)', async () => {
    const { SelectableMenuResults } = await import('./SelectableMenuResults');

    const onPressItem = vi.fn();
    const categories = [
      {
        id: 'general',
        title: 'General',
        items: [
          { id: 'enabled', title: 'Enabled', disabled: false, left: null, right: null },
          { id: 'disabled', title: 'Disabled', disabled: true, left: null, right: null },
        ],
      },
    ] as any;

    let tree: ReturnType<typeof renderer.create> | undefined;
    act(() => {
      tree = renderer.create(
        React.createElement(SelectableMenuResults, {
          categories,
          selectedIndex: 0,
          onSelectionChange: () => {},
          onPressItem,
          rowVariant: 'slim',
          emptyLabel: 'Empty',
          showCategoryTitles: false,
          rowKind: 'item',
        }),
      );
    });

    const items = tree!.root.findAllByType('Item' as any);
    expect(items.length).toBe(2);
    expect(items[0]?.props?.disabled).toBe(false);
    expect(items[1]?.props?.disabled).toBe(true);

    act(() => {
      items[1]?.props?.onPress?.();
    });
    expect(onPressItem).not.toHaveBeenCalled();

    act(() => {
      items[0]?.props?.onPress?.();
    });
    expect(onPressItem).toHaveBeenCalledTimes(1);
    expect(onPressItem.mock.calls[0]?.[0]?.id).toBe('enabled');
  });

  it('does not invoke onPressItem or onSelectionChange for disabled selectable rows', async () => {
    const { SelectableMenuResults } = await import('./SelectableMenuResults');

    const onPressItem = vi.fn();
    const onSelectionChange = vi.fn();
    const categories = [
      {
        id: 'general',
        title: 'General',
        items: [
          { id: 'disabled', title: 'Disabled', disabled: true, left: null, right: null },
          { id: 'enabled', title: 'Enabled', disabled: false, left: null, right: null },
        ],
      },
    ] as any;

    let tree: ReturnType<typeof renderer.create> | undefined;
    act(() => {
      tree = renderer.create(
        React.createElement(SelectableMenuResults, {
          categories,
          selectedIndex: 0,
          onSelectionChange,
          onPressItem,
          rowVariant: 'slim',
          emptyLabel: 'Empty',
          showCategoryTitles: false,
          rowKind: 'selectableRow',
        }),
      );
    });

    const rows = tree!.root.findAllByType('SelectableRow' as any);
    expect(rows.length).toBe(2);
    expect(rows[0]?.props?.disabled).toBe(true);
    expect(rows[1]?.props?.disabled).toBe(false);

    act(() => {
      rows[0]?.props?.onHover?.();
      rows[0]?.props?.onPress?.();
    });
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onPressItem).not.toHaveBeenCalled();

    act(() => {
      rows[1]?.props?.onHover?.();
      rows[1]?.props?.onPress?.();
    });
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onPressItem).toHaveBeenCalledTimes(1);
    expect(onPressItem.mock.calls[0]?.[0]?.id).toBe('enabled');
  });
});

