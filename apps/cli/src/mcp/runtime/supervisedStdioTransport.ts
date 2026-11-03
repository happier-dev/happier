import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Readable } from 'node:stream';
import type { McpServerConfig } from '@/agent';
import type { AgentLaunchSelectedMaterial } from '@/daemon/agentIsolation/agentLaunchFrame';
import type { AgentLaunchMaterializationTarget } from '@/daemon/agentIsolation/agentLaunchMaterials';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import type { SupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';

/** Supplied by the admitted host operation. Config is data, never authority. */
export type PreparedMcpStdioTransport = Readonly<{ transport: Transport; stderr?: Readable }>;
export type PrepareMcpStdioTransport = (config: McpServerConfig, signal?: AbortSignal) => Promise<PreparedMcpStdioTransport>;

/** One admitted native/material owner, shared by Agent-side launch config and
 * runner-side custom tools. No caller chooses identity through this port. */
export type AdmittedMcpStdioRuntime = Readonly<{
  target: AgentLaunchMaterializationTarget;
  environment: ProcessEnvInput;
  prepareTransport(input: Readonly<{ config: McpServerConfig;
    selectedMaterials: readonly AgentLaunchSelectedMaterial[]; signal?: AbortSignal }>): Promise<PreparedMcpStdioTransport>;
}>;

/** Adapts an already admitted, supervised process; never selects launch authority.
 * The supervisor writes its host preamble before handle.write accepts MCP input. */
export function createSupervisedMcpStdioTransport(process: SupervisedPluginProcess): Transport {
  const buffer = new ReadBuffer();
  let started = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  const error = (value: unknown) => value instanceof Error ? value : new Error('mcp_stdio_transport_failed');
  const receive = (chunk: Buffer) => {
    buffer.append(chunk);
    try {
      let message;
      while ((message = buffer.readMessage()) !== null) transport.onmessage?.(message);
    } catch (cause) { transport.onerror?.(error(cause)); }
  };
  const onError = (cause: Error) => { if (!closed) transport.onerror?.(cause); };
  const finish = () => {
    if (closed) return;
    closed = true;
    process.child.stdout.off('data', receive);
    process.child.off('error', onError);
    process.child.stdin.off('error', onError);
    buffer.clear();
    transport.onclose?.();
  };
  const transport: Transport = {
    async start() {
      if (started || closed) throw new Error('mcp_stdio_transport_already_started');
      started = true;
      process.child.stdout.on('data', receive);
      process.child.on('error', onError);
      process.child.stdin.on('error', onError);
      void process.handle.wait().then(result => {
        const observed = result.termination.observed;
        if (!closed && observed.kind === 'failed') transport.onerror?.(new Error(observed.diagnostic.code));
        finish();
      }, cause => { if (!closed) transport.onerror?.(error(cause)); finish(); });
    },
    async send(message) {
      if (!started || closed) throw new Error('mcp_stdio_transport_not_open');
      await process.handle.write(Buffer.from(serializeMessage(message), 'utf8'));
    },
    close() {
      return closing ??= (async () => {
        try { await process.dispose(); } finally { finish(); }
      })();
    },
  };
  return transport;
}
