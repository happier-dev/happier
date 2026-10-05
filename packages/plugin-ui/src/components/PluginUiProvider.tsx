import {
  createContext,
  type Context,
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
  HappierUiPaletteProvider,
  HappierUiTypographyProvider,
  useHappierUiAccessibility,
  useHappierUiLocalization,
  useHappierUiTheme,
} from '../environment/context.js';
import { projectHappierUiEnvironment } from '../environment/projectEnvironment.js';
import { HappierPageChromeProvider } from '../presentation/layout/pageChrome.js';
import type { HappierUiAccessibility, HappierUiEnvironment } from '../environment/types.js';
import { PluginUiDataProviderInternal } from '../data/context.js';
import type { PluginUiDataClient } from '../data/types.js';
import { PluginHostApiProviderInternal } from '../hostApi/context.js';
import type { PluginUiResourceAccountLifetime, PluginUiResourceStore } from '../hostApi/resourceStore.js';
import type { PluginUiEphemeralSharedScope } from '../hostApi/ephemeralSharedScope.public.js';
import type { ComposerRefV1 } from '../composer/types.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../presentationHost/context.js';
import { PLUGIN_UI_PRIVATE_SURFACE_ENTRY_PROVIDER_KEY } from '../privateCarrierKeys.js';

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

/** @internal The surface bridge re-provides this across the host's details pane (`components/surfaceBridge.tsx`). */
export const PLUGIN_SURFACE_CONTEXT_INTERNAL: Context<SurfaceContext | null> = PluginSurfaceContextContext;

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
  resourceStore?: PluginUiResourceStore;
  mountedPluginId?: string;
  composerRef?: ComposerRefV1 | null;
  surfaceActivity?: Readonly<{ active: boolean }>;
  /** Private host visibility; does not alter the public surface lifetime. */
  presentationActive?: boolean;
  presentationHost?: PluginUiPresentationHost;
  dataClient?: PluginUiDataClient;
  ephemeralSharedScope?: PluginUiEphemeralSharedScope | null;
}>;

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

/** The same-realm host's typography, page-anatomy colour and page-chrome facts, when it supplies them. */
function installHostPresentationFacts(host: PluginUiPresentationHost, children: ReactNode): ReactNode {
  const withChrome = host.pageChrome
    ? <HappierPageChromeProvider chrome={host.pageChrome}>{children}</HappierPageChromeProvider>
    : children;
  const withPalette = host.palette
    ? <HappierUiPaletteProvider palette={host.palette}>{withChrome}</HappierUiPaletteProvider>
    : withChrome;
  return host.typography
    ? <HappierUiTypographyProvider typography={host.typography}>{withPalette}</HappierUiTypographyProvider>
    : withPalette;
}

/**
 * The same-realm host's presentation for public components Happier core renders on its own pages, with no plugin
 * mounted: the presentation environment plus the host's renderers and facts (type roles, page colours, page
 * scroller, details pane). There is no Host API, surface context or data client in it, so only components that
 * need none of them belong inside (the Collection and what its presentations draw).
 */
export function PluginUiHostPresentationScope(props: Readonly<{
  environment: HappierUiEnvironment;
  presentationHost: PluginUiPresentationHost;
  children?: ReactNode;
}>) {
  return (
    <HappierUiEnvironmentProvider environment={props.environment}>
      <PluginUiPresentationHostProviderInternal host={props.presentationHost}>
        {installHostPresentationFacts(props.presentationHost, props.children)}
      </PluginUiPresentationHostProviderInternal>
    </HappierUiEnvironmentProvider>
  );
}

/** Not exported through a package entry point; see `surfaceEntry.tsx`. */
export function PluginUiProviderInternal({
  hostApi,
  accountLifetime,
  resourceStoreGeneration,
  resourceStore,
  mountedPluginId,
  composerRef,
  surfaceActivity,
  presentationActive,
  presentationHost,
  dataClient,
  ephemeralSharedScope,
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
    () => (effectiveContext ? projectHappierUiEnvironment(effectiveContext) : null),
    [effectiveContext],
  );

  if (!effectiveContext || !environment) return null;

  return (
    <PluginHostApiProviderInternal
      hostApi={hostApi}
      {...(accountLifetime === undefined ? {} : { accountLifetime })}
      {...(resourceStoreGeneration === undefined ? {} : { resourceStoreGeneration })}
      {...(resourceStore === undefined ? {} : { resourceStore })}
      {...(mountedPluginId === undefined ? {} : { mountedPluginId })}
      {...(composerRef === undefined ? {} : { composerRef })}
      {...(surfaceActivity === undefined ? {} : { surfaceActivity })}
      {...(presentationActive === undefined ? {} : { presentationActive })}
      {...(ephemeralSharedScope === undefined ? {} : { ephemeralSharedScope })}
    >
      <PluginSurfaceContextContext.Provider value={effectiveContext}>
        <HappierUiEnvironmentProvider environment={environment}>
          <PluginUiDataProviderInternal {...(dataClient ? { client: dataClient } : {})}>
            {presentationHost
              ? (
                <PluginUiPresentationHostProviderInternal host={presentationHost}>
                  {installHostPresentationFacts(presentationHost, children)}
                </PluginUiPresentationHostProviderInternal>
              )
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
  PLUGIN_UI_PRIVATE_SURFACE_ENTRY_PROVIDER_KEY,
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

export type PluginTranslationValues = Readonly<Record<string, string | number>>;

export type PluginTranslate = (
  key: string,
  fallback?: string,
  values?: PluginTranslationValues,
) => string;

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
