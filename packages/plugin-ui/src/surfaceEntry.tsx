import { createElement, type ComponentType } from 'react';
import {
  type ComposerRefV1,
  type RenderContext,
  type RenderSurface,
} from '@happier-dev/plugin-sdk/ui';

import { PluginUiProviderInternal } from './components/PluginUiProvider.js';
import {
  createHostedWebPluginUiDataClient,
  createUnavailableHostedWebPluginUiDataClient,
} from './data/hostedWebCollectionUiQueryBridge.js';
import type { PluginUiDataClient } from './data/types.js';

// This symbol is set only by the SDK's hosted bootstrap after the canonical
// framed lifecycle is ready. It is intentionally not a public RenderContext
// field, and `createAuthorRenderContext` below strips every private property.
const PLUGIN_UI_PRIVATE_HOSTED_WEB_COLLECTION_UI_QUERY_TRANSPORT_KEY = Symbol.for(
  'happier.pluginUi.privateHostedWebCollectionUiQueryTransport.v1',
);
const PLUGIN_UI_PRIVATE_MOUNTED_COMPOSER_REF_KEY = Symbol.for(
  'happier.pluginUi.privateMountedComposerRef.v1',
);

type HostedWebAvailableCollectionUiQueryTransportCarrier = Readonly<{
  kind: 'available';
  acquireTransport: Parameters<typeof createHostedWebPluginUiDataClient>[0]['acquireTransport'];
}>;

type HostedWebUnavailableCollectionUiQueryTransportCarrier = Readonly<{
  kind: 'unavailable';
}>;

const hostedWebDataClients = new WeakMap<object, PluginUiDataClient>();

function isHostedWebAvailableCollectionUiQueryTransportCarrier(
  value: unknown,
): value is HostedWebAvailableCollectionUiQueryTransportCarrier {
  return value !== null
    && typeof value === 'object'
    && Reflect.get(value, 'kind') === 'available'
    && typeof Reflect.get(value, 'acquireTransport') === 'function';
}

function isHostedWebUnavailableCollectionUiQueryTransportCarrier(
  value: unknown,
): value is HostedWebUnavailableCollectionUiQueryTransportCarrier {
  return value !== null
    && typeof value === 'object'
    && Reflect.get(value, 'kind') === 'unavailable';
}

function resolveHostedWebDataClient(context: RenderContext): PluginUiDataClient | undefined {
  const existing = hostedWebDataClients.get(context);
  if (existing) return existing;
  const carrier = Reflect.get(context, PLUGIN_UI_PRIVATE_HOSTED_WEB_COLLECTION_UI_QUERY_TRANSPORT_KEY);
  const dataClient = isHostedWebAvailableCollectionUiQueryTransportCarrier(carrier)
    ? createHostedWebPluginUiDataClient({ acquireTransport: carrier.acquireTransport })
    : isHostedWebUnavailableCollectionUiQueryTransportCarrier(carrier)
      ? createUnavailableHostedWebPluginUiDataClient()
      : undefined;
  if (!dataClient) return undefined;
  hostedWebDataClients.set(context, dataClient);
  return dataClient;
}

/**
 * The artifact entry wrapper for a plugin UI surface (§3.9).
 *
 * §3.9 promises that an author "does not need bootstrap ceremony": the provider
 * is installed around the exported surface rather than by the author's own
 * component tree. The RN/RNW host CANNOT install it. `@happier-dev/plugin-ui`
 * is bundled INTO each plugin artifact — it is not in
 * `PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS`, which host-provides only
 * `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-native-web` and
 * `@happier-dev/plugin-sdk/ui/client`. A provider created from a host-owned
 * copy of this package would publish React contexts created by a DIFFERENT
 * module instance from the one the plugin's own components read, so the
 * components would still throw "PluginUiProvider is required". Host-wrapping one
 * copy while components consume another is not a fix; it is a harder-to-see
 * version of the same bug.
 *
 * So the wrapper lives at the artifact entry, inside the plugin bundle, where
 * the provider and the components are the same module instance. It receives
 * the public render context the host already passes — the bound surface
 * controller (`hostApi`) and the initial surface snapshot (`surface`) — so the
 * author supplies no host wiring at all. The host attaches its private provider
 * bindings only after this entry returns its provider element; arbitrary
 * `renderSurface` code never receives those bindings through `RenderContext`.
 *
 * Making this fully generated (so the entry file names no wrapper) needs a
 * bundler-level entry indirection across BOTH the Vite/react-native-web and the
 * Re.Pack/Module-Federation tiers, and there is no packed `plugin-ui` consumer
 * yet to prove it against (EU-7f). Host-providing this package as a versioned
 * singleton instead is blocked on W-04/EU-6. Both later shapes keep this exact
 * author contract: they replace who writes the entry line, not what it means.
 */
export type UiSurfaceComponent = ComponentType<RenderContext>;

function createAuthorRenderContext(context: RenderContext): RenderContext {
  // Copy the published ABI explicitly. `renderSurface` is arbitrary trusted
  // code, so relying on it to omit a non-enumerable carrier would make the
  // boundary cooperative rather than host-enforced.
  return Object.freeze({
    plugin: context.plugin,
    surface: context.surface,
    hostApi: context.hostApi,
    signal: context.signal,
    ...(context.launchInput === undefined ? {} : { launchInput: context.launchInput }),
    ...(context.subPath === undefined ? {} : { subPath: context.subPath }),
  });
}

function resolveMountedComposerRef(context: RenderContext): ComposerRefV1 | null {
  // The SDK has already validated this host-only bootstrap field through the
  // Protocol schema. Public launch input is never a Composer-current carrier.
  return (Reflect.get(context, PLUGIN_UI_PRIVATE_MOUNTED_COMPOSER_REF_KEY) as ComposerRefV1 | undefined) ?? null;
}

export function defineUiSurface(Surface: UiSurfaceComponent): RenderSurface {
  return (context) => {
    const authorContext = createAuthorRenderContext(context);
    const dataClient = resolveHostedWebDataClient(context);
    const composerRef = resolveMountedComposerRef(context);
    return createElement(
      PluginUiProviderInternal,
      // The snapshot is the SEED; `watchContext` on the same bound controller
      // drives every later theme, locale and accessibility fact.
      {
        hostApi: context.hostApi,
        context: context.surface,
        mountedPluginId: context.plugin.id,
        composerRef,
        ...(dataClient === undefined ? {} : { dataClient }),
      },
      createElement(Surface, authorContext),
    );
  };
}
