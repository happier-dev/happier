import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

import {
  createPluginUiHostApiResourceClient,
  createPluginUiResourceStore,
  type PluginUiResourceAccountLifetime,
  type PluginUiResourceStore,
} from './resourceStore.js';
import type { ComposerRefV1 } from '../composer/types.js';

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
}>;

const PluginHostApiContext = createContext<PluginHostApiContextValue | null>(null);

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
    () => Object.freeze({ hostApi, resourceStore, composerRef }),
    [hostApi, resourceStore, composerRef],
  );
  return createElement(PluginHostApiContext.Provider, { value }, children);
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

/** Internal carrier for the host-validated Composer mount identity. */
export function usePluginHostApiComposerRef(): ComposerRefV1 | null {
  const context = useContext(PluginHostApiContext);
  if (!context) {
    throw new Error('PluginHostApiProvider is required before using plugin UI host API hooks.');
  }
  return context.composerRef;
}
