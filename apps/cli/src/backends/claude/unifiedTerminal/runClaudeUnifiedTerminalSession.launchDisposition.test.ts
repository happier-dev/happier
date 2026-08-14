import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFile, stat, unlink } from 'node:fs/promises';

import type {
  TerminalAttachmentId,
  TerminalHostAdapter,
  TerminalHostHandle,
} from '@/integrations/terminalHost/_types';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import { runClaudeUnifiedTerminalSession } from './runClaudeUnifiedTerminalSession';
import { buildClaudeUnifiedTerminalSpawn } from './buildClaudeUnifiedTerminalSpawn';

const attachmentId = 'attachment-adopted-resume' as TerminalAttachmentId;
const existingHandle: TerminalHostHandle = {
  attachmentId,
  kind: 'tmux',
  sessionName: 'happier-adopted-resume',
  paneId: '%1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};
const existingAttachment: TerminalAttachmentInfo = {
  version: 2,
  attachmentId,
  sessionId: 'happy-adopted-resume',
  handle: existingHandle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
  terminal: {
    mode: 'tmux',
    tmux: { target: 'happier-adopted-resume:%1' },
  },
  updatedAt: 1,
};

function createAdapter(overrides: Partial<TerminalHostAdapter> = {}): TerminalHostAdapter {
  return {
    kind: 'tmux',
    createOrAttachHost: vi.fn(async () => existingHandle),
    injectUserPrompt: vi.fn(async () => ({
      status: 'injected' as const,
      at: Date.now(),
      bytesWritten: 0,
    })),
    interruptTurn: vi.fn(async () => undefined),
    evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

function baseOptions(
  adapter: TerminalHostAdapter,
  abortController: AbortController,
): Parameters<typeof runClaudeUnifiedTerminalSession>[0] {
  return {
    path: '/workspace/project',
    happySessionId: 'happy-adopted-resume',
    sessionId: 'claude-resume-id',
    initialMode: {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'tmux',
    },
    nextMessage: async () => null,
    signal: abortController.signal,
    resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
    readTerminalHostAttachmentInfo: async () => null,
    buildSpawn: async () => ({ spawnArgv: ['/bin/claude', '--resume', 'claude-resume-id'], spawnEnv: {} }),
    createSessionName: () => 'happier-fresh-resume',
    processSignals: null,
    createController: async () => ({
      run: async () => undefined,
      dispose: async () => undefined,
    }),
  };
}

describe('runClaudeUnifiedTerminalSession launch disposition', () => {
  it('destroys the exact owned host once when explicit runner stop is requested', async () => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => {
        storedAttachment = null;
      },
      onTerminalHostReady: async ({ destroyOwnedHostForExplicitStop }) => {
        try {
          expect(destroyOwnedHostForExplicitStop).toBeTypeOf('function');
          await destroyOwnedHostForExplicitStop();
          await destroyOwnedHostForExplicitStop();
        } finally {
          abortController.abort();
        }
      },
    });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(existingHandle);
    expect(storedAttachment).toBeNull();
  });

  it('preserves the owned host when the runner wrapper exits without explicit stop', async () => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => {
        storedAttachment = null;
      },
      onTerminalHostReady: async () => {
        abortController.abort();
      },
    });

    expect(dispose).not.toHaveBeenCalled();
    expect(storedAttachment).not.toBeNull();
  });

  it('preserves the owned host when the runner receives a process signal', async () => {
    const abortController = new AbortController();
    const processSignals = new EventEmitter();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      processSignals,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => {
        storedAttachment = null;
      },
      onTerminalHostReady: async () => {
        processSignals.emit('SIGTERM');
      },
    });

    expect(dispose).not.toHaveBeenCalled();
    expect(storedAttachment).not.toBeNull();
  });

  it('does not report a provider launch when it adopts the exact live terminal attachment', async () => {
    const abortController = new AbortController();
    const onProviderLaunchStarting = vi.fn(async () => undefined);
    const adoptExistingHost = vi.fn(async () => {
      abortController.abort();
      return existingHandle;
    });
    const createOrAttachHost = vi.fn(async () => existingHandle);
    const adapter = createAdapter({ adoptExistingHost, createOrAttachHost });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      expectedExistingTerminalHostAttachmentId: attachmentId,
      readTerminalHostAttachmentInfo: async () => existingAttachment,
      onProviderLaunchStarting,
    });

    expect(adoptExistingHost).toHaveBeenCalledWith(existingHandle);
    expect(createOrAttachHost).not.toHaveBeenCalled();
    expect(onProviderLaunchStarting).not.toHaveBeenCalled();
  });

  it('reports one provider launch immediately before a fresh create with spawn argv', async () => {
    const abortController = new AbortController();
    const calls: string[] = [];
    const cleanupUnreadArtifacts = vi.fn(async () => undefined);
    const onProviderLaunchStarting = vi.fn(async () => {
      calls.push('launch_starting');
    });
    const createOrAttachHost = vi.fn(async (options) => {
      calls.push(`create:${options.spawnArgv.join(' ')}`);
      abortController.abort();
      return existingHandle;
    });
    const adapter = createAdapter({ createOrAttachHost });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude', '--resume', 'claude-resume-id'],
        spawnEnv: {},
        launchSpecPath: '/synthetic/launch.json',
        cleanupUnreadArtifacts,
      }),
      onProviderLaunchStarting,
    });

    expect(onProviderLaunchStarting).toHaveBeenCalledTimes(1);
    expect(createOrAttachHost).toHaveBeenCalledTimes(1);
    expect(cleanupUnreadArtifacts).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'launch_starting',
      'create:/bin/claude --resume claude-resume-id',
    ]);
  });

  it('reports one provider launch immediately before confirmed-dead adoption fallback creates', async () => {
    const abortController = new AbortController();
    const calls: string[] = [];
    const onProviderLaunchStarting = vi.fn(async () => {
      calls.push('launch_starting');
    });
    const createOrAttachHost = vi.fn(async (options) => {
      calls.push(`create:${options.spawnArgv.join(' ')}`);
      abortController.abort();
      return existingHandle;
    });
    const adapter = createAdapter({
      adoptExistingHost: vi.fn(async () => {
        throw new Error('adoption failed after the host exited');
      }),
      createOrAttachHost,
      evaluateLiveness: vi.fn()
        .mockResolvedValueOnce({ paneAlive: true, observedAt: 1 })
        .mockResolvedValueOnce({ paneAlive: false, paneDead: true, observedAt: 2 }),
    });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      expectedExistingTerminalHostAttachmentId: attachmentId,
      readTerminalHostAttachmentInfo: async () => existingAttachment,
      removeTerminalHostAttachmentInfo: vi.fn(async () => undefined),
      onProviderLaunchStarting,
    });

    expect(onProviderLaunchStarting).toHaveBeenCalledTimes(1);
    expect(createOrAttachHost).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'launch_starting',
      'create:/bin/claude --resume claude-resume-id',
    ]);
  });

  it('removes private MCP spawn artifacts when host creation fails before launch-spec handoff', async () => {
    const abortController = new AbortController();
    const adapter = createAdapter({
      createOrAttachHost: vi.fn(async () => {
        throw new Error('synthetic host creation failure');
      }),
    });
    let launchSpecPath: string | undefined;
    let mcpConfigPath: string | undefined;

    try {
      await expect(runClaudeUnifiedTerminalSession({
        ...baseOptions(adapter, abortController),
        happierMcpConfigJson: JSON.stringify({
          mcpServers: {
            fixture: {
              command: 'synthetic-mcp-server',
              env: { TOKEN: 'synthetic-pre-handoff-marker' },
            },
          },
        }),
        buildSpawn: async (params) => {
          const spawn = await buildClaudeUnifiedTerminalSpawn({
            ...params,
            deps: {
              resolveClaudeCliPath: () => '/synthetic/claude',
              isClaudeCliJavaScriptFile: () => false,
              ensureClaudeJsRuntimeExecutable: async () => '/synthetic/runtime',
              terminalLaunchSpecRunnerPath: '/synthetic/terminal-launch-spec-runner.cjs',
              resolveCommandInvocation: ({ command, args }) => ({ command, args }),
            },
          });
          launchSpecPath = spawn.launchSpecPath;
          const launchSpec = JSON.parse(await readFile(launchSpecPath!, 'utf8')) as { args?: string[] };
          const mcpConfigIndex = launchSpec.args?.indexOf('--mcp-config') ?? -1;
          mcpConfigPath = launchSpec.args?.[mcpConfigIndex + 1];
          expect(JSON.stringify(launchSpec.args)).not.toContain('synthetic-pre-handoff-marker');
          await expect(readFile(mcpConfigPath!, 'utf8')).resolves.toContain('synthetic-pre-handoff-marker');
          return spawn;
        },
      })).rejects.toThrow('synthetic host creation failure');

      expect(launchSpecPath).toBeTruthy();
      expect(mcpConfigPath).toBeTruthy();
      await expect(stat(launchSpecPath!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(mcpConfigPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (mcpConfigPath) await unlink(mcpConfigPath).catch(() => undefined);
      if (launchSpecPath) await unlink(launchSpecPath).catch(() => undefined);
    }
  });
});
