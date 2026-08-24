import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from 'react';

import type { PluginUiDataClient } from './types.js';

const PluginUiDataContext = createContext<PluginUiDataClient | null>(null);

/** Private bridge props used only by the bundled surface entry. */
export type PluginUiDataProviderInternalProps = Readonly<{
  client?: PluginUiDataClient;
  children?: ReactNode;
}>;

/**
 * Host-only carrier for the one captured-Account Data client. It is installed
 * after the author has returned a marked provider element, never through the
 * public RenderContext or PluginUiProvider props.
 */
export function PluginUiDataProviderInternal({
  client,
  children,
}: PluginUiDataProviderInternalProps) {
  return createElement(PluginUiDataContext.Provider, { value: client ?? null }, children);
}

/**
 * Reads the mounted surface's authenticated Account Data client.
 */
export function usePluginUiDataClient(): PluginUiDataClient {
  const client = useContext(PluginUiDataContext);
  if (!client) {
    throw new Error('Plugin UI Data is unavailable for this mounted surface.');
  }
  return client;
}

/**
 * The same client, as a fact rather than a throw.
 *
 * A surface whose durable state lives in the reader's Account has to be able to
 * ask whether that Account is reachable at all: with no client it must keep the
 * rows it already showed, disable the controls that write, and say so. Throwing
 * is the right answer for a surface that cannot function without Data; a
 * surface that degrades honestly needs the answer, not the exception.
 */
export function usePluginUiDataClientOrNull(): PluginUiDataClient | null {
  return useContext(PluginUiDataContext);
}
