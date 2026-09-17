import { createConnection } from 'node:net';

// Bun's built-in `ws` ignores createConnection. The npm alias keeps the real library;
// a static import includes it in standalone binaries without runtime node_modules.
import WebSocket from 'ws-node';

export type CodexUnixWebSocket = WebSocket;

export function createCodexUnixWebSocket(socketPath: string): CodexUnixWebSocket {
    return new WebSocket('ws://localhost/', {
        createConnection: () => createConnection(socketPath),
        // Codex's tungstenite endpoint rejects the HTTP upgrade if this extension is offered.
        perMessageDeflate: false,
    });
}
