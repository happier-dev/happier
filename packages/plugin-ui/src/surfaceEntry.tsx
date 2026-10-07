import { createElement, type ComponentType } from 'react';
import {
  type ComposerRefV1,
  type RenderContext,
  type RenderSurface,
} from '@happier-dev/plugin-sdk/ui';
import { PluginUiProviderInternal } from './components/PluginUiProvider.js';
import { WidgetPresentationProvider } from './components/WidgetPresentation.js';
import {
  createHostedWebPluginUiDataClient,
} from './data/hostedWebAccountDataBridge.js';
import type { PluginUiDataClient } from './data/types.js';
import {
  PLUGIN_UI_PRIVATE_HOSTED_WEB_ACCOUNT_DATA_TRANSPORT_KEY,
  PLUGIN_UI_PRIVATE_MOUNTED_COMPOSER_REF_KEY,
} from './privateCarrierKeys.js';

// This symbol is set only by the SDK's hosted bootstrap after the canonical
// framed lifecycle is ready. It is intentionally not a public RenderContext
// field, and `createAuthorRenderContext` below strips every private property.
type HostedWebAvailableAccountDataTransportCarrier = Readonly<{
  kind: 'available';
  acquireTransport: Parameters<typeof createHostedWebPluginUiDataClient>[0]['acquireTransport'];
}>;

const hostedWebDataClients = new WeakMap<object, PluginUiDataClient>();

function isHostedWebAvailableAccountDataTransportCarrier(
  value: unknown,
): value is HostedWebAvailableAccountDataTransportCarrier {
  return value !== null
    && typeof value === 'object'
    && Reflect.get(value, 'kind') === 'available'
    && typeof Reflect.get(value, 'acquireTransport') === 'function';
}

function resolveHostedWebDataClient(context: RenderContext): PluginUiDataClient | undefined {
  const existing = hostedWebDataClients.get(context);
  if (existing) return existing;
  const carrier = Reflect.get(context, PLUGIN_UI_PRIVATE_HOSTED_WEB_ACCOUNT_DATA_TRANSPORT_KEY);
  const dataClient = isHostedWebAvailableAccountDataTransportCarrier(carrier)
    ? createHostedWebPluginUiDataClient({ acquireTransport: carrier.acquireTransport })
    : undefined;
  if (!dataClient) return undefined;
  hostedWebDataClients.set(context, dataClient);
  return dataClient;
}

/**
 * Wraps an author surface in the host-provided Plugin UI provider.
 *
 * The universal CommonJS compiler externalizes the complete
 * `@happier-dev/plugin-ui` export family. The same-realm host module map then
 * resolves every export from one physical package instance, so this provider
 * and plugin components consume the same React contexts. The wrapper receives
 * the public render context the host already passes, while the host attaches
 * private provider bindings only after this entry returns its provider element.
 * Arbitrary `renderSurface` code therefore never receives those bindings
 * through `RenderContext`, and authors need no bootstrap ceremony.
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
    ...(context.activity === undefined ? {} : { activity: context.activity }),
    ...(context.launchInput === undefined ? {} : { launchInput: context.launchInput }),
    ...(context.widgetPresentation === undefined ? {} : { widgetPresentation: context.widgetPresentation }),
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
        ...(context.activity === undefined ? {} : { surfaceActivity: context.activity }),
        ...(dataClient === undefined ? {} : { dataClient }),
      },
      createElement(WidgetPresentationProvider, { value: context.widgetPresentation }, createElement(Surface, authorContext)),
    );
  };
}
