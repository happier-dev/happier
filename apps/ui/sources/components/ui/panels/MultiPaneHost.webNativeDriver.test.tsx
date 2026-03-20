import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedTimingConfigs: any[] = [];

vi.mock('react-native', async () => {
  const ReactMod = await import('react');
  const stub = await import('../../../dev/reactNativeStub');
  return {
    ...stub,
    Platform: { ...(stub as any).Platform, OS: 'web' },
    Animated: {
      ...(stub as any).Animated,
      Value: function Value(this: any, initial: number) {
        this.__value = initial;
        this.interpolate = (config: any) => ({ __interpolateConfig: config, __value: initial });
      },
      timing: (_value: any, config: any) => {
        capturedTimingConfigs.push(config);
        return { start: () => undefined };
      },
    },
    View: (props: any) => ReactMod.createElement('View', props, props.children),
    Pressable: (props: any) => ReactMod.createElement('Pressable', props, props.children),
  };
});

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({
    theme: {
      dark: false,
      colors: {
        borderNeutral: '#d0d7de',
        surfaceElevated: '#ffffff',
      },
    },
  }),
}));

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

    await act(async () => {
      renderer.create(
        <>
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
        </>,
      );
    });

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
