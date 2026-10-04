import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { HappierUiAnimationActivityProviderInternal } from '../environment/context.js';

import {
  createPluginUiHostApiResourceClient,
  createPluginUiResourceStore,
  type PluginUiResourceAccountLifetime,
  type PluginUiResourceStore,
} from './resourceStore.js';
import type { ComposerRefV1 } from '../composer/types.js';
import type { PluginUiEphemeralSharedScope } from './ephemeralSharedScope.public.js';

/**
 * The bound surface controller, published to the plugin's component tree (§3.1).
 *
 * Its own module rather than the `./hostApi` barrel so every hook that needs the
 * controller — resource reads, action execution, and whatever joins them —
 * imports the context directly instead of importing the barrel that re-exports
 * them, which would make the package's own hooks circular.
 */
type PluginHostApiContextValue = Readonly<{
  hostApi: PluginUiHostApi;
  resourceStore: PluginUiResourceStore;
  composerRef: ComposerRefV1 | null;
  surfaceActive: boolean | undefined;
  ephemeralSharedScope: PluginUiEphemeralSharedScope | null;
}>;

const PluginHostApiContext = createContext<PluginHostApiContextValue | null>(null);

/** @internal The surface bridge re-provides this across the host's details pane (`components/surfaceBridge.tsx`). */
export const PLUGIN_HOST_API_CONTEXT_INTERNAL = PluginHostApiContext;

export type PluginHostApiProviderProps = Readonly<{
  hostApi: PluginUiHostApi;
  children?: ReactNode;
}>;

/** Private bridge props used only by the bundled surface entry. */
export type PluginHostApiProviderInternalProps = PluginHostApiProviderProps & Readonly<{
  /**
   * Host-private currentness inputs for the mounted Resource store. Authors
   * never receive Account identity; this token only fences their own stale
   * reads/subscriptions and namespaces otherwise identical Resource ids.
   */
  accountLifetime?: PluginUiResourceAccountLifetime | null;
  resourceStoreGeneration?: unknown;
  mountedPluginId?: string;
  /** Host-validated Composer mount identity; never author-supplied. */
  composerRef?: ComposerRefV1 | null;
  surfaceActivity?: Readonly<{ active: boolean }>;
  /** Host visibility narrows presentation only, never Resource activity. */
  presentationActive?: boolean;
  /** Host-owned Account+plugin+generation scope; absent on unsupported renderers. */
  ephemeralSharedScope?: PluginUiEphemeralSharedScope | null;
}>;

export function PluginHostApiProvider(props: PluginHostApiProviderProps) {
  // The public prop surface deliberately stays author-safe. Hosts may clone
  // this mounted provider with the private props above, but author code never
  // receives those values through RenderContext or its declared prop type.
  const privateProps = props as PluginHostApiProviderInternalProps;
  return createElement(
    PluginHostApiProviderInternal,
    {
      hostApi: props.hostApi,
      ...(privateProps.accountLifetime === undefined
        ? {}
        : { accountLifetime: privateProps.accountLifetime }),
      ...(privateProps.resourceStoreGeneration === undefined
        ? {}
        : { resourceStoreGeneration: privateProps.resourceStoreGeneration }),
      ...(privateProps.mountedPluginId === undefined
        ? {}
        : { mountedPluginId: privateProps.mountedPluginId }),
      ...(privateProps.composerRef === undefined
        ? {}
        : { composerRef: privateProps.composerRef }),
      ...(privateProps.surfaceActivity === undefined
        ? {}
        : { surfaceActivity: privateProps.surfaceActivity }),
      ...(privateProps.presentationActive === undefined
        ? {}
        : { presentationActive: privateProps.presentationActive }),
      ...(privateProps.ephemeralSharedScope === undefined
        ? {}
        : { ephemeralSharedScope: privateProps.ephemeralSharedScope }),
    },
    props.children,
  );
}

/** Not exported through a package entry point; see `surfaceEntry.tsx`. */
export function PluginHostApiProviderInternal({
  hostApi,
  accountLifetime = null,
  resourceStoreGeneration,
  mountedPluginId,
  composerRef = null,
  surfaceActivity,
  presentationActive = true,
  ephemeralSharedScope = null,
  children,
}: PluginHostApiProviderInternalProps) {
  const resourceClient = useMemo(
    () => createPluginUiHostApiResourceClient(hostApi),
    [hostApi],
  );
  const resourceStore = useMemo(
    () => createPluginUiResourceStore({
      client: resourceClient,
      accountLifetime,
      ...(mountedPluginId === undefined ? {} : { pluginId: mountedPluginId }),
    }),
    [resourceClient, accountLifetime, resourceStoreGeneration, mountedPluginId],
  );
  useEffect(() => () => resourceStore.dispose(), [resourceStore]);
  const value = useMemo(
    () => Object.freeze({
      hostApi,
      resourceStore,
      composerRef,
      surfaceActive: surfaceActivity?.active,
      ephemeralSharedScope,
    }),
    [hostApi, resourceStore, composerRef, surfaceActivity?.active, ephemeralSharedScope],
  );
  return createElement(PluginHostApiContext.Provider, { value },
    createElement(HappierUiAnimationActivityProviderInternal, {
      active: value.surfaceActive === true && presentationActive,
    }, children),
  );
}

export function usePluginHostApi(): PluginUiHostApi {
  const context = useContext(PluginHostApiContext);
  if (!context) {
    throw new Error('PluginHostApiProvider is required before using plugin UI host API hooks.');
  }
  return context.hostApi;
}

/** Internal hook used by the public Resource hooks in this package. */
export function usePluginHostApiResourceStore(): PluginUiResourceStore {
  const context = useContext(PluginHostApiContext);
  if (!context) {
    throw new Error('PluginHostApiProvider is required before using plugin UI host API hooks.');
  }
  return context.resourceStore;
}

/** Internal Resource eligibility; legacy providers without activity remain live. */
export function usePluginHostApiResourceActive(): boolean {
  const context = useContext(PluginHostApiContext);
  if (!context) {
    throw new Error('PluginHostApiProvider is required before using plugin UI host API hooks.');
  }
  return context.surfaceActive ?? true;
}

/** Internal carrier for the host-validated Composer mount identity. */
export function usePluginHostApiComposerRef(): ComposerRefV1 | null {
  const context = useContext(PluginHostApiContext);
  if (!context) {
    throw new Error('PluginHostApiProvider is required before using plugin UI host API hooks.');
  }
  return context.composerRef;
}

/** Current host-owned activity for this retained physical surface mount. */
export function usePluginSurfaceActivity(): Readonly<{ active: boolean }> {
  const context = useContext(PluginHostApiContext);
  if (!context) {
    throw new Error('PluginHostApiProvider is required before reading plugin surface activity.');
  }
  return useMemo(() => Object.freeze({ active: context.surfaceActive ?? false }), [context.surfaceActive]);
}

/**
 * Read the optional host-owned ephemeral scope for this artifact.
 *
 * In-process provider mounts where the host did not install this capability
 * return `null`. Hosted frames have no in-process provider or scope bridge at
 * all. The hook never manufactures a realm-local fallback because doing so
 * would create a second value owner.
 */
export function usePluginUiEphemeralSharedScope(): PluginUiEphemeralSharedScope | null {
  const context = useContext(PluginHostApiContext);
  if (!context) {
    throw new Error('PluginHostApiProvider is required before reading the ephemeral shared scope.');
  }
  return context.ephemeralSharedScope;
}
