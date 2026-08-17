import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

import { decodeAntigravityLocalharnessEndpoint } from './handshake.js';

export type AntigravityLocalharnessClientExit = Readonly<{
  exitCode: number | null;
  signal: string | null;
}>;

export interface AntigravityLocalharnessClient {
  send(message: unknown): Promise<void>;
  subscribe(listener: (message: unknown) => void | Promise<void>): () => void;
  onExit(listener: (result: AntigravityLocalharnessClientExit) => void): () => void;
  dispose(): Promise<void>;
}

function mapProcessResult(result: PluginProcessResult): AntigravityLocalharnessClientExit {
  const observed = result.termination.observed;
  if (observed.kind === 'exit') return { exitCode: observed.exitCode, signal: null };
  if (observed.kind === 'signal') return { exitCode: null, signal: observed.signal };
  return { exitCode: null, signal: null };
}

export async function openAntigravityNativeLocalharnessClient(params: Readonly<{
  exec: Pick<ExecService, 'clients'>;
  requestFrame: Uint8Array;
  signal?: AbortSignal;
}>): Promise<AntigravityLocalharnessClient> {
  const handle = await params.exec.clients.spawn({
    kind: 'loopbackWebSocketJson',
    launch: {
      executable: { kind: 'managedDependency', id: 'localharness' },
    },
    handshake: {
      framing: 'lengthPrefix',
      byteOrder: 'little-endian',
      requestFrames: [params.requestFrame],
      decodeResponse: decodeAntigravityLocalharnessEndpoint,
    },
    maxFrameBytes: 1024 * 1024,
  }, params.signal ? { signal: params.signal } : undefined);
  const exit = handle.wait().then(mapProcessResult);

  return {
    async send(message) {
      await handle.client.send(AgentRuntimeJsonValueSchema.parse(message));
    },
    subscribe(listener) {
      const subscription = handle.client.subscribe(listener);
      return () => { subscription.dispose(); };
    },
    onExit(listener) {
      let subscribed = true;
      void exit.then((result) => {
        if (subscribed) listener(result);
      });
      return () => { subscribed = false; };
    },
    async dispose() {
      await handle.dispose();
    },
  };
}
