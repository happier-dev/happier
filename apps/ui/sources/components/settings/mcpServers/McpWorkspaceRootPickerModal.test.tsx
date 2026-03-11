import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Platform: {
    OS: 'web',
    select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default,
  },
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: any) => factory({
      colors: {
        groupped: { background: '#fff' },
        divider: '#ddd',
        text: '#111',
        textSecondary: '#666',
      },
    }),
  },
  useUnistyles: () => ({
    theme: {
      colors: {
        groupped: { background: '#fff' },
        divider: '#ddd',
        text: '#111',
        textSecondary: '#666',
      },
    },
  }),
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/components/ui/text/Text', () => ({
  Text: 'Text',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
  ItemList: ({ children }: React.PropsWithChildren) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
  layout: { maxWidth: 960 },
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
  PathSelector: (props: Record<string, unknown>) => {
    pathSelectorPropsRef.current = props;
    return React.createElement('PathSelector', props);
  },
}));

describe('McpWorkspaceRootPickerModal', () => {
  it('passes machine browse config to the shared path selector when machine information is provided', async () => {
    const { McpWorkspaceRootPickerModal } = await import('./McpWorkspaceRootPickerModal');

    await act(async () => {
      renderer.create(
        <McpWorkspaceRootPickerModal
          machineId="machine-1"
          machineHomeDir="/Users/test"
          selectedPath="/repo"
          favoriteDirectories={[]}
          onChangeFavoriteDirectories={() => {}}
          onSelectPath={() => {}}
          onClose={() => {}}
        />,
      );
    });

    expect(pathSelectorPropsRef.current).toMatchObject({
      machineBrowse: {
        enabled: true,
        machineId: 'machine-1',
      },
    });
  });
});
