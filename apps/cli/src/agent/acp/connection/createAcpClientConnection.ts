import { AgentApp, client } from '@agentclientprotocol/sdk';

import { AcpAgentPeer } from './AcpAgentPeer';
import { registerAcpClientHandlers } from './registerAcpClientHandlers';
import type { AcpClientConnectionOptions } from './types';

export type AcpClientConnectionCloseOptions = Readonly<{
  timeoutMs?: number;
}>;

export type AcpClientConnection = Readonly<{
  peer: AcpAgentPeer;
  signal: AbortSignal;
  closed: Promise<void>;
  close: (error?: unknown, options?: AcpClientConnectionCloseOptions) => void;
}>;

export function createAcpClientConnection(
  options: AcpClientConnectionOptions,
): AcpClientConnection {
  const app = client({ name: options.name });
  registerAcpClientHandlers({
    app,
    handlers: options.handlers,
    extensions: options.extensions ?? [],
    createExtensionContext: options.createExtensionContext
      ?? ((method, signal) => ({ method, signal })),
  });
  const connection = options.transport instanceof AgentApp
    ? app.connect(options.transport)
    : app.connect(options.transport);
  let closeDeadlineTimeout: ReturnType<typeof setTimeout> | null = null;
  let closedSettled = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const settleClosed = () => {
    if (closedSettled) return;
    closedSettled = true;
    if (closeDeadlineTimeout) {
      clearTimeout(closeDeadlineTimeout);
      closeDeadlineTimeout = null;
    }
    resolveClosed();
  };
  void connection.closed.then(settleClosed, settleClosed);

  return {
    peer: new AcpAgentPeer(connection.agent, connection.signal),
    signal: connection.signal,
    closed,
    close: (error?: unknown, closeOptions?: AcpClientConnectionCloseOptions) => {
      const timeoutMs = closeOptions?.timeoutMs;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
        throw new RangeError('ACP connection close timeout must be a finite non-negative number');
      }

      connection.close(error);
      if (closedSettled || closeDeadlineTimeout || timeoutMs === undefined) return;
      closeDeadlineTimeout = setTimeout(settleClosed, timeoutMs);
      closeDeadlineTimeout.unref?.();
    },
  };
}
