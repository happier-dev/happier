import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
  const React = require('react');
  return {
    View: (props: any) => React.createElement('View', props, props.children),
    Text: (props: any) => React.createElement('Text', props, props.children),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
    useWindowDimensions: () => ({ width: 390, height: 700, scale: 2, fontScale: 2 }),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, bottom: 20, left: 0, right: 0 }),
}));

function findStyleValue(style: any, key: string) {
  const list = Array.isArray(style) ? style : [style];
  for (const entry of list) {
    if (entry && typeof entry === 'object' && key in entry) return (entry as any)[key];
  }
  return undefined;
}

vi.mock('react-native-unistyles', () => ({
  StyleSheet: { create: (styles: any) => styles },
  useUnistyles: () => ({
    theme: {
      colors: {
        surface: '#fff',
        surfaceHigh: '#f5f5f5',
        divider: '#eee',
        text: '#111',
        textSecondary: '#666',
        shadow: { color: '#000', opacity: 0.1 },
      },
    },
  }),
}));

vi.mock('@expo/vector-icons', () => {
  const React = require('react');
  return { Ionicons: (props: any) => React.createElement('Ionicons', props) };
});

vi.mock('@/components/ui/text/Text', () => {
  const React = require('react');
  return { Text: (props: any) => React.createElement('Text', props, props.children) };
});

describe('BugReportDiagnosticsPreviewModal', () => {
  it('sets an explicit height so the scroll body can measure on native', async () => {
    const { BugReportDiagnosticsPreviewModal } = await import('./BugReportDiagnosticsPreviewModal');

    const onClose = vi.fn();
    const artifacts = [
      {
        filename: 'app-context.json',
        sourceKind: 'ui-mobile',
        contentType: 'application/json',
        sizeBytes: 10,
        content: '{"hello":"world"}',
      },
    ];

    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<BugReportDiagnosticsPreviewModal artifacts={artifacts as any} onClose={onClose} />);
    });

    // window.height=700, insets top+bottom=40, extra padding=96 => 564
    const expected = 564;
    const rootView = tree!.root.findByType('View' as any);
    expect(findStyleValue(rootView.props.style, 'height')).toBe(expected);
    expect(findStyleValue(rootView.props.style, 'maxHeight')).toBe(expected);
  });

  it('drills into an artifact and shows its content', async () => {
    const { BugReportDiagnosticsPreviewModal } = await import('./BugReportDiagnosticsPreviewModal');

    const onClose = vi.fn();
    const artifacts = [
      {
        filename: 'app-context.json',
        sourceKind: 'ui-mobile',
        contentType: 'application/json',
        sizeBytes: 10,
        content: '{"hello":"world"}',
      },
    ];

    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
      tree = renderer.create(<BugReportDiagnosticsPreviewModal artifacts={artifacts as any} onClose={onClose} />);
    });

    const openButtons = tree!.root
      .findAllByProps({ accessibilityLabel: 'Open app-context.json' })
      .filter((node) => typeof node.props.onPress === 'function');
    expect(openButtons.length).toBeGreaterThan(0);

    act(() => {
      openButtons[0]!.props.onPress();
    });

    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Back' }).length).toBeGreaterThan(0);
    const textNodes = tree!.root.findAllByType('Text' as any);
    const combined = textNodes.map((node) => String(node.props.children ?? '')).join('\n');
    expect(combined).toContain('app-context.json');
    expect(combined).toContain('{"hello":"world"}');
  });
});
