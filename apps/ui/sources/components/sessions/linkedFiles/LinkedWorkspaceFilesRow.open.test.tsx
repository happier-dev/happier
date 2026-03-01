import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

const routerPushSpy = vi.fn();
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('react-native', async () => {
  const actual = await import('@/dev/reactNativeStub');
  return {
    ...actual,
    useWindowDimensions: () => ({ width: 1400, height: 900 }),
  };
});

vi.mock('react-native-unistyles', () => ({
  __esModule: true,
  useUnistyles: () => ({
    theme: {
      dark: false,
      colors: {
        text: '#000',
        textSecondary: '#666',
        divider: '#ddd',
        surfaceHigh: '#f5f5f5',
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
              divider: '#ddd',
              surfaceHigh: '#f5f5f5',
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

vi.mock('@/utils/platform/responsive', () => ({
  useDeviceType: () => 'tablet',
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useLocalSetting: (key: string) => {
    if (key === 'uiMultiPanePanelsEnabled') return true;
    if (key === 'detailsPaneTabsBehavior') return 'preview';
    return undefined;
  },
}));

describe('LinkedWorkspaceFilesRow', () => {
  it('opens details tab when multi-pane is available', async () => {
    const { LinkedWorkspaceFilesRow } = await import('./LinkedWorkspaceFilesRow');

    let observedState: any = null;
    const Probe = () => {
      const { state } = useAppPaneContext();
      observedState = state;
      return null;
    };

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AppPaneProvider>
          <LinkedWorkspaceFilesRow sessionId="s1" paths={['src/api.ts']} />
          <Probe />
        </AppPaneProvider>
      );
    });

    const chip = tree.root.findByProps({ testID: 'linked-workspace-file:src/api.ts' });
    await act(async () => {
      chip.props.onPress();
    });

    expect(routerPushSpy).not.toHaveBeenCalled();
    const scope = observedState?.scopes?.['session:s1'];
    expect(scope?.details?.isOpen).toBe(true);
    expect(scope?.details?.tabs?.[0]?.key).toBe('file:src/api.ts');
    expect(scope?.details?.activeTabKey).toBe('file:src/api.ts');
  });
});
