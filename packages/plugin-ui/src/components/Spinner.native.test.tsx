import * as React from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativePlatform = vi.hoisted(() => ({ OS: 'ios' }));
/** `Animated.loop` hands the dots' clock to the native driver; start/stop is the observable boundary. */
const loops = vi.hoisted(() => [] as Array<{ started: number; stopped: number }>);

vi.mock('react-native', () => {
  class Value {
    constructor(readonly initial: number) {}
    setValue(_value: number) {}
    interpolate() {
      return this;
    }
  }
  return {
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      Value,
      View: 'AnimatedView',
      loop: () => {
        const record = { started: 0, stopped: 0 };
        loops.push(record);
        return { start: () => { record.started += 1; }, stop: () => { record.stopped += 1; } };
      },
      sequence: (steps: unknown[]) => steps,
      timing: (_value: unknown, config: unknown) => config,
    },
    Easing: { linear: (t: number) => t, ease: (t: number) => t, inOut: (easing: unknown) => easing,
      bezier: () => (t: number) => t },
    Platform: nativePlatform,
    Pressable: 'Pressable',
    Text: 'Text',
    ScrollView: 'ScrollView',
    I18nManager: { isRTL: false },
    View: 'View',
  };
});

import { PluginUiProvider } from './PluginUiProvider.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import { Spinner } from './Spinner.js';
import { Button, IconButton } from './Button.js';
import { HappierListItem } from '../presentation/collection/List.js';
import { Tabs } from './Tabs.js';
import { HappierStatusDot } from '../presentation/status/StatusDot.js';
import { HappierSpinner } from '../presentation/feedback/Spinner.js';
import { DEFAULT_HAPPIER_SPINNER_STYLE_ID, DOT_SPINNER_STYLES } from '../presentation/feedback/spinnerStyles.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { usePluginSurfaceActivity } from '../hostApi/context.js';
import { HappierUiEnvironmentProvider } from '../environment/context.js';
import { projectHappierUiEnvironment } from '../environment/projectEnvironment.js';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
  loops.length = 0;
});

const running = () => loops.filter((loop) => loop.started > loop.stopped).length;
const defaultDotCount = DOT_SPINNER_STYLES[DEFAULT_HAPPIER_SPINNER_STYLE_ID].dots.length;

function dotOpacities(): unknown[] {
  return renderer!.root
    .findAll((node) => node.type === 'AnimatedView' && node.props.testID === 'happier-spinner-dot')
    .map((dot) => (dot.props.style as { opacity: unknown }).opacity);
}

