import { vi } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountBindingEvent } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginProtocolClientHandle, PluginProtocolClientSpec } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

export function hostBoundaries(signal = new AbortController().signal, sessionState: JsonValue = { sessionId: 'pi-shared' }) {
  const subscriptions: { listener: (event?: ConnectedAccountBindingEvent) => void | Promise<void>; dispose: ReturnType<typeof vi.fn> }[] = [];
  const getBinding = vi.fn<AgentSessionRuntimeContext['services']['connectedAccounts']['getBinding']>()
    .mockResolvedValue(null);
  let listener: ((record: unknown) => void | Promise<void>) | undefined;
  let finish!: (result: PluginProcessResult) => void;
  const exited = new Promise<PluginProcessResult>((resolve) => { finish = resolve; });
  const disposeProcess = vi.fn(async () => {
    finish({
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    });
  });
  // The native process speaks Pi RPC; preparation, assets, client and operations stay real.
  const write = vi.fn(async (record: JsonValue) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Expected Pi RPC command');
    await listener?.({ type: 'response', id: record.id, command: record.type, success: true,
      data: record.type === 'get_state' ? sessionState : { commands: [] } });
  });
  const handle: PluginProtocolClientHandle<'jsonStream'> = {
    client: {
      subscribe(handler) { listener = handler; return { dispose() { listener = undefined; } }; },
      write,
      dispose: disposeProcess,
    },
    process: { pid: 123, write: async () => {}, closeStdin: async () => {}, async waitForExit() { return (await this.wait()).termination; },
    wait: () => exited,
      onOutput: () => ({ dispose() {} }), dispose: disposeProcess },
    wait: () => exited,
    dispose: disposeProcess,
  };
  const spawn = vi.fn(async (_spec: Extract<PluginProtocolClientSpec, { kind: 'jsonStream' }>) => handle);
  const context = {
    signal,
    services: {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      connectedAccounts: {
        watch(_purpose: string, callback: (event: ConnectedAccountBindingEvent) => void | Promise<void>) {
          let disposed = false;
          const subscription = { listener: (event: ConnectedAccountBindingEvent = { kind: 'resync', authorityChanged: true }) => disposed ? undefined : callback(event), dispose: vi.fn(() => { disposed = true; }) };
          subscriptions.push(subscription);
          void callback({ kind: 'resync', authorityChanged: false });
          return subscription;
        },
        getBinding,
      },
      exec: {
        async run() { return {
          termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
          stdout: new TextEncoder().encode('0.82.1'), stderr: new Uint8Array(),
          stdoutTruncated: false, stderrTruncated: false,
        }; },
        systemTools: { resolve: vi.fn(async () => ({
          executable: { kind: 'systemTool', id: 'pi-cli' }, executablePath: '/fixture/pi',
        })) },
        clients: { spawn },
      },
    },
    session: { id: 'pi-engine-session', services: {} },
  // Only the Account and OS service members reached by these tests are supplied.
  } as unknown as AgentSessionRuntimeContext;
  return {
    context, subscriptions, getBinding, spawn, write, disposeProcess,
    async emit(record: JsonValue) { await listener?.(record); },
  };
}
