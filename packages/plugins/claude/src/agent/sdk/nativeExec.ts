import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agent-runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginExecService,
  PluginProcessResult,
  PluginProtocolClientHandle,
} from '@happier-dev/plugin-sdk/runtime';

import type {
  ClaudeSdkExecClientHandle,
  ClaudeSdkExecResult,
  ClaudeSdkJsonStreamClient,
  ClaudeSdkQueryContext,
} from './query.js';

const CLAUDE_SDK_MAX_FRAME_BYTES = 32 * 1024 * 1024;

function readJsonStreamWriteOutcome(error: unknown): 'rejected_before_write' | 'write_may_have_occurred' | null {
  if (
    !(error instanceof PluginError)
    || !error.details
    || typeof error.details !== 'object'
    || !('jsonStreamWriteOutcome' in error.details)
  ) {
    return null;
  }
  const outcome = error.details.jsonStreamWriteOutcome;
  return outcome === 'rejected_before_write' || outcome === 'write_may_have_occurred'
    ? outcome
    : null;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function toClaudeSdkExecResult(result: PluginProcessResult): ClaudeSdkExecResult {
  const observed = result.termination.observed;
  return {
    exitCode: observed.kind === 'exit' ? observed.exitCode : null,
    signal: observed.kind === 'signal' ? observed.signal : null,
    stdout: decode(result.stdout),
    stderr: observed.kind === 'failed'
      ? [decode(result.stderr), observed.diagnostic.message].filter(Boolean).join('\n')
      : decode(result.stderr),
  };
}

export function createClaudeNativeSdkQueryContext(exec: PluginExecService): ClaudeSdkQueryContext {
  return Object.freeze({
    async spawnClient(spec, options): Promise<ClaudeSdkExecClientHandle> {
      if (spec.launch.kind !== 'agent-cli' || spec.launch.agentId !== 'claude') {
        throw new Error('Claude native SDK execution requires the declared claude agent CLI.');
      }
      const resolvedExecutable = await exec.systemTools.resolve({
        toolId: 'claude-cli',
        purpose: 'Launch Claude Code SDK session',
        ...(spec.launch.cwd ? { cwd: spec.launch.cwd } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const handle = await exec.clients.spawn({
        kind: 'jsonStream',
        launch: {
          executable: resolvedExecutable.executable,
          args: spec.launch.args,
          cwd: { root: 'workspace', relativePath: '' },
          ...(spec.launch.env ? { env: spec.launch.env } : {}),
        },
        maxFrameBytes: CLAUDE_SDK_MAX_FRAME_BYTES,
      }, options?.signal ? { signal: options.signal } : undefined) as PluginProtocolClientHandle<'jsonStream'>;
      let status: 'running' | 'exited' | 'disposed' = 'running';
      const exit = handle.wait().then((result) => {
        status = 'exited';
        return toClaudeSdkExecResult(result);
      });
      const client: ClaudeSdkJsonStreamClient = {
        closed: exit.then(() => undefined),
        subscribe(listener) {
          const subscription = handle.client.subscribe(listener);
          return () => subscription.dispose();
        },
        async writeRecord(record) {
          const parsedRecord = AgentRuntimeJsonValueSchema.safeParse(record);
          if (!parsedRecord.success) {
            return {
              kind: 'rejected_before_write',
              error: parsedRecord.error,
            };
          }
          try {
            await handle.client.write(parsedRecord.data);
            return { kind: 'written' };
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            return {
              kind: readJsonStreamWriteOutcome(error) ?? 'write_may_have_occurred',
              error: failure,
            };
          }
        },
      };
      return {
        client,
        process: {
          pid: handle.process.pid,
          exit,
          async writeStdin(input) {
            await handle.process.write(typeof input === 'string' ? new TextEncoder().encode(input) : input);
          },
          kill() {
            void handle.process.dispose();
          },
          async dispose() {
            await handle.process.dispose();
          },
        },
        get status() {
          return status;
        },
        onExit(listener) {
          let subscribed = true;
          void exit.then((result) => {
            if (subscribed) listener(result);
          });
          return () => { subscribed = false; };
        },
        async dispose() {
          status = 'disposed';
          await handle.dispose();
        },
      };
    },
  });
}
