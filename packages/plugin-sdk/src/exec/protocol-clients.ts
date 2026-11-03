/** @moduleRealm daemon */
/** @realm any */
export type { ProtocolClientsService } from '../services/io.js';
export type {
    PluginFramedBytesClient,
    PluginJsonRpcClient,
    PluginJsonRpcConnection,
    PluginJsonRpcConnectionSpec,
    PluginJsonStreamClient,
    PluginLoopbackWebSocketClientSpec,
    PluginLoopbackWebSocketEndpoint,
    PluginLoopbackWebSocketHandshake,
    PluginLoopbackWebSocketHeader,
    PluginLoopbackWebSocketJsonClient,
    PluginProtocolClientByKind,
    PluginProtocolClientHandle,
    PluginProtocolClientKind,
    PluginProtocolClientSpec,
    PluginProtocolClientSpecByKind,
} from '../services/io.js';

export { readJsonRpcApplicationRejection } from './jsonRpcOutcome.js';
export type { JsonRpcApplicationError, JsonRpcApplicationRejectionDetails } from './jsonRpcOutcome.js';
