import { describe, expect, it, vi } from 'vitest';

import type { StartedDaemon } from '../../daemon/daemon';
import type { SpawnedProcess } from '../../process/spawnProcess';
import { launchProviderHarnessSession } from './launchProviderHarnessSession';

function createDaemon(): StartedDaemon {
  return {
    state: {
      pid: 42,
      httpPort: 4231,
      controlToken: 'daemon-token',
    },
  } as StartedDaemon;
}

describe('launchProviderHarnessSession', () => {
  it('launches native ACP Agents through the daemon-owned existing-session route', async () => {
    const daemon = createDaemon();
    const spawnFromDaemon = vi.fn(async () => 'session-123');
    const spawnDirect = vi.fn(() => {
      throw new Error('direct provider CLI launch must not run for native ACP Agents');
    });

    await expect(launchProviderHarnessSession({
      providerId: 'grok',
      agentId: 'grok',
      providerProtocol: 'acp',
      daemon,
      directory: '/tmp/workspace',
      existingSessionId: 'session-123',
      resume: 'grok-provider-session',
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 123,
      modelId: 'grok-4.5',
      modelUpdatedAt: 456,
      environmentVariables: {
        HAPPIER_HOME_DIR: '/tmp/happier',
        HAPPIER_SESSION_ATTACH_FILE: '/tmp/direct-process-only-attach.json',
        HAPPIER_STACK_TOOL_TRACE_FILE: '/tmp/tooltrace.jsonl',
        UNDEFINED_VALUE: undefined,
      },
      spawnFromDaemon,
      spawnDirect,
    })).resolves.toEqual({ process: null });

    expect(spawnDirect).not.toHaveBeenCalled();
    expect(spawnFromDaemon).toHaveBeenCalledExactlyOnceWith({
      daemon,
      directory: '/tmp/workspace',
      agent: 'grok',
      request: {
        existingSessionId: 'session-123',
        resume: 'grok-provider-session',
        terminal: { mode: 'plain' },
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 123,
        modelId: 'grok-4.5',
        modelUpdatedAt: 456,
        environmentVariables: {
          HAPPIER_HOME_DIR: '/tmp/happier',
          HAPPIER_STACK_TOOL_TRACE_FILE: '/tmp/tooltrace.jsonl',
        },
      },
    });
  });

  it('fails closed when daemon spawn resolves a different Happier session', async () => {
    await expect(launchProviderHarnessSession({
      providerId: 'grok',
      agentId: 'grok',
      providerProtocol: 'acp',
      daemon: createDaemon(),
      directory: '/tmp/workspace',
      existingSessionId: 'session-123',
      environmentVariables: {},
      spawnFromDaemon: vi.fn(async () => 'session-other'),
      spawnDirect: vi.fn(() => {
        throw new Error('unexpected direct launch');
      }),
    })).rejects.toThrow('expected existing session session-123, received session-other');
  });

  it('does not fall back to direct launch when the native ACP daemon owner is missing', async () => {
    const spawnDirect = vi.fn(() => {
      throw new Error('unexpected direct launch');
    });

    await expect(launchProviderHarnessSession({
      providerId: 'grok',
      agentId: 'grok',
      providerProtocol: 'acp',
      daemon: null,
      directory: '/tmp/workspace',
      existingSessionId: 'session-123',
      environmentVariables: {},
      spawnDirect,
    })).rejects.toThrow('requires a running daemon for native ACP Agent grok');

    expect(spawnDirect).not.toHaveBeenCalled();
  });

  it('retains direct launch for the non-ACP Claude harness lane', async () => {
    const process = {
      child: {} as SpawnedProcess['child'],
      stdoutPath: '/tmp/provider-harness-stdout.log',
      stderrPath: '/tmp/provider-harness-stderr.log',
      stop: vi.fn(async () => {}),
    } satisfies SpawnedProcess;
    const spawnDirect = vi.fn(() => process);
    const spawnFromDaemon = vi.fn();

    await expect(launchProviderHarnessSession({
      providerId: 'claude',
      agentId: 'claude',
      providerProtocol: 'claude',
      daemon: null,
      directory: '/tmp/workspace',
      existingSessionId: 'session-123',
      environmentVariables: {},
      spawnFromDaemon,
      spawnDirect,
    })).resolves.toEqual({ process });

    expect(spawnDirect).toHaveBeenCalledOnce();
    expect(spawnFromDaemon).not.toHaveBeenCalled();
  });

  it('uses the canonical Agent id when a fixture provider has a distinct scenario identity', async () => {
    const daemon = createDaemon();
    const spawnFromDaemon = vi.fn(async () => 'session-123');

    await launchProviderHarnessSession({
      providerId: 'opencode_server',
      agentId: 'opencode',
      providerProtocol: 'acp',
      daemon,
      directory: '/tmp/workspace',
      existingSessionId: 'session-123',
      environmentVariables: {},
      spawnFromDaemon,
      spawnDirect: vi.fn(() => {
        throw new Error('unexpected direct launch');
      }),
    });

    expect(spawnFromDaemon).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'opencode',
    }));
  });
});
