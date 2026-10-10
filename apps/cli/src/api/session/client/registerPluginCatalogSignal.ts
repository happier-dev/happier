import type { EventEmitter } from 'node:events';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { DaemonPluginCatalogProjectionSchema, type DaemonPluginCatalogProjection } from '@/plugins/daemon/catalogProjection';

const event = 'daemon-plugin-catalog-invalidated';

/** The existing Session socket and event emitter fan out the content-free hint. */
export function registerPluginCatalogSignal(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  events: Pick<EventEmitter, 'on' | 'off' | 'emit'>;
}>) {
  params.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_PLUGIN_CATALOG_INVALIDATE_V1, (raw: unknown) => {
    const parsed = DaemonPluginCatalogProjectionSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_action_input' };
    params.events.emit(event, parsed.data);
    return { ok: true };
  });
  return (listener: (projection: DaemonPluginCatalogProjection) => void): (() => void) => {
    params.events.on(event, listener);
    return () => { params.events.off(event, listener); };
  };
}
