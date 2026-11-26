import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';

import type { McpServerConfig } from '@/agent';
import { RemoteMcpAuthenticationRequiredError } from '@/mcp/bridges/remoteMcpAuthenticationFailure';
import { connectRemoteMcpClient, createRemoteMcpOutputRedaction, type RemoteBridgeConfig } from '@/mcp/bridges/connectRemoteMcpClient';
import { McpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import type { PrepareMcpStdioTransport } from '@/mcp/runtime/supervisedStdioTransport';
import type { z } from 'zod/mini';
import { createCustomMcpClientTransport } from './createCustomMcpClientTransport';

export type SessionCustomMcpConnection =
  | Readonly<{ kind: 'stdio'; config: McpServerConfig }>
  | Readonly<{ kind: 'remote'; config: RemoteBridgeConfig }>;

type ClientEntry = Readonly<{
  client: Client;
  close: () => Promise<void>;
  redactOutput: (value: unknown, schema?: z.core.$ZodType) => unknown;
  redactError: (error: unknown) => Error;
}>;

function projectRemoteError(error: unknown, redact: (value: string) => string): Error {
  if (error instanceof RemoteMcpAuthenticationRequiredError || error instanceof CredentialRequestRedirectError) return error;
  const message = redact(error instanceof Error ? error.message : String(error));
  const code = error instanceof Error && 'code' in error && error.code === 'mcp_resource_mismatch'
    ? 'mcp_resource_mismatch' : 'tool_call_failed';
  return Object.assign(new Error(message), { code });
}

/** Owns the transports opened by the admitted Session profile. */
export function createSessionCustomMcpClientPool(input: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  prepareTransport?: PrepareMcpStdioTransport;
  signal?: AbortSignal;
  isCurrent?: () => boolean | Promise<boolean>;
}>) {
  const lifetime = new AbortController();
  const clients = new Map<string, Promise<ClientEntry>>();
  const retiring = new Set<Promise<void>>();
  let disposal: Promise<void> | undefined;

  function dispose(reason?: unknown): Promise<void> {
    if (disposal) return disposal;
    input.signal?.removeEventListener('abort', onAbort);
    lifetime.abort(reason);
    const pending = [...clients.values()];
    clients.clear();
    disposal = Promise.allSettled([
      ...retiring,
      ...pending.map(async entry => (await entry).close()),
    ]).then(() => undefined);
    return disposal;
  }
  function onAbort(): void { void dispose(input.signal?.reason); }
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener('abort', onAbort, { once: true });

  async function admit(signal?: AbortSignal): Promise<AbortSignal> {
    const operationSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    operationSignal.throwIfAborted();
    if (input.isCurrent && !await input.isCurrent()) {
      const error = new McpServerCatalogUnavailableError('scope-retired');
      await dispose(error);
      throw error;
    }
    operationSignal.throwIfAborted();
    return operationSignal;
  }

  function get(serverId: string, connection: SessionCustomMcpConnection): Promise<ClientEntry> {
    lifetime.signal.throwIfAborted();
    const previous = clients.get(serverId);
    if (previous) return previous;
    const pending = open(connection);
    clients.set(serverId, pending);
    void pending.then(entry => {
      const evict = () => {
        if (clients.get(serverId) !== pending) return;
        clients.delete(serverId);
        const closed = entry.close();
        retiring.add(closed);
        void closed.finally(() => retiring.delete(closed)).catch(() => undefined);
      };
      entry.client.onclose = evict;
      entry.client.onerror = evict;
    }, () => {
      if (clients.get(serverId) === pending) clients.delete(serverId);
    });
    return pending;
  }

  async function open(connection: SessionCustomMcpConnection): Promise<ClientEntry> {
    const signal = lifetime.signal;
    if (connection.kind === 'remote') {
      const lease = createRemoteMcpOutputRedaction(connection.config);
      const redactError = (error: unknown) => projectRemoteError(error, lease.redact);
      try {
        const client = await connectRemoteMcpClient(connection.config, lease, signal);
        return {
          client,
          close: async () => { try { await client.close(); } finally { lease.close(); } },
          redactOutput: lease.project,
          redactError,
        };
      } catch (error) {
        const projected = redactError(error);
        lease.close();
        throw projected;
      }
    }

    // The native launch owner already handles requester custody and supervises
    // the child's real stdio. The pool changes only the connection lifetime.
    let transport: Transport | undefined;
    const client = new Client({ name: 'happier-session-tools', version: '1.0.0' }, { capabilities: {} });
    try {
      transport = await createCustomMcpClientTransport(connection.config, input.processEnv,
        { signal, prepareTransport: input.prepareTransport });
      await client.connect(transport, { signal });
    } catch (error) {
      await Promise.allSettled([client.close(), transport?.close()]);
      throw error;
    }
    return {
      client,
      close: async () => { try { await client.close(); } finally { await transport?.close(); } },
      redactOutput: value => value,
      redactError: error => error instanceof Error ? error : new Error(String(error)),
    };
  }

  return { admit, get, dispose, signal: lifetime.signal };
}
