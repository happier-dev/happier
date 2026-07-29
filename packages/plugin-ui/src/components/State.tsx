import type { ReactElement, ReactNode } from 'react';

import { createPrimitiveElement } from './primitiveElement.js';

export type PluginUiResourceState<Value = unknown> =
  | Readonly<{ status: 'idle' | 'loading' }>
  | Readonly<{ status: 'ready'; value: Value }>
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'unavailable' | 'stale' | 'complete'; diagnostics?: readonly string[] }>
  | Readonly<{ status: 'error'; code?: string; message?: string; diagnostics?: readonly string[] }>;

export type StateProps<Value> = Readonly<{
  resource?: PluginUiResourceState<Value>;
  loading?: ReactNode;
  empty?: ReactNode;
  error?: ReactNode | ((state: Extract<PluginUiResourceState<Value>, { status: 'error' }>) => ReactNode);
  children?: ReactNode | ((value: Value) => ReactNode);
}>;

function renderStateChildren<Value>({
  resource,
  loading,
  empty,
  error,
  children,
}: StateProps<Value>): ReactNode {
  if (!resource || resource.status === 'idle' || resource.status === 'loading') {
    return loading;
  }
  if (resource.status === 'empty') {
    return empty;
  }
  if (resource.status === 'error') {
    return typeof error === 'function' ? error(resource) : error;
  }
  if (resource.status === 'ready') {
    return typeof children === 'function' ? children(resource.value) : children;
  }
  return typeof children === 'function' ? undefined : children;
}

export function State<Value>({
  resource,
  loading,
  empty,
  error,
  children,
}: StateProps<Value>): ReactElement {
  const diagnostics = resource && 'diagnostics' in resource
    ? resource.diagnostics
    : undefined;

  return createPrimitiveElement('State', 'happier-plugin-state', {
    state: resource?.status ?? 'loading',
    diagnostics,
  }, renderStateChildren({ resource, loading, empty, error, children }));
}
