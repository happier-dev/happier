import { AcpAgentPeer } from './AcpAgentPeer';
import { loadAcpSdk } from './acpSdk';
import { registerAcpClientHandlers } from './registerAcpClientHandlers';
import type { AcpClientConnectionOptions } from './types';

export type AcpClientConnection = Readonly<{
  peer: AcpAgentPeer;
  signal: AbortSignal;
  closed: Promise<void>;
  close: (error?: unknown) => void;
}>;

function defaultExtensionContext(
  method: string,
  signal: AbortSignal,
): ReturnType<NonNullable<AcpClientConnectionOptions['createExtensionContext']>> {
  return {
    method,
    sessionId: null,
    signal,
    agentName: 'acp',
  };
}

export async function createAcpClientConnection(
  options: AcpClientConnectionOptions,
): Promise<AcpClientConnection> {
  const { AgentApp, client, methods } = await loadAcpSdk();
  const app = client({ name: options.name });
  registerAcpClientHandlers({
    app,
    methods,
    handlers: options.handlers,
    extensions: options.extensions ?? [],
    createExtensionContext: options.createExtensionContext ?? defaultExtensionContext,
  });

  const connection = options.transport instanceof AgentApp
    ? app.connect(options.transport)
    : app.connect(options.transport);
  return {
    peer: new AcpAgentPeer(methods, connection.agent, connection.signal, options.isAuthenticationSetupFailure),
    signal: connection.signal,
    closed: connection.closed,
    close: (error?: unknown) => connection.close(error),
  };
}
