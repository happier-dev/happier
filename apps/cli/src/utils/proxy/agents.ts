import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Socket } from 'node:net';

import { SERVER_HTTP_KEEP_ALIVE_TIMEOUT_MS_V1 } from '@happier-dev/protocol/server/http/connectionLifetimeV1';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { readHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';

export type DirectHttpAgents = Readonly<{
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
}>;

function createKeepAliveAgentOptions(input: Readonly<{
  serverKeepAliveTimeoutMs: number;
  retireBufferMs: number;
}>) {
  if (!Number.isSafeInteger(input.serverKeepAliveTimeoutMs) || input.serverKeepAliveTimeoutMs < 2) {
    throw new Error('Server keep-alive timeout must be an integer of at least 2ms');
  }
  if (!Number.isSafeInteger(input.retireBufferMs)
    || input.retireBufferMs < 1
    || input.retireBufferMs >= input.serverKeepAliveTimeoutMs) {
    throw new Error('HTTP free-socket retirement buffer must be below the server keep-alive timeout');
  }
  return {
    keepAlive: true,
    agentKeepAliveTimeoutBuffer: input.retireBufferMs,
    // Node's Agent timeout handler destroys a timed-out socket only while it
    // is in the free pool, so this bounds idle reuse without capping a request.
    timeout: input.serverKeepAliveTimeoutMs - input.retireBufferMs,
  };
}

export function createDirectHttpAgents(input: Readonly<{
  serverKeepAliveTimeoutMs: number;
  retireBufferMs: number;
}>): DirectHttpAgents {
  const options = createKeepAliveAgentOptions(input);
  return {
    httpAgent: new HttpAgent(options),
    httpsAgent: new HttpsAgent(options),
  };
}

// Node's own keep-alive race buffer is one second. Reuse that established
// transport margin: 72_000ms server idle close - 1_000ms = 71_000ms maximum
// client free-socket lifetime. The timer is unconditional because an HTTP
// intermediary is not required to preserve the server's Keep-Alive hint.
const CLIENT_HTTP_FREE_SOCKET_RETIRE_BUFFER_MS = 1_000;
const clientKeepAliveAgentOptions = createKeepAliveAgentOptions({
  serverKeepAliveTimeoutMs: SERVER_HTTP_KEEP_ALIVE_TIMEOUT_MS_V1,
  retireBufferMs: CLIENT_HTTP_FREE_SOCKET_RETIRE_BUFFER_MS,
});
function createHttpAgentPool() {
  let direct: DirectHttpAgents | undefined;
  const proxies = new Map<string, HttpsProxyAgent<string>>();
  return {
    direct() {
      return direct ??= {
        httpAgent: new HttpAgent(clientKeepAliveAgentOptions),
        httpsAgent: new HttpsAgent(clientKeepAliveAgentOptions),
      };
    },
    proxy(url: string) {
      const existing = proxies.get(url);
      if (existing) return existing;
      const agent = new HttpsProxyAgent(url, clientKeepAliveAgentOptions);
      proxies.set(url, agent);
      return agent;
    },
  };
}

const processPool = createHttpAgentPool();

export type HostedSessionHttpTransport = ReturnType<typeof createHttpAgentPool> & { retire(): void };

/** Give a hosted Session's HTTP requests a pool that can retire with its command. */
export function createHostedSessionHttpTransport(): HostedSessionHttpTransport {
  const pool = createHttpAgentPool();
  const agents = new Set<HttpAgent>();
  let retired = false;

  function own<T extends HttpAgent>(agent: T): T {
    if (agents.has(agent)) return agent;
    agents.add(agent);
    // Account-scoped work can still be reading a response after its initiating
    // Session ends. Let that request finish and retire its socket when returned.
    agent.on('free', (socket: Socket) => {
      if (retired && Object.values(agent.freeSockets).some(sockets => sockets?.includes(socket))) socket.destroy();
    });
    return agent;
  }

  return {
    direct() {
      const pair = pool.direct();
      own(pair.httpAgent);
      own(pair.httpsAgent);
      return pair;
    },
    proxy: url => own(pool.proxy(url)),
    retire(): void {
      retired = true;
      for (const agent of agents) {
        for (const sockets of Object.values(agent.freeSockets)) {
          for (const socket of sockets ?? []) socket.destroy();
        }
      }
    },
  };
}

export function getDirectHttpAgents(): DirectHttpAgents {
  return (readHostedSessionScope()?.httpTransport ?? processPool).direct();
}

export function getHttpRequestProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  return (readHostedSessionScope()?.httpTransport ?? processPool).proxy(proxyUrl);
}

/** Account and machine Socket.IO connections have their own process-wide owner. */
export function getHttpsProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  return processPool.proxy(proxyUrl);
}

