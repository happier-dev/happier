import { describe, expectTypeOf, it } from 'vitest';

import type {
    PluginFramedBytesClient,
    PluginJsonRpcClient,
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
    ProtocolClientsService,
} from './exec/protocol-clients.js';
import type {
    PluginFramedBytesClient as SourcePluginFramedBytesClient,
    PluginJsonRpcClient as SourcePluginJsonRpcClient,
    PluginJsonStreamClient as SourcePluginJsonStreamClient,
    PluginLoopbackWebSocketClientSpec as SourcePluginLoopbackWebSocketClientSpec,
    PluginLoopbackWebSocketEndpoint as SourcePluginLoopbackWebSocketEndpoint,
    PluginLoopbackWebSocketHandshake as SourcePluginLoopbackWebSocketHandshake,
    PluginLoopbackWebSocketHeader as SourcePluginLoopbackWebSocketHeader,
    PluginLoopbackWebSocketJsonClient as SourcePluginLoopbackWebSocketJsonClient,
    PluginProtocolClientByKind as SourcePluginProtocolClientByKind,
    PluginProtocolClientHandle as SourcePluginProtocolClientHandle,
    PluginProtocolClientKind as SourcePluginProtocolClientKind,
    PluginProtocolClientSpec as SourcePluginProtocolClientSpec,
    PluginProtocolClientSpecByKind as SourcePluginProtocolClientSpecByKind,
    ProtocolClientsService as SourceProtocolClientsService,
} from './services/io.js';

describe('EU-3 protocol-client package-local projection', () => {
    it('projects the complete canonical protocol-client family by identity', () => {
        expectTypeOf<PluginFramedBytesClient>().toEqualTypeOf<SourcePluginFramedBytesClient>();
        expectTypeOf<PluginJsonRpcClient>().toEqualTypeOf<SourcePluginJsonRpcClient>();
        expectTypeOf<PluginJsonStreamClient>().toEqualTypeOf<SourcePluginJsonStreamClient>();
        expectTypeOf<PluginLoopbackWebSocketClientSpec>()
            .toEqualTypeOf<SourcePluginLoopbackWebSocketClientSpec>();
        expectTypeOf<PluginLoopbackWebSocketEndpoint>()
            .toEqualTypeOf<SourcePluginLoopbackWebSocketEndpoint>();
        expectTypeOf<PluginLoopbackWebSocketHandshake>()
            .toEqualTypeOf<SourcePluginLoopbackWebSocketHandshake>();
        expectTypeOf<PluginLoopbackWebSocketHeader>()
            .toEqualTypeOf<SourcePluginLoopbackWebSocketHeader>();
        expectTypeOf<PluginLoopbackWebSocketJsonClient>()
            .toEqualTypeOf<SourcePluginLoopbackWebSocketJsonClient>();
        expectTypeOf<PluginProtocolClientByKind>()
            .toEqualTypeOf<SourcePluginProtocolClientByKind>();
        expectTypeOf<PluginProtocolClientHandle>()
            .toEqualTypeOf<SourcePluginProtocolClientHandle>();
        expectTypeOf<PluginProtocolClientKind>()
            .toEqualTypeOf<SourcePluginProtocolClientKind>();
        expectTypeOf<PluginProtocolClientSpec>()
            .toEqualTypeOf<SourcePluginProtocolClientSpec>();
        expectTypeOf<PluginProtocolClientSpecByKind<'jsonRpc'>>()
            .toEqualTypeOf<SourcePluginProtocolClientSpecByKind<'jsonRpc'>>();
        expectTypeOf<ProtocolClientsService>()
            .toEqualTypeOf<SourceProtocolClientsService>();
    });
});
