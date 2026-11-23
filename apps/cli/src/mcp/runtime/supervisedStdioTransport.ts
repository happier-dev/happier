import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Readable } from 'node:stream';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import type { McpServerConfig } from '@/agent';
import type { AgentLaunchSelectedMaterial } from '@/daemon/agentIsolation/agentLaunchFrame';
import type { AgentLaunchMaterializationTarget } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { buildScopedProcessEnv, type ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import type { SupervisedPluginProcess } from '@/plugins/runtime/exec/processSupervisor';
import { spawnAuthorizedHostExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';

/** Supplied by the admitted host operation. Config is data, never authority. */
export type PreparedMcpStdioTransport = Readonly<{ transport: Transport; stderr?: Readable }>;
export type PrepareMcpStdioTransport = (config: McpServerConfig, signal?: AbortSignal) => Promise<PreparedMcpStdioTransport>;

/** Host-resolved MCP configuration consumes the same final launch owner as Exec.
 * SDK default environment inheritance remains underneath authored values. */
export async function prepareHostMcpStdioTransport(input: Readonly<{
  command: string;
  args?: readonly string[];
  environment: ProcessEnvInput;
  cwd?: string;
  signal?: AbortSignal;
}>): Promise<PreparedMcpStdioTransport> {
  input.signal?.throwIfAborted();
  const { getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  input.signal?.throwIfAborted();
  const environment = buildScopedProcessEnv({ baseEnv: getDefaultEnvironment(), explicitEnv: input.environment });
  const invocation = resolveWindowsCommandInvocation({ command: input.command, args: input.args ?? [], env: environment });
  const process = spawnAuthorizedHostExecLaunchForHost({ command: invocation.command, args: invocation.args,
    env: environment, ...(input.cwd === undefined ? {} : { cwd: input.cwd }), maxStdoutBytes: 0, maxStderrBytes: 0,
    ...(invocation.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
    release: () => undefined }, { signal: input.signal });
  return { transport: createSupervisedMcpStdioTransport(process), stderr: process.child.stderr };
}

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
  type StdioCodec = typeof import('@modelcontextprotocol/sdk/shared/stdio.js');
  let codec: Readonly<{ buffer: InstanceType<StdioCodec['ReadBuffer']>; serializeMessage: StdioCodec['serializeMessage'] }> | undefined;
  let started = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  const error = (value: unknown) => value instanceof Error ? value : new Error('mcp_stdio_transport_failed');
  const receive = (chunk: Buffer) => {
    if (!codec) return;
    codec.buffer.append(chunk);
    try {
      let message;
      while ((message = codec.buffer.readMessage()) !== null) transport.onmessage?.(message);
    } catch (cause) { transport.onerror?.(error(cause)); }
  };
  const onError = (cause: Error) => { if (!closed) transport.onerror?.(cause); };
  const finish = () => {
    if (closed) return;
    closed = true;
    process.child.stdout.off('data', receive);
    process.child.off('error', onError);
    process.child.stdin.off('error', onError);
    codec?.buffer.clear();
    transport.onclose?.();
  };
  const transport: Transport = {
    async start() {
      if (started || closed) throw new Error('mcp_stdio_transport_already_started');
      started = true;
      const { ReadBuffer, serializeMessage } = await import('@modelcontextprotocol/sdk/shared/stdio.js');
      if (closed) throw new Error('mcp_stdio_transport_not_open');
      codec = { buffer: new ReadBuffer(), serializeMessage };
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
      if (!codec || closed) throw new Error('mcp_stdio_transport_not_open');
      await process.handle.write(Buffer.from(codec.serializeMessage(message), 'utf8'));
    },
    close() {
      return closing ??= (async () => {
        try { await process.dispose(); } finally { finish(); }
      })();
    },
  };
  return transport;
}
