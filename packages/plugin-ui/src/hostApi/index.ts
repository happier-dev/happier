import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  PluginSessionResourceTargetV1,
  PluginUiJsonValueV1,
  PluginUiResourceSnapshotV1,
  PluginUiResourceSubscriptionEventV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginUiResourceState } from '../components/State.js';
import {
  parsePluginUiResourceTarget,
  type PluginUiHostApi,
} from './client.js';

export {
  createPluginUiHostApiFacade,
  parsePluginUiResourceTarget,
} from './client.js';
export {
  createPluginSurfaceHostApi,
} from './createPluginSurfaceHostApi.js';
export type {
  CreatePluginSurfaceHostApiInput,
  PluginSurfaceHostApiHandlers,
  PluginSurfaceHostApiMethodHandler,
  PluginSurfaceHostApiV1,
} from './createPluginSurfaceHostApi.js';
export type {
  PluginUiHostApi,
  PluginUiHostApiClientLike,
  PluginUiHostApiRequestOptions,
  PluginUiHostApiSubscription,
} from './client.js';

const PluginHostApiContext = createContext<PluginUiHostApi | null>(null);

export type PluginHostApiProviderProps = Readonly<{
  client: PluginUiHostApi;
  children?: ReactNode;
}>;

export function PluginHostApiProvider({
  client,
  children,
}: PluginHostApiProviderProps) {
  return createElement(PluginHostApiContext.Provider, { value: client }, children);
}

export function usePluginHostApi(): PluginUiHostApi {
  const client = useContext(PluginHostApiContext);
  if (!client) {
    throw new Error('PluginHostApiProvider is required before using plugin UI host API hooks.');
  }
  return client;
}

function createLoadingResourceState<Value>(): PluginUiResourceState<Value> {
  return { status: 'loading' };
}

function stateFromSnapshot<Value>(
  snapshot: PluginUiResourceSnapshotV1,
): PluginUiResourceState<Value> {
  if (snapshot.state === 'available') {
    if (snapshot.payload === undefined || snapshot.payload === null) {
      return { status: 'empty' };
    }
    return {
      status: 'ready',
      value: snapshot.payload as Value,
    };
  }
  return {
    status: snapshot.state,
    diagnostics: snapshot.diagnostics,
  };
}

function stateFromSubscriptionEvent<Value>(
  event: PluginUiResourceSubscriptionEventV1,
): PluginUiResourceState<Value> {
  if (event.kind === 'snapshot') {
    return stateFromSnapshot(event.snapshot);
  }
  if (event.kind === 'complete') {
    return {
      status: 'complete',
      diagnostics: event.diagnostics,
    };
  }
  return {
    status: 'error',
    code: event.code,
    diagnostics: event.diagnostics,
  };
}

export function usePluginResource<Value = PluginUiJsonValueV1>(
  resource: PluginSessionResourceTargetV1,
): PluginUiResourceState<Value> {
  const client = usePluginHostApi();
  const resourceKey = JSON.stringify(resource);
  const parsedResource = useMemo(
    () => parsePluginUiResourceTarget(resource),
    [resourceKey],
  );
  const [state, setState] = useState<PluginUiResourceState<Value>>(() =>
    createLoadingResourceState(),
  );

  useEffect(() => {
    let active = true;
    setState(createLoadingResourceState());
    const subscription = client.subscribeResource(parsedResource, (event) => {
      if (!active) return;
      setState(stateFromSubscriptionEvent<Value>(event));
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client, parsedResource]);

  return state;
}