describe('native HappierSpinner presentation', () => {
  it('keeps the host-selected mark visible while inactive and reduced motion pauses its travelling light', async () => {
    const initial = createSurfaceContext({ platform: 'ios', reducedMotion: true });
    const context = { ...initial, theme: { ...initial.theme, spinner: { style: 'hWave', speed: 'fast', pause: 'long' } } };
    const hostApi = createHostApiStub(context);
    const renderSpinner = (presentationActive: boolean, reducedMotion = true) => (
      <PluginUiProviderInternal hostApi={hostApi} context={{ ...context, reducedMotion }} surfaceActivity={{ active: true }} presentationActive={presentationActive}>
        <Spinner testID="preferred-spinner" />
      </PluginUiProviderInternal>
    );
    await act(async () => { renderer = create(renderSpinner(false)); });
    expect(dotOpacities()).toEqual(Array(7).fill(0.85));
    expect(running()).toBe(0);

    await act(async () => { renderer!.update(renderSpinner(true)); });
    expect(dotOpacities()).toEqual(Array(7).fill(0.85));
    expect(running()).toBe(0);

    await act(async () => { renderer!.update(renderSpinner(true, false)); });
    expect(running()).toBe(1);

    await act(async () => { renderer!.update(renderSpinner(false, false)); });
    expect(dotOpacities()).toEqual(Array(7).fill(0.85));
    expect(running()).toBe(0);
  });
  it('pauses a declarative busy list row through the private environment projection without a Host API provider', async () => {
    const environment = projectHappierUiEnvironment(createSurfaceContext({ platform: 'ios' }));
    const renderRow = (presentationActive: boolean) => (
      <HappierUiEnvironmentProvider environment={environment} {...{ presentationActive }}>
        <HappierListItem title="Saving" busy onPress={() => undefined} />
      </HappierUiEnvironmentProvider>
    );
    await act(async () => { renderer = create(renderRow(true)); });
    expect(running()).toBe(1);
    await act(async () => { renderer!.update(renderRow(false)); });
    expect(dotOpacities()).toEqual(Array(defaultDotCount).fill(0.85));
    expect(running()).toBe(0);
    await act(async () => { renderer!.update(renderRow(true)); });
    expect(running()).toBe(1);
  });
  it('keeps shared status motion paused with the same private host presentation activity', async () => {
    const context = createSurfaceContext({ platform: 'ios', reducedMotion: false });
    const hostApi = createHostApiStub(context);
    const renderStatus = (presentationActive: boolean) => (
      <PluginUiProviderInternal hostApi={hostApi} context={context} surfaceActivity={{ active: true }} {...{ presentationActive }}>
        <HappierStatusDot color={context.theme.colors.text} isPulsing />
      </PluginUiProviderInternal>
    );
    await act(async () => { renderer = create(renderStatus(false)); });
    expect(running()).toBe(0);
    await act(async () => { renderer!.update(renderStatus(true)); });
    expect(running()).toBe(1);
    await act(async () => { renderer!.update(renderStatus(false)); });
    expect(running()).toBe(0);
  });
  it('pauses presentation in a hidden host without ending the public surface activity', async () => {
    const context = createSurfaceContext({ platform: 'ios', reducedMotion: false });
    const hostApi = createHostApiStub(context);
    let surfaceActive: boolean | undefined;
    function Busy() {
      surfaceActive = usePluginSurfaceActivity().active;
      return <Button title="Save" busy onPress={() => undefined} />;
    }
    const renderBusy = (presentationActive: boolean) => (
      <PluginUiProviderInternal
        hostApi={hostApi}
        context={context}
        surfaceActivity={{ active: true }}
        {...{ presentationActive }}
      >
        <Busy />
      </PluginUiProviderInternal>
    );
    await act(async () => { renderer = create(renderBusy(true)); });
    expect(running()).toBe(1);
    await act(async () => { renderer!.update(renderBusy(false)); });
    expect(dotOpacities()).toEqual(Array(defaultDotCount).fill(0.85));
    expect(running()).toBe(0);
    expect(surfaceActive).toBe(true);
    await act(async () => { renderer!.update(renderBusy(true)); });
    expect(running()).toBe(1);
  });
  it('pauses every busy control and list spinner with its retained surface, and resumes without replacing the host subscription', async () => {
    const context = createSurfaceContext({ platform: 'ios', reducedMotion: false });
    const watchContext = vi.fn(async () => ({ dispose() {} }));
    const hostApi = createHostApiStub(context, { watchContext });
    const renderBusy = (active: boolean) => (
      <PluginUiProviderInternal hostApi={hostApi} context={context} surfaceActivity={{ active }}>
        <Spinner />
        <Button title="Save" busy onPress={() => undefined} />
        <IconButton accessibilityLabel="Save" icon={null} busy onPress={() => undefined} />
        <HappierListItem title="Saving" busy onPress={() => undefined} />
      </PluginUiProviderInternal>
    );
    await act(async () => { renderer = create(renderBusy(false)); });
    expect(dotOpacities()).toEqual(Array(defaultDotCount * 4).fill(0.85));
    expect(running()).toBe(0);
    await act(async () => { renderer!.update(renderBusy(true)); });
    expect(running()).toBe(1);
    await act(async () => { renderer!.update(renderBusy(false)); });
    expect(running()).toBe(0);
    expect(watchContext).toHaveBeenCalledTimes(1);
  });

  it('releases busy-control motion in a retained inactive tab and resumes on return', async () => {
    const context = createSurfaceContext({ platform: 'ios', reducedMotion: false });
    const hostApi = createHostApiStub(context);
    const renderTabs = (value: string) => (
      <PluginUiProviderInternal hostApi={hostApi} context={context} surfaceActivity={{ active: true }}>
        <Tabs value={value} onValueChange={() => undefined} ariaLabel="Sections">
          <Tabs.Item value="busy" title="Busy" retention="retain">
            <Button title="Save" busy onPress={() => undefined} />
          </Tabs.Item>
          <Tabs.Item value="other" title="Other" />
        </Tabs>
      </PluginUiProviderInternal>
    );
    await act(async () => { renderer = create(renderTabs('busy')); });
    expect(running()).toBe(1);
    await act(async () => { renderer!.update(renderTabs('other')); });
    expect(dotOpacities()).toEqual(Array(defaultDotCount).fill(0.85));
    expect(running()).toBe(0);
    await act(async () => { renderer!.update(renderTabs('busy')); });
    expect(running()).toBe(1);
  });
  it('keeps an indeterminate spinner visible, breathing the still H, when the projected reduced-motion preference is on', async () => {
    const context = createSurfaceContext({ platform: 'ios', reducedMotion: true });

    await act(async () => {
      renderer = create(
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <HappierSpinner testID="reduced-motion-spinner" />
        </PluginUiProvider>,
      );
    });

    expect(renderer!.root.findAllByType('ActivityIndicator' as never)).toHaveLength(0);
    expect(dotOpacities()).toEqual(Array(defaultDotCount).fill(0.85));
  });

  it('holds public Spinner still, with no running clock, while its retained surface is inactive', async () => {
    const context = createSurfaceContext({ platform: 'ios', reducedMotion: false });
    const renderSpinner = (active: boolean) => (
      <PluginUiProviderInternal
        hostApi={createHostApiStub(context)}
        context={context}
        surfaceActivity={{ active }}
      >
        <Spinner testID="public-spinner" />
      </PluginUiProviderInternal>
    );

    await act(async () => {
      renderer = create(renderSpinner(false));
    });
    expect(dotOpacities()).toEqual(Array(defaultDotCount).fill(0.85));
    expect(running()).toBe(0);

    await act(async () => {
      renderer!.update(renderSpinner(true));
    });
    expect(running()).toBe(1);

    await act(async () => {
      renderer!.update(renderSpinner(false));
    });
    expect(running()).toBe(0);
  });
});
