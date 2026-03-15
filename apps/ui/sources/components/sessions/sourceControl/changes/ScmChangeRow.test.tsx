import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Pressable as RNPressable } from 'react-native';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'web' },
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
  Typography: {
    default: () => ({}),
  },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

describe('ScmChangeRow', () => {
  it('renders change stats and calls onPress', async () => {
    const onPress = vi.fn();
    const { ScmChangeRow } = await import('./ScmChangeRow');

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ScmChangeRow
          theme={{
            colors: {
              surface: '#fff',
              surfaceHigh: '#f8f8f8',
              divider: '#ddd',
              text: '#111',
              textSecondary: '#666',
              success: '#0a0',
              danger: '#a00',
              warning: '#b60',
              info: '#09f',
            },
          } as any}
          file={{
            fileName: 'a.ts',
            filePath: 'src',
            fullPath: 'src/a.ts',
            status: 'modified',
            isIncluded: false,
            linesAdded: 3,
            linesRemoved: 1,
          } as any}
          leadingElement={<RNPressable testID="leading-action" />}
          trailingElement={<RNPressable testID="trailing-action" />}
          onPress={onPress}
          density="compact"
        />
      );
    });

    const textContent = tree.root.findAllByType('Text' as any).map((node) => {
      const value = node.props.children;
      if (Array.isArray(value)) return value.join('');
      return String(value);
    });
    expect(textContent.join(' ')).toContain('+3');
    expect(textContent.join(' ')).toContain('-1');

    const clickable = tree.root.findAllByType('View' as any).find((node) => node.props.accessibilityLabel === 'files.changeRow.viewDiffA11y')!;
    act(() => {
      clickable.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn(), shiftKey: false });
    });
    expect(onPress).toHaveBeenCalled();
  });

  it('renders untracked files as added (A) for consistency with file tree badges', async () => {
    const { ScmChangeRow } = await import('./ScmChangeRow');
    const theme = {
      colors: {
        surface: '#fff',
        surfaceHigh: '#f8f8f8',
        divider: '#ddd',
        text: '#111',
        textSecondary: '#666',
        success: '#0a0',
        danger: '#a00',
        warning: '#b60',
        info: '#09f',
      },
    } as any;

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ScmChangeRow
          theme={theme}
          file={{
            fileName: 'new.ts',
            filePath: 'src',
            fullPath: 'src/new.ts',
            status: 'untracked',
            isIncluded: false,
            linesAdded: 1,
            linesRemoved: 0,
          } as any}
          onPress={() => {}}
        />
      );
    });

    const textContent = tree.root.findAllByType('Text' as any).map((node) => String(node.props.children));
    expect(textContent.join(' ')).toContain('A');
  });

  it('normalizes leading slashes in file names (prevents "/file" rendering in root paths)', async () => {
    const { ScmChangeRow } = await import('./ScmChangeRow');
    const theme = {
      colors: {
        surface: '#fff',
        surfaceHigh: '#f8f8f8',
        divider: '#ddd',
        text: '#111',
        textSecondary: '#666',
        success: '#0a0',
        danger: '#a00',
        warning: '#b60',
        info: '#09f',
      },
    } as any;

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ScmChangeRow
          theme={theme}
          file={{
            fileName: '/README.md',
            filePath: '',
            fullPath: 'README.md',
            status: 'modified',
            isIncluded: false,
            linesAdded: 0,
            linesRemoved: 0,
          } as any}
          onPress={() => {}}
        />
      );
    });

    const textContent = tree.root.findAllByType('Text' as any).map((node) => {
      const value = node.props.children;
      if (Array.isArray(value)) return value.join('');
      return String(value);
    });
    expect(textContent.join(' ')).toContain('README.md');
    expect(textContent.join(' ')).not.toContain('/README.md');
  });

  it('uses surfaceHigh background when highlighted', async () => {
    const { ScmChangeRow } = await import('./ScmChangeRow');
    const theme = {
      colors: {
        surface: '#fff',
        surfaceHigh: '#f8f8f8',
        divider: '#ddd',
        text: '#111',
        textSecondary: '#666',
        success: '#0a0',
        danger: '#a00',
        warning: '#b60',
        info: '#09f',
      },
    } as any;

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ScmChangeRow
          theme={theme}
          file={{
            fileName: 'a.ts',
            filePath: 'src',
            fullPath: 'src/a.ts',
            status: 'modified',
            isIncluded: false,
            linesAdded: 0,
            linesRemoved: 0,
          } as any}
          highlighted
          onPress={() => {}}
        />
      );
    });

    const container = tree.root.findAllByType('View' as any)[0]!;
    const style = container.props.style;
    const backgroundColor = Array.isArray(style)
      ? (style.find((s) => s && typeof s === 'object' && 'backgroundColor' in s)?.backgroundColor ?? null)
      : style?.backgroundColor ?? null;
    expect(backgroundColor).toBe(theme.colors.surfaceHigh);
  });

  it('supports Enter (open) and Space (toggle selection) on web', async () => {
    const onPress = vi.fn();
    const onPressPinned = vi.fn();
    const onToggleSelection = vi.fn();
    const { ScmChangeRow } = await import('./ScmChangeRow');
    const theme = {
      colors: {
        surface: '#fff',
        surfaceHigh: '#f8f8f8',
        divider: '#ddd',
        text: '#111',
        textSecondary: '#666',
        success: '#0a0',
        danger: '#a00',
        warning: '#b60',
        info: '#09f',
      },
    } as any;

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <ScmChangeRow
          theme={theme}
          file={{
            fileName: 'a.ts',
            filePath: 'src',
            fullPath: 'src/a.ts',
            status: 'modified',
            isIncluded: false,
            linesAdded: 0,
            linesRemoved: 0,
          } as any}
          onPress={onPress}
          onPressPinned={onPressPinned}
          onToggleSelection={onToggleSelection}
        />
      );
    });

    const clickable = tree.root.findAllByType('View' as any).find((node) => node.props.accessibilityLabel === 'files.changeRow.viewDiffA11y')!;
    act(() => {
      clickable.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onPress).toHaveBeenCalledTimes(1);

    act(() => {
      clickable.props.onKeyDown({ key: 'Enter', shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onPressPinned).toHaveBeenCalledTimes(1);

    act(() => {
      clickable.props.onKeyDown({ key: ' ', preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onToggleSelection).toHaveBeenCalledTimes(1);
  });
});
