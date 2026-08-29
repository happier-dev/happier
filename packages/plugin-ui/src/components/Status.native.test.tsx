import * as React from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const animation = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  loop: vi.fn(),
}));

vi.mock('react-native', () => {
  class Value {
    constructor(readonly initial: number) {}
  }
  animation.loop.mockImplementation(() => ({ start: animation.start, stop: animation.stop }));
  return {
    Animated: {
      Value,
      View: 'AnimatedView',
      loop: animation.loop,
      sequence: (items: unknown[]) => items,
      timing: (_value: unknown, config: unknown) => config,
    },
    I18nManager: { isRTL: false },
    Platform: {
      OS: 'ios',
      select: <T,>(options: Readonly<{ ios?: T; native?: T; default?: T }>) => (
        options.ios ?? options.native ?? options.default
      ),
    },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
  };
});

import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import { Status } from './Status.js';
import { Tabs } from './Tabs.js';
import { Text } from './Text.js';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.clearAllMocks();
});

describe('native executable Status retained-surface activity', () => {
  it('starts pulse work only while the host-owned retained surface is active', async () => {
    const context = createSurfaceContext({ platform: 'ios', reducedMotion: false });
    const renderStatus = (active: boolean) => (
      <PluginUiProviderInternal
        hostApi={createHostApiStub(context)}
        context={context}
        surfaceActivity={{ active }}
      >
        <Status tone="success" label="Connected" pulsing />
      </PluginUiProviderInternal>
    );

    await act(async () => {
      renderer = create(renderStatus(false));
    });
    expect(animation.loop).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.update(renderStatus(true));
    });
    expect(animation.loop).toHaveBeenCalledTimes(1);
    expect(animation.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.update(renderStatus(false));
    });
    expect(animation.stop).toHaveBeenCalledTimes(1);
  });

  it('stops a retained hidden Tabs panel pulse and restarts only when that panel is active again', async () => {
    const context = createSurfaceContext({ platform: 'ios', reducedMotion: false });
    const renderTabs = (selected: 'status' | 'other') => (
      <PluginUiProviderInternal
        hostApi={createHostApiStub(context)}
        context={context}
        surfaceActivity={{ active: true }}
      >
        <Tabs value={selected} onValueChange={() => {}} ariaLabel="Sections">
          <Tabs.Item value="status" title="Status" retention="retain">
            <Status tone="success" label="Connected" pulsing />
          </Tabs.Item>
          <Tabs.Item value="other" title="Other">
            <Text value="Other content" />
          </Tabs.Item>
        </Tabs>
      </PluginUiProviderInternal>
    );

    await act(async () => {
      renderer = create(renderTabs('status'));
    });
    expect(animation.loop).toHaveBeenCalledTimes(1);
    expect(animation.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.update(renderTabs('other'));
    });
    expect(animation.stop).toHaveBeenCalledTimes(1);
    expect(animation.loop).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.update(renderTabs('status'));
    });
    expect(animation.loop).toHaveBeenCalledTimes(2);
    expect(animation.start).toHaveBeenCalledTimes(2);
  });
});
