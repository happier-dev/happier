import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathSelectorPropsRef: { current: Record<string, unknown> | null } = { current: null };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            View: 'View',
                                            Pressable: 'Pressable',
                                            Platform: {
                                                OS: 'web',
                                                select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default,
                                            },
                                        }
    );
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
      colors: {
        groupped: { background: '#fff' },
        divider: '#ddd',
        text: '#111',
        textSecondary: '#666',
      },
    },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

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

    await renderScreen(<McpWorkspaceRootPickerModal
          machineId="machine-1"
          machineHomeDir="/Users/test"
          selectedPath="/repo"
          favoriteDirectories={[]}
          onChangeFavoriteDirectories={() => {}}
          onSelectPath={() => {}}
          onClose={() => {}}
        />);

    expect(pathSelectorPropsRef.current).toMatchObject({
      machineBrowse: {
        enabled: true,
        machineId: 'machine-1',
      },
    });
  });
});
