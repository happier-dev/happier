import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  PluginUiHostApi,
  PluginUiThemeV1,
  SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';

import {
  HappierUiEnvironmentProvider,
  useHappierUiAccessibility,
  useHappierUiLocalization,
  useHappierUiTheme,
} from '../environment/context.js';
import type {
  HappierUiAccessibility,
  HappierUiEnvironment,
  HappierUiLocalization,
} from '../environment/types.js';
import { PluginUiDataProviderInternal } from '../data/context.js';
import type { PluginUiDataClient } from '../data/types.js';
import { PluginHostApiProviderInternal } from '../hostApi/context.js';
import type { PluginUiResourceAccountLifetime } from '../hostApi/resourceStore.js';
import type { ComposerRefV1 } from '../composer/types.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';

/**
 * The plugin adapter for the shared presentation environment (§3.9, §3.10.1).
 *
 * The RN/RNW host wrapper installs this around a plugin's exported surface, so
 * ordinary `renderSurface` code needs no bootstrap ceremony. Authors may install
 * it explicitly in isolated tests.
 *
 * It is an ADAPTER, not a second owner: every fact it publishes comes from the
 * host's own `SurfaceContext` projection. It does not resolve theme tokens,
 * decide accessibility policy or maintain state the host already owns.
 */
const PluginSurfaceContextContext = createContext<SurfaceContext | null>(null);

export type PluginUiProviderProps = Readonly<{
  hostApi: PluginUiHostApi;
  /**
   * The INITIAL context snapshot the host already holds.
   *
   * The host wrapper passes it so the first paint carries real theme and
   * accessibility facts instead of an empty frame. When omitted (an author's
   * isolated test) the provider reads it from `hostApi.context()` and renders
   * nothing until it arrives — a surface must never render with fabricated
   * theme values.
   *
   * It is a SEED, never the live authority: once the surface is mounted,
   * `watchContext` drives (§3.2). A provider that kept reading this prop would
   * pin the surface to the theme, locale and accessibility facts the host held
   * at mount and silently drop every later push — and because the host wrapper
   * always supplies it, that would be the production path, not an edge case.
   * A newer snapshot arriving through the prop is still adopted; neither path
   * re-establishes the subscription.
   */
  context?: SurfaceContext;
  children?: ReactNode;
}>;

/** Private bridge props used only by the bundled surface entry. */
export type PluginUiProviderInternalProps = PluginUiProviderProps & Readonly<{
  accountLifetime?: PluginUiResourceAccountLifetime | null;
  resourceStoreGeneration?: unknown;
  mountedPluginId?: string;
  composerRef?: ComposerRefV1 | null;
  presentationHost?: PluginUiPresentationHost;
  dataClient?: PluginUiDataClient;
}>;

/**
 * A SurfaceContext translation bundle is immutable for its snapshot. Reusing
 * its resolver keeps the localization capability stable when a host publishes
 * an unrelated fact such as safe-area insets, without memoizing the full
 * environment or making localization a second owner.
 */
const translationResolvers = new WeakMap<Readonly<Record<string, string>>, PluginTranslate>();

function resolveTranslationResolver(
  translations: Readonly<Record<string, string>>,
): PluginTranslate {
  const existing = translationResolvers.get(translations);
  if (existing) return existing;
  const resolver: PluginTranslate = (key: string, fallback?: string) => {
    const translation = Object.prototype.hasOwnProperty.call(translations, key)
      ? translations[key]
      : undefined;
    return typeof translation === 'string' ? translation : (fallback ?? '');
  };
  translationResolvers.set(translations, resolver);
  return resolver;
}

function toLocalization(context: SurfaceContext): HappierUiLocalization {
  return {
    locale: context.locale,
    direction: context.direction,
    translate: resolveTranslationResolver(context.translations),
  };
}

function toAccessibility(context: SurfaceContext): HappierUiAccessibility {
  return {
    textScale: context.textScale,
    reducedMotion: context.reducedMotion,
    screenReaderEnabled: context.screenReaderEnabled,
    contrast: context.contrast,
  };
}

function toEnvironment(context: SurfaceContext): HappierUiEnvironment {
  return {
    theme: context.theme,
    localization: toLocalization(context),
    accessibility: toAccessibility(context),
    platform: { platform: context.platform, colorScheme: context.colorScheme },
    insets: { safeArea: context.safeAreaInsets },
  };
}

/**
 * The observed surface facts, keyed by the surface they belong to.
 *
 * `hostApi` is the bound surface controller (§3.1), so its identity IS the
 * mounted surface's identity: a new controller means the previous surface's
 * facts are no longer this surface's facts, and the seed is taken again.
 * `seed` records which `context` prop the state was last synchronized from, so
 * a re-render carrying the SAME snapshot cannot overwrite a newer observed one.
 */
type ObservedSurfaceState = Readonly<{
  hostApi: PluginUiHostApi;
  seed: SurfaceContext | undefined;
  context: SurfaceContext | null;
}>;

export function PluginUiProvider(props: PluginUiProviderProps) {
  return <PluginUiProviderInternal {...props} />;
}

