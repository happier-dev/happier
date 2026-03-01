import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('@expo/vector-icons', () => ({
  Octicons: 'Octicons',
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  TextInput: 'TextInput',
  ActivityIndicator: 'ActivityIndicator',
  Platform: {
    OS: 'ios',
    select: (spec: Record<string, unknown>) =>
      spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
  },
}));

vi.mock('react-native-unistyles', () => ({
  __esModule: true,
  useUnistyles: () => ({
    theme: {
      dark: false,
      colors: {
        text: '#000',
        textSecondary: '#666',
        surface: '#fff',
        surfaceHigh: '#f5f5f5',
        divider: '#ddd',
      },
    },
  }),
  StyleSheet: {
    create: (styles: any) =>
      typeof styles === 'function'
        ? styles({
            colors: {
              text: '#000',
              textSecondary: '#666',
              surface: '#fff',
              surfaceHigh: '#f5f5f5',
              divider: '#ddd',
            },
          })
        : styles,
  },
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}) },
}));

vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
  RepositoryTreeList: 'RepositoryTreeList',
}));

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
  SessionRepositoryTreeBrowserView: (props: any) => React.createElement('SessionRepositoryTreeBrowserView', props),
}));

vi.mock('@/sync/domains/state/storage', () => ({
  storage: { getState: () => ({ setSessionRepositoryTreeExpandedPaths: vi.fn() }) },
  useSessionRepositoryTreeExpandedPaths: () => [],
}));

describe('ProjectFileLinkPickerModal', () => {
  beforeEach(() => {});
  afterEach(() => {});

  it('wires file opens to onPickPath + onClose', async () => {
    const { ProjectFileLinkPickerModal } = await import('./ProjectFileLinkPickerModal');
    const onPickPath = vi.fn();
    const onClose = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ProjectFileLinkPickerModal sessionId="s1" onPickPath={onPickPath} onClose={onClose} />
      );
    });

    const browser = tree.root.findByType('SessionRepositoryTreeBrowserView' as any);
    await act(async () => {
      browser.props.onOpenFile('src/api.ts');
    });

    expect(onPickPath).toHaveBeenCalledWith('src/api.ts');
    expect(onClose).toHaveBeenCalled();
  });
});
