import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from './panelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedTimingConfigs: any[] = [];

installPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            Animated: {
                Value: function Value(this: any, initial: number) {
                    this.__value = initial;
                    this.interpolate = (config: any) => ({ __interpolateConfig: config, __value: initial });
                },
                timing: (_value: any, config: any) => {
                    capturedTimingConfigs.push(config);
                    return { start: () => undefined };
                },
            },
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                dark: false,
                colors: {
                    borderNeutral: '#d0d7de',
                    surfaceElevated: '#ffffff',
                },
            },
        });
    },
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

describe('pane hosts (web native driver)', () => {
  beforeEach(() => {
    capturedTimingConfigs = [];
  });

  it('does not use native driver on web for overlay pane animations', async () => {
    const { MultiPaneHost } = await import('./MultiPaneHost');
    const { MultiPaneHostWithBottom } = await import('./MultiPaneHostWithBottom');

    await renderScreen(<>
          <MultiPaneHost
            main={<Main />}
            rightPane={<Right />}
            detailsPane={<Details />}
            layout={{ kind: 'overlayStack', right: 'overlay', details: 'overlay' }}
            rightDockWidthPx={360}
            detailsDockWidthPx={520}
            onCloseRight={() => {}}
            onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}}
            onCommitDetailsDockWidthPx={() => {}}
          />
          <MultiPaneHostWithBottom
            main={<Main />}
            rightPane={null}
            detailsPane={null}
            layout={{ kind: 'single', right: 'hidden', details: 'hidden' }}
            rightDockWidthPx={360}
            detailsDockWidthPx={520}
            onCloseRight={() => {}}
            onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}}
            onCommitDetailsDockWidthPx={() => {}}
            bottomPane={<Bottom />}
            bottomPresentation="overlay"
            bottomDockHeightPx={320}
            bottomDockMinHeightPx={200}
            bottomDockMaxHeightPx={600}
            onCloseBottom={() => {}}
            onCommitBottomDockHeightPx={() => {}}
          />
        </>);

    expect(capturedTimingConfigs.length).toBeGreaterThan(0);
    for (const config of capturedTimingConfigs) {
      expect(config.useNativeDriver).toBe(false);
    }
  });
});

function Main() {
  return React.createElement('Main');
}

function Right() {
  return React.createElement('Right');
}

function Details() {
  return React.createElement('Details');
}

function Bottom() {
  return React.createElement('Bottom');
}
