import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

// Bun's built-in `ws` ignores createConnection. The npm alias keeps the real library;
// a static import includes it in standalone binaries without runtime node_modules.
import WebSocket from 'ws-node';

export type CodexWebSocket = WebSocket;

export function createCodexWebSocket(createStream: () => Duplex): CodexWebSocket {
    return new WebSocket('ws://localhost/', {
        // ws and Node HTTP accept Duplex streams; @types/ws narrows this external
        // extension point to net.Socket, excluding the native proxy's binary stdio.
        createConnection: createStream as () => Socket,
        // Codex's tungstenite endpoint rejects the HTTP upgrade if this extension is offered.
        perMessageDeflate: false,
        // Preserve ws's existing 100 MiB transport ceiling before it buffers a
        // complete message. Exceeding it fails the connection; within that boundary,
        // the JSON reader owns character limits and correlated request recovery.
    });
}
