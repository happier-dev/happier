// The declared package's physical entry: Bun maps a bare `undici` to a builtin whose
// Agent has no destroy and whose request ignores the dispatcher and its timeouts.
import { Agent, request } from 'undici/index.js';
import type { HttpExchange } from './httpExchange.js';

export function createHttpExchange(): HttpExchange {
  const dispatcher = new Agent();
  return {
    request: async (url, options) => await request(url, {
      ...options,
      dispatcher,
      // A valid Session Action can outlast Node fetch's hidden header deadline.
      // Caller cancellation remains the SDK deadline.
      headersTimeout: 0,
    }),
    close: async () => { await dispatcher.destroy(); },
  };
}
