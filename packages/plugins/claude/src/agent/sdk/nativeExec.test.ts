import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginExecService,
} from '@happier-dev/plugin-sdk/runtime';

import { createClaudeNativeSdkQueryContext } from './nativeExec.js';

describe('createClaudeNativeSdkQueryContext', () => {
  it('projects the canonical Claude query environment into the declared system CLI launch', async () => {
    const spawnFailure = new Error('stop after observing the launch');
    const resolvedExecutable = Object.freeze({
      kind: 'systemTool' as const,
      id: 'claude-cli',
    });
    const callOrder: string[] = [];
    const resolveSystemTool = vi.fn(async () => {
      callOrder.push('resolve');
      return {
        executable: resolvedExecutable,
        executablePath: '/tmp/fake-claude.js',
      };
    });
    const spawn = vi.fn(async (protocolSpec: Parameters<PluginExecService['clients']['spawn']>[0]) => {
      expect(callOrder).toEqual(['resolve']);
      expect(protocolSpec.launch.executable).toBe(resolvedExecutable);
      callOrder.push('spawn');
      throw spawnFailure;
    });
    // Genuine host-service boundary fixture: system-tool resolution and protocol-client spawn.
    const exec = {
      systemTools: { resolve: resolveSystemTool },
      clients: { spawn },
    } as unknown as PluginExecService;
    const context = createClaudeNativeSdkQueryContext(exec);

    await expect(context.spawnClient({
      launch: {
        kind: 'agent-cli',
        agentId: 'claude',
        args: ['--output-format', 'stream-json'],
        cwd: '/tmp/workspace',
        env: {
          USER: 'local-claude-user',
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
        },
      },
      transport: {
        kind: 'stdio',
        framing: { kind: 'strict-lf-json' },
      },
      protocol: { kind: 'json-stream' },
    })).rejects.toBe(spawnFailure);

    expect(resolveSystemTool).toHaveBeenCalledWith({
      toolId: 'claude-cli',
      purpose: 'Launch Claude Code SDK session',
      cwd: '/tmp/workspace',
    });
    expect(spawn).toHaveBeenCalledWith({
      kind: 'jsonStream',
      launch: {
        executable: resolvedExecutable,
        args: ['--output-format', 'stream-json'],
        cwd: { root: 'workspace', relativePath: '' },
        env: {
          USER: 'local-claude-user',
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
        },
      },
      maxFrameBytes: 32 * 1024 * 1024,
    }, undefined);
    expect(callOrder).toEqual(['resolve', 'spawn']);
  });

  it('does not spawn when the declared Claude system tool cannot be resolved', async () => {
    const resolutionFailure = new Error('Claude system tool unavailable');
    const spawn = vi.fn();
    const exec = {
      systemTools: {
        resolve: vi.fn(async () => {
          throw resolutionFailure;
        }),
      },
      clients: { spawn },
    } as unknown as PluginExecService;

    await expect(createClaudeNativeSdkQueryContext(exec).spawnClient({
      launch: {
        kind: 'agent-cli',
        agentId: 'claude',
      },
      transport: {
        kind: 'stdio',
        framing: { kind: 'strict-lf-json' },
      },
      protocol: { kind: 'json-stream' },
    })).rejects.toBe(resolutionFailure);

    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not spawn when Claude system-tool resolution is cancelled', async () => {
    const controller = new AbortController();
    const cancellation = new Error('cancel Claude system-tool resolution');
    controller.abort(cancellation);
    const spawn = vi.fn();
    const resolveSystemTool = vi.fn(async (
      request: Parameters<PluginExecService['systemTools']['resolve']>[0],
    ) => {
      request.signal?.throwIfAborted();
      throw new Error('expected the aborted signal to stop resolution');
    });
    const exec = {
      systemTools: { resolve: resolveSystemTool },
      clients: { spawn },
    } as unknown as PluginExecService;

    await expect(createClaudeNativeSdkQueryContext(exec).spawnClient({
      launch: {
        kind: 'agent-cli',
        agentId: 'claude',
      },
      transport: {
        kind: 'stdio',
        framing: { kind: 'strict-lf-json' },
      },
      protocol: { kind: 'json-stream' },
    }, { signal: controller.signal })).rejects.toBe(cancellation);

    expect(resolveSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'claude-cli',
      signal: controller.signal,
    }));
    expect(spawn).not.toHaveBeenCalled();
  });

  it('preserves the host JSON-stream pre-write phase for Claude prompt classification', async () => {
    const preWriteFailure = new PluginError({
      code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
      message: 'record exceeded the host frame limit',
      details: {
        jsonStreamWriteOutcome: 'rejected_before_write',
      },
    });
    const handle = {
      client: {
        write: vi.fn(async () => {
          throw preWriteFailure;
        }),
        subscribe: vi.fn(() => ({ dispose() {} })),
      },
      process: {
        pid: 123,
        write: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      },
      wait: vi.fn(() => new Promise(() => undefined)),
      dispose: vi.fn(async () => undefined),
    };
    const exec = {
      systemTools: {
        resolve: vi.fn(async () => ({
          executable: { kind: 'systemTool', id: 'claude-cli' },
          executablePath: '/tmp/fake-claude.js',
        })),
      },
      clients: {
        spawn: vi.fn(async () => handle),
      },
    } as unknown as PluginExecService;
    const context = createClaudeNativeSdkQueryContext(exec);
    const clientHandle = await context.spawnClient({
      launch: {
        kind: 'agent-cli',
        agentId: 'claude',
      },
      transport: {
        kind: 'stdio',
        framing: { kind: 'strict-lf-json' },
      },
      protocol: { kind: 'json-stream' },
    });

    await expect(clientHandle.client.writeRecord({ type: 'user' })).resolves.toEqual({
      kind: 'rejected_before_write',
      error: preWriteFailure,
    });
  });
});
