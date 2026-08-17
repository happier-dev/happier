import { useState } from 'react';
import type { Disposable } from '@happier-dev/plugin-sdk';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it } from 'vitest';

import {
  useHappierUiAccessibility,
  useHappierUiInsets,
  useHappierUiLocalization,
  useHappierUiTheme,
} from '../environment/context.js';
import { useLivePluginResource } from '../hostApi/index.js';
import { mountThroughReactNativeWeb, mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider, usePluginTranslation, useSurfaceContext } from './PluginUiProvider.js';
import { Text } from './Text.js';

describe('PluginUiProvider', () => {
  it('publishes the host projection, never a package-local default', async () => {
    const context = createSurfaceContext({ locale: 'de', contrast: 'high', textScale: 1.25 });
    let observed: SurfaceContext | undefined;

    function Probe() {
      observed = useSurfaceContext();
      return null;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={createHostApiStub(context)}>
        <Probe />
      </PluginUiProvider>,
    );

    expect(observed?.locale).toBe('de');
    expect(observed?.contrast).toBe('high');
    expect(observed?.textScale).toBe(1.25);
    mount.unmount();
  });

  it('renders nothing rather than fabricating theme facts before the host answers', () => {
    let resolveContext: ((context: SurfaceContext) => void) | undefined;
    const hostApi = createHostApiStub(createSurfaceContext(), {
      context: () => new Promise<SurfaceContext>((resolve) => { resolveContext = resolve; }),
    });

    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={hostApi}>
        <Text value="Ready" />
      </PluginUiProvider>,
    );

    expect(mount.container.innerHTML).toBe('');
    expect(resolveContext).toBeTypeOf('function');
    mount.unmount();
  });

  /**
   * §3.10.1 forbids one volatile context carrying theme + insets + accessibility:
   * a safe-area change would rerender every shared component in the tree. This
   * fails against the obvious wrong implementation (a single `useMemo` over the
   * whole environment object).
   */
  it('keeps localization and its resolver stable across unrelated inset and accessibility pushes', async () => {
    const initial = createSurfaceContext();
    let publish: ((context: SurfaceContext) => void) | undefined;
    const hostApi = createHostApiStub(initial, {
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        publish = listener;
        return { dispose() {} };
      },
    });

    const themeIdentities: unknown[] = [];
    const localizationIdentities: unknown[] = [];
    const translationResolvers: unknown[] = [];
    const accessibilityIdentities: unknown[] = [];
    const insetsIdentities: unknown[] = [];

    function Probe() {
      themeIdentities.push(useHappierUiTheme());
      const localization = useHappierUiLocalization();
      localizationIdentities.push(localization);
      translationResolvers.push(localization.translate);
      accessibilityIdentities.push(useHappierUiAccessibility());
      insetsIdentities.push(useHappierUiInsets());
      return null;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={hostApi}>
        <Probe />
      </PluginUiProvider>,
    );

    expect(publish).toBeTypeOf('function');
    const { act } = await import('react');
    await act(async () => {
      publish?.({ ...initial, safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 } });
    });

    expect(insetsIdentities.at(-1)).not.toBe(insetsIdentities[0]);
    expect(accessibilityIdentities.at(-1)).toBe(accessibilityIdentities[0]);
    expect(localizationIdentities.at(-1)).toBe(localizationIdentities[0]);
    expect(translationResolvers.at(-1)).toBe(translationResolvers[0]);
    expect(themeIdentities.at(-1)).toBe(themeIdentities[0]);

    await act(async () => {
      publish?.({ ...initial, contrast: 'high' });
    });

    expect(accessibilityIdentities.at(-1)).not.toBe(accessibilityIdentities[0]);
    expect(localizationIdentities.at(-1)).toBe(localizationIdentities[0]);
    expect(translationResolvers.at(-1)).toBe(translationResolvers[0]);
    mount.unmount();
  });

  /**
   * The host wrapper ALWAYS supplies `context` so the first paint carries real
   * theme facts (§3.9). Every other reactivity test in this file omits it, so
   * none of them exercises the documented production path: with `context`
   * supplied, a provider that reads the prop instead of the observed snapshot
   * silently drops every `watchContext` push, and a surface keeps rendering the
   * theme, locale and accessibility facts the host held at mount.
   *
   * The prop is the INITIAL snapshot: a newer one from the host is adopted, and
   * neither adoption re-establishes the subscription.
   */
  it('lets watchContext drive after the host supplies the initial context snapshot', async () => {
    const initial = createSurfaceContext({ locale: 'en', textScale: 1 });
    let publish: ((context: SurfaceContext) => void) | undefined;
    let establishCount = 0;
    const hostApi = createHostApiStub(initial, {
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        establishCount += 1;
        publish = listener;
        return { dispose() {} };
      },
    });

    let observed: SurfaceContext | undefined;
    let textScale: number | undefined;
    let accent: string | undefined;
    let pushHostSnapshot: ((context: SurfaceContext) => void) | undefined;

    function Probe() {
      observed = useSurfaceContext();
      textScale = useHappierUiAccessibility().textScale;
      accent = useHappierUiTheme().colors.accent;
      return null;
    }

    function Host() {
      const [context, setContext] = useState<SurfaceContext>(initial);
      pushHostSnapshot = setContext;
      return (
        <PluginUiProvider hostApi={hostApi} context={context}>
          <Probe />
        </PluginUiProvider>
      );
    }

    const mount = await mountThroughReactNativeWebAsync(<Host />);
    expect(observed?.locale).toBe('en');
    expect(establishCount).toBe(1);

    const { act } = await import('react');
    await act(async () => {
      publish?.({
        ...initial,
        locale: 'de',
        textScale: 1.5,
        theme: { ...initial.theme, colors: { ...initial.theme.colors, accent: '#00ff00' } },
      });
    });

    expect(observed?.locale).toBe('de');
    expect(textScale).toBe(1.5);
    expect(accent).toBe('#00ff00');

    // A newer host snapshot delivered through the prop is still adopted, and
    // neither path re-establishes the subscription (§3.6: one establishment per
    // mounted surface).
    await act(async () => {
      pushHostSnapshot?.({ ...initial, locale: 'fr' });
    });
    expect(observed?.locale).toBe('fr');
    expect(establishCount).toBe(1);

    mount.unmount();
  });

  it('retires the context subscription exactly once on unmount', async () => {
    let disposeCount = 0;
    const hostApi = createHostApiStub(createSurfaceContext(), {
      watchContext: async (): Promise<Disposable> => ({
        dispose() { disposeCount += 1; },
      }),
    });

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={hostApi}>
        <Text value="Ready" />
      </PluginUiProvider>,
    );
    expect(disposeCount).toBe(0);

    mount.unmount();
    expect(disposeCount).toBe(1);
  });

  it('still establishes watchContext when an initial snapshot read fails', async () => {
    const recovered = createSurfaceContext({ locale: 'de' });
    let publish: ((context: SurfaceContext) => void) | undefined;
    let watchEstablished = false;
    let observed: SurfaceContext | undefined;
    const hostApi = createHostApiStub(recovered, {
      context: async () => {
        throw new Error('initial bridge snapshot unavailable');
      },
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        watchEstablished = true;
        publish = listener;
        return { dispose() {} };
      },
    });

    function Probe() {
      observed = useSurfaceContext();
      return null;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={hostApi}>
        <Probe />
      </PluginUiProvider>,
    );

    expect(watchEstablished).toBe(true);

    const { act } = await import('react');
    await act(async () => {
      publish?.(recovered);
    });
    expect(observed?.locale).toBe('de');
    mount.unmount();
  });

  it('opens a live Resource watch after watchContext recovers from a failed snapshot', async () => {
    const recovered = createSurfaceContext({ locale: 'de' });
    let publish: ((context: SurfaceContext) => void) | undefined;
    let resourceWatchCount = 0;
    let subscription: string | undefined;
    const hostApi = createHostApiStub(recovered, {
      version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: ['watchResource'] }),
      context: async () => {
        throw new Error('initial bridge snapshot unavailable');
      },
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        publish = listener;
        return { dispose() {} };
      },
      watchResource: async (): Promise<Disposable> => {
        resourceWatchCount += 1;
        return { dispose() {} };
      },
    });

    function Probe() {
      subscription = useLivePluginResource('live-status').resource.subscription;
      return null;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={hostApi}>
        <Probe />
      </PluginUiProvider>,
    );

    expect(resourceWatchCount).toBe(0);

    const { act } = await import('react');
    await act(async () => {
      publish?.(recovered);
      await Promise.resolve();
    });

    expect(resourceWatchCount).toBe(1);
    expect(subscription).toBe('live');
    mount.unmount();
  });

  it('does not let a delayed snapshot replace a newer watched context', async () => {
    const watched = createSurfaceContext({ locale: 'de' });
    const delayedSnapshot = createSurfaceContext({ locale: 'fr' });
    let resolveSnapshot: ((context: SurfaceContext) => void) | undefined;
    let publish: ((context: SurfaceContext) => void) | undefined;
    let watchEstablished = false;
    let observed: SurfaceContext | undefined;
    const hostApi = createHostApiStub(watched, {
      context: () => new Promise<SurfaceContext>((resolve) => { resolveSnapshot = resolve; }),
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        watchEstablished = true;
        publish = listener;
        return { dispose() {} };
      },
    });

    function Probe() {
      observed = useSurfaceContext();
      return null;
    }

    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={hostApi}>
        <Probe />
      </PluginUiProvider>,
    );

    await Promise.resolve();
    expect(watchEstablished).toBe(true);

    const { act } = await import('react');
    await act(async () => {
      publish?.(watched);
    });
    expect(observed?.locale).toBe('de');

    await act(async () => {
      resolveSnapshot?.(delayedSnapshot);
      await Promise.resolve();
    });
    expect(observed?.locale).toBe('de');
    mount.unmount();
  });

  it('resolves translations through one owner shared with the shared presentation layer', async () => {
    const context = createSurfaceContext({ translations: { 'acme.ready': 'Bereit' } });
    let translate: ((key: string, fallback?: string) => string) | undefined;

    function Probe() {
      translate = usePluginTranslation();
      return null;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={createHostApiStub(context)}>
        <Probe />
      </PluginUiProvider>,
    );

    expect(translate?.('acme.ready', 'Ready')).toBe('Bereit');
    expect(translate?.('acme.absent', 'Ready')).toBe('Ready');
    expect(translate?.('toString', 'Readable fallback')).toBe('Readable fallback');
    mount.unmount();
  });
});
