import {
  PluginSessionResourceTargetV1Schema,
  type PluginSessionResourceTargetV1,
  type PluginUiHostApiMethodV1,
  type PluginUiJsonValueV1,
  type PluginUiResourceSubscriptionEventV1,
  PluginUiSurfaceContextV1Schema,
  type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

export type PluginUiHostApiRequestOptions = Readonly<{
  timeoutMs?: number;
}>;

export type PluginUiHostApiSubscription = Readonly<{
  subscriptionId: string;
  unsubscribe(): void;
}>;

export type PluginUiHostApiClientLike = Readonly<{
  request(
    method: PluginUiHostApiMethodV1,
    payload?: PluginUiJsonValueV1,
    options?: PluginUiHostApiRequestOptions,
  ): Promise<PluginUiJsonValueV1 | undefined>;
  subscribeResource(
    resource: PluginSessionResourceTargetV1,
    listener: (event: PluginUiResourceSubscriptionEventV1) => void,
  ): PluginUiHostApiSubscription;
}>;

export type PluginUiHostApi = Readonly<{
  request(
    method: PluginUiHostApiMethodV1,
    payload?: PluginUiJsonValueV1,
    options?: PluginUiHostApiRequestOptions,
  ): Promise<PluginUiJsonValueV1 | undefined>;
  getSurfaceContext(
    options?: PluginUiHostApiRequestOptions,
  ): Promise<PluginUiSurfaceContextV1>;
  requestSessionResource(
    resource: PluginSessionResourceTargetV1,
    options?: PluginUiHostApiRequestOptions,
  ): Promise<PluginUiJsonValueV1 | undefined>;
  subscribeResource(
    resource: PluginSessionResourceTargetV1,
    listener: (event: PluginUiResourceSubscriptionEventV1) => void,
  ): PluginUiHostApiSubscription;
  dispatchAction(
    action: PluginUiJsonValueV1,
    options?: PluginUiHostApiRequestOptions,
  ): Promise<PluginUiJsonValueV1 | undefined>;
  openSurface(
    payload: PluginUiJsonValueV1,
    options?: PluginUiHostApiRequestOptions,
  ): Promise<PluginUiJsonValueV1 | undefined>;
  logDiagnostic(
    payload: PluginUiJsonValueV1,
    options?: PluginUiHostApiRequestOptions,
  ): Promise<void>;
  copy(
    payload: PluginUiJsonValueV1,
    options?: PluginUiHostApiRequestOptions,
  ): Promise<PluginUiJsonValueV1 | undefined>;
  openExternal(
    payload: PluginUiJsonValueV1,
    options?: PluginUiHostApiRequestOptions,
  ): Promise<PluginUiJsonValueV1 | undefined>;
}>;

export function parsePluginUiResourceTarget(
  resource: PluginSessionResourceTargetV1,
): PluginSessionResourceTargetV1 {
  const parsed = PluginSessionResourceTargetV1Schema.safeParse(resource);
  if (!parsed.success) {
    throw new Error(
      'Invalid plugin UI resource target. Use the canonical PluginSessionResourceTargetV1 shapes.',
    );
  }
  return parsed.data;
}

export function createPluginUiHostApiFacade(
  client: PluginUiHostApiClientLike,
): PluginUiHostApi {
  return Object.freeze({
    request: (method, payload, options) => client.request(method, payload, options),
    getSurfaceContext: async (options) => {
      const result = await client.request('getSurfaceContext', undefined, options);
      return PluginUiSurfaceContextV1Schema.parse(result);
    },
    requestSessionResource: (resource, options) => client.request(
      'requestSessionResource',
      { resource: parsePluginUiResourceTarget(resource) },
      options,
    ),
    subscribeResource: (resource, listener) =>
      client.subscribeResource(parsePluginUiResourceTarget(resource), listener),
    dispatchAction: (action, options) => client.request('dispatchAction', action, options),
    openSurface: (payload, options) => client.request('openSurface', payload, options),
    logDiagnostic: async (payload, options) => {
      await client.request('logDiagnostic', payload, options);
    },
    copy: (payload, options) => client.request('copy', payload, options),
    openExternal: (payload, options) => client.request('openExternal', payload, options),
  });
}