/** Not exported through a package entry point; see `surfaceEntry.tsx`. */
export function PluginUiProviderInternal({
  hostApi,
  accountLifetime,
  resourceStoreGeneration,
  mountedPluginId,
  composerRef,
  presentationHost,
  dataClient,
  context,
  children,
}: PluginUiProviderInternalProps) {
  const [observed, setObserved] = useState<ObservedSurfaceState>(() => ({
    hostApi,
    seed: context,
    context: context ?? null,
  }));

  // Resynchronize during render rather than in an effect: a surface must never
  // paint another surface's theme, not even for one frame.
  if (observed.hostApi !== hostApi || observed.seed !== context) {
    const surfaceChanged = observed.hostApi !== hostApi;
    setObserved({
      hostApi,
      seed: context,
      context: context ?? (surfaceChanged ? null : observed.context),
    });
  }

  // The establishment effect runs on the surface identity alone, so a context
  // snapshot never tears down and re-establishes a live subscription. It reads
  // the current observed snapshot through a ref, which React has already
  // updated by the time effects run. Snapshot and watch paths establish
  // independently: a transient snapshot failure cannot strand the surface,
  // while a watch result wins over a delayed snapshot.
  const observedContextRef = useRef<SurfaceContext | null>(observed.context);
  observedContextRef.current = observed.context;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let subscription: { dispose: () => void } | undefined;
    let disposed = false;
    let watchedContextDelivered = false;
    const publish = (next: SurfaceContext, source: 'snapshot' | 'watch') => {
      if (!active) return;
      if (source === 'snapshot' && watchedContextDelivered) return;
      if (source === 'watch') watchedContextDelivered = true;
      setObserved((previous) => (
        previous.hostApi === hostApi ? { ...previous, context: next } : previous
      ));
    };

    void (async () => {
      try {
        const established = await hostApi.watchContext(
          (next) => publish(next, 'watch'),
          { signal: controller.signal },
        );
        // A disposal that lands before the host acknowledges must still retire
        // the subscription exactly once (§3.6).
        if (disposed) established.dispose();
        else subscription = established;
      } catch {
        // A host that cannot watch context is not an error state for the
        // surface: the snapshot it already has stays authoritative. A host that
        // can supply neither renders nothing, which is the honest outcome.
      }
    })();

    if (!observedContextRef.current) {
      void (async () => {
        try {
          const snapshot = await hostApi.context({ signal: controller.signal });
          publish(snapshot, 'snapshot');
        } catch {
          // A failed snapshot must not prevent the independent watch
          // establishment above from delivering the first usable context.
        }
      })();
    }

    return () => {
      active = false;
      disposed = true;
      controller.abort();
      subscription?.dispose();
    };
  }, [hostApi]);

  const effectiveContext = observed.context;
  const environment = useMemo(
    () => (effectiveContext ? toEnvironment(effectiveContext) : null),
    [effectiveContext],
  );

  if (!effectiveContext || !environment) return null;

  return (
    <PluginHostApiProviderInternal
      hostApi={hostApi}
      {...(accountLifetime === undefined ? {} : { accountLifetime })}
      {...(resourceStoreGeneration === undefined ? {} : { resourceStoreGeneration })}
      {...(mountedPluginId === undefined ? {} : { mountedPluginId })}
      {...(composerRef === undefined ? {} : { composerRef })}
    >
      <PluginSurfaceContextContext.Provider value={effectiveContext}>
        <HappierUiEnvironmentProvider environment={environment}>
          <PluginUiDataProviderInternal {...(dataClient ? { client: dataClient } : {})}>
            {presentationHost
              ? <PluginUiPresentationHostProviderInternal host={presentationHost}>{children}</PluginUiPresentationHostProviderInternal>
              : children}
          </PluginUiDataProviderInternal>
        </HappierUiEnvironmentProvider>
      </PluginSurfaceContextContext.Provider>
    </PluginHostApiProviderInternal>
  );
}

/**
 * Private host↔artifact recognition only. The RN/RNW host uses this marker on
 * the returned provider element to install private Resource/presentation
 * bindings after arbitrary `renderSurface` code has returned. It is not a
 * `RenderContext` capability and grants no authority by itself.
 */
Object.defineProperty(
  PluginUiProviderInternal,
  Symbol.for('happier.pluginUi.privateSurfaceEntryProvider.v1'),
  {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  },
);

/**
 * The exact thing this surface is mounted on, plus its reactive locale,
 * direction, theme and accessibility facts (§3.2).
 */
export function useSurfaceContext(): SurfaceContext {
  const context = useContext(PluginSurfaceContextContext);
  if (!context) {
    throw new Error('PluginUiProvider is required before reading the surface context.');
  }
  return context;
}

/**
 * The public author names for the environment capabilities (§3.9).
 *
 * Each is the SAME context the shared presentation layer reads — an alias, not a
 * second resolver. A plugin-facing name and an internal one for one fact would
 * be a split-brain the first time either changed.
 */
export function usePluginTheme(): PluginUiThemeV1 {
  return useHappierUiTheme();
}

export type PluginTranslate = (key: string, fallback?: string) => string;

/**
 * Resolve one of this plugin's declared translation keys for the active locale.
 *
 * An undeclared key resolves to the author-supplied fallback, never to the raw
 * key: a missing translation degrades to readable English rather than leaking
 * `acme.plugin.some.key` into the interface.
 */
export function usePluginTranslation(): PluginTranslate {
  return useHappierUiLocalization().translate;
}

export type PluginAccessibilityFacts = HappierUiAccessibility;

export function usePluginAccessibility(): PluginAccessibilityFacts {
  return useHappierUiAccessibility();
}
