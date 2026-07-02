import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Pressable as RNPressable } from 'react-native';
import { renderScreen } from '@/dev/testkit';
import { installSourceControlChangesCommonModuleMocks } from './sourceControlChangesTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installSourceControlChangesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: 'Pressable',
            View: 'View',
            Platform: {
                OS: 'web',
            },
        });
    },
});

function flattenStyle(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, entry) => Object.assign(acc, flattenStyle(entry)), {} as Record<string, any>);
    }
    if (typeof style === 'object') {
        return style as Record<string, any>;
    }
    return {};
}

function createScmChangeRowTheme() {
    return {
        colors: {
            surface: {
                base: '#fff',
                inset: '#f8f8f8',
            },
            border: {
                default: '#ddd',
            },
            text: {
                primary: '#111',
                secondary: '#666',
                link: '#09f',
            },
            state: {
                success: { foreground: '#0a0' },
                danger: { foreground: '#a00' },
                neutral: { foreground: '#b60' },
            },
        },
    } as const;
}

describe('ScmChangeRow', () => {
  it('renders change stats and calls onPress', async () => {
    const onPress = vi.fn();
    const { ScmChangeRow } = await import('./ScmChangeRow');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ScmChangeRow
          theme={createScmChangeRowTheme()}
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
        />)).tree;

    const textContent = tree.findAllByType('Text' as any).map((node) => {
      const value = node.props.children;
      if (Array.isArray(value)) return value.join('');
      return String(value);
    });
    expect(textContent.join(' ')).toContain('+3');
    expect(textContent.join(' ')).toContain('-1');

    const clickable = tree.findAllByType('View' as any).find((node) => node.props.accessibilityLabel === 'files.changeRow.viewDiffA11y')!;
    act(() => {
      clickable.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn(), shiftKey: false });
    });
    expect(onPress).toHaveBeenCalled();
  });

  it('renders untracked files as added (A) for consistency with file tree badges', async () => {
    const { ScmChangeRow } = await import('./ScmChangeRow');
    const theme = createScmChangeRowTheme();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ScmChangeRow
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
        />)).tree;

    const textContent = tree.findAllByType('Text' as any).map((node) => String(node.props.children));
    expect(textContent.join(' ')).toContain('A');
  });

  it('normalizes leading slashes in file names (prevents "/file" rendering in root paths)', async () => {
    const { ScmChangeRow } = await import('./ScmChangeRow');
    const theme = createScmChangeRowTheme();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ScmChangeRow
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
        />)).tree;

    const textContent = tree.findAllByType('Text' as any).map((node) => {
      const value = node.props.children;
      if (Array.isArray(value)) return value.join('');
      return String(value);
    });
    expect(textContent.join(' ')).toContain('README.md');
    expect(textContent.join(' ')).not.toContain('/README.md');
  });

  it('renders nested paths with the web start-ellipsis wrapper so filenames keep priority', async () => {
    const { ScmChangeRow } = await import('./ScmChangeRow');
    const theme = createScmChangeRowTheme();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ScmChangeRow
          theme={theme}
          file={{
            fileName: 'jsonlForwardReader.ts',
            filePath: 'apps/cli/src/api/session/external/filePaging',
            fullPath: 'apps/cli/src/api/session/external/filePaging/jsonlForwardReader.ts',
            status: 'modified',
            isIncluded: false,
            linesAdded: 0,
            linesRemoved: 0,
          } as any}
          onPress={() => {}}
        />)).tree;

    const labels = tree.findAllByType('Text' as any);
    const pathLabel = labels.find((node) => {
      return labels.some((candidate) => candidate.props.children === 'apps/cli/src/api/session/external/filePaging/' && candidate.parent === node);
    })!;
    const pathText = labels.find((node) => node.props.children === 'apps/cli/src/api/session/external/filePaging/')!;

    expect(pathLabel.props.ellipsizeMode).toBeUndefined();
    expect(flattenStyle(pathLabel.props.style)).toMatchObject({
      textAlign: 'right',
      writingDirection: 'rtl',
    });
    expect(flattenStyle(pathText.props.style)).toMatchObject({
      writingDirection: 'ltr',
      unicodeBidi: 'isolate',
    });
  });

  it('reserves the provided change stats column width', async () => {
    const { ScmChangeRow } = await import('./ScmChangeRow');
    const theme = createScmChangeRowTheme();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ScmChangeRow
          theme={theme}
          file={{
            fileName: 'requestId.test.ts',
            filePath: 'src/middleware',
            fullPath: 'src/middleware/requestId.test.ts',
            status: 'modified',
            isIncluded: false,
            linesAdded: 146,
            linesRemoved: 10,
          } as any}
          statsColumnWidth={72}
          onPress={() => {}}
        />)).tree;

    const statsColumn = tree.findByProps({ testID: 'scm-change-row-stats-column' });
    expect(flattenStyle(statsColumn.props.style)).toMatchObject({
      width: 72,
      justifyContent: 'flex-end',
    });
  });

  it('uses surface inset background when highlighted', async () => {
    const { ScmChangeRow } = await import('./ScmChangeRow');
    const theme = createScmChangeRowTheme();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ScmChangeRow
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
        />)).tree;

    const container = tree.findAllByType('View' as any)[0]!;
    const style = container.props.style;
    const backgroundColor = Array.isArray(style)
      ? (style.find((s) => s && typeof s === 'object' && 'backgroundColor' in s)?.backgroundColor ?? null)
      : style?.backgroundColor ?? null;
    expect(backgroundColor).toBe(theme.colors.surface.inset);
  });

  it('supports Enter (open) and Space (toggle selection) on web', async () => {
    const onPress = vi.fn();
    const onPressPinned = vi.fn();
    const onToggleSelection = vi.fn();
    const { ScmChangeRow } = await import('./ScmChangeRow');
    const theme = createScmChangeRowTheme();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ScmChangeRow
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
        />)).tree;

    const clickable = tree.findAllByType('View' as any).find((node) => node.props.accessibilityLabel === 'files.changeRow.viewDiffA11y')!;
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
