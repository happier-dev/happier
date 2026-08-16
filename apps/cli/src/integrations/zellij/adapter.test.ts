import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudePromptSubmitVerificationPolicy } from '@/backends/claude/unifiedTerminal/claudePromptSubmitVerification';

const recordTerminalHostKillAudit = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/sessionKillAudit', () => ({
  recordTerminalHostKillAudit,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: loggerWarn,
  },
}));

import { createZellijTerminalHostAdapter as createZellijTerminalHostAdapterBase } from './adapter';
import {
  DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE,
  ZellijActionTimeoutError,
  type ZellijActions,
  type ZellijPane,
} from './actions';
import { prepareZellijSocketDir, resolveZellijSocketDir } from './socketDir';
import { isTerminalHostStartupError } from '../terminalHost/errors';

const skipPrepareZellijSocketDir = async (): Promise<void> => {};

// The real adapter derives death evidence from the on-disk zellij server socket before probing the
// client. Tests exercise a live-server world by default (socket present); the socket-absence cases
// override this explicitly.
const alwaysPresentSocket = async (): Promise<'present'> => 'present';

function createZellijTerminalHostAdapter(
  params: Parameters<typeof createZellijTerminalHostAdapterBase>[0],
) {
  return createZellijTerminalHostAdapterBase({
    prepareSocketDir: skipPrepareZellijSocketDir,
    inspectSocketPresence: alwaysPresentSocket,
    ...params,
  });
}

function createClaudeZellijTerminalHostAdapter(
  params: Parameters<typeof createZellijTerminalHostAdapterBase>[0],
) {
  const policy = createClaudePromptSubmitVerificationPolicy();
  return createZellijTerminalHostAdapter({
    ...params,
    promptSubmitVerification: {
      ...policy,
      isPromptStagedBeforeSubmit: () => true,
    },
  });
}

describe('createZellijTerminalHostAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
    recordTerminalHostKillAudit.mockReset();
    loggerWarn.mockReset();
  });

  it('starts the requested spawn command inside the background session', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async (params) => {
        calls.push([
          'attach',
          params.sessionName,
          params.env.ZELLIJ_SOCKET_DIR ?? '',
          params.env.ZELLIJ_SESSION_NAME ?? '',
          params.env.HAPPIER_CLAUDE_PATH ?? '',
        ].join(':'));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async (params) => {
        calls.push([
          'run',
          params.sessionName,
          params.env.ZELLIJ_SOCKET_DIR ?? '',
          params.env.ZELLIJ_SESSION_NAME ?? '',
          params.command.join('|'),
          params.env.HAPPIER_CLAUDE_PATH ?? '',
        ].join(':'));
        return { exitCode: 0, stdout: 'terminal_42\n', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        return listCount === 1 ? [] : [{ id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' }];
      },
      dumpScreen: async (params) => {
        calls.push(`dump:${params.paneId}`);
        return '';
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      runCommand(params: {
        zellijBinary: string;
        env: Readonly<Record<string, string>>;
        sessionName: string;
        cwd?: string;
        command: readonly string[];
      }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };
      const adapter = createZellijTerminalHostAdapter({
        zellijBinary: '/tools/zellij',
        happyHomeDir: '/home/happier',
        actions,
      });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs', '--model', 'sonnet'],
      spawnEnv: {
        HAPPIER_CLAUDE_PATH: '/opt/claude/cli.js',
      },
      isolatedEnv: true,
    });

    const socketDir = join('/home/happier', 'zellij-sock');
    expect(calls).toEqual([
      `attach:session-a:${socketDir}::`,
      `run:session-a:${socketDir}::/managed/node|claude_local_launcher.cjs|--model|sonnet:/opt/claude/cli.js`,
    ]);
    expect(handle.paneId).toBe('terminal_42');
    expect(handle.attachmentId).toEqual(expect.any(String));
    expect(handle.attachmentId).not.toHaveLength(0);
    expect(handle.attachMetadata).toEqual({
      attachStrategy: 'terminal_host',
      topology: 'shared',
      locality: 'same_machine',
      maxClients: null,
      requiresLocalAttachmentInfo: true,
      liveProbe: 'required',
    });
    });

  it('adopts an existing live zellij host without running a new command', async () => {
    const calls: string[] = [];
    const actions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host adoption');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host adoption');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host adoption');
      },
      listPanes: async () => [{ id: 7, is_plugin: false, is_focused: true, terminal_command: '/managed/node' }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions;
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij',
      sessionName: 'session-existing',
      paneId: '7',
      expectedCommandFragments: ['/managed/node'],
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    } as const;

    await expect(adapter.adoptExistingHost?.(handle)).resolves.toEqual(handle);

    expect(calls).toEqual([]);
  });

  it('does not expose a destructive live-host relaunch operation', () => {
    // Boundary fixture: no zellij action is invoked while inspecting the adapter surface.
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions: {} as ZellijActions,
    });
    expect('relaunchExistingHost' in adapter).toBe(false);
  });

  it('reports conclusive pane death without a client probe when the session socket is absent', async () => {
    let listPanesCalls = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      closePane: async () => undefined,
      listPanes: async () => {
        listPanesCalls += 1;
        // A gone zellij server never answers; the real client blocks forever (incident cmrdazlqm).
        throw new ZellijActionTimeoutError('list-panes');
      },
      dumpScreen: async () => '',
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      inspectSocketPresence: async () => 'absent',
    });

    const liveness = await adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-gone',
      paneId: 'terminal_1',
      socketDir: '/attached-root',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    });

    expect(liveness).toMatchObject({ paneAlive: false, paneDead: true });
    expect(liveness.probeInconclusive).toBeUndefined();
    expect(listPanesCalls).toBe(0);
  });

  it('binds liveness evidence and probes to the persisted zellij socket root after the current root moved', async () => {
    const inspectedSocketDirs: string[] = [];
    const probeSocketDirs: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      closePane: async () => undefined,
      listPanes: async (params) => {
        probeSocketDirs.push(params.env.ZELLIJ_SOCKET_DIR ?? '');
        return [{ pane_id: 'terminal_1', terminal_command: '/managed/node', exited: false }];
      },
      dumpScreen: async () => '',
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/current-home',
      actions,
      inspectSocketPresence: async ({ socketDir }) => {
        inspectedSocketDirs.push(socketDir);
        return socketDir === '/attached-root' ? 'present' : 'absent';
      },
    });

    await expect(adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-moved-root',
      paneId: 'terminal_1',
      socketDir: '/attached-root',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    })).resolves.toMatchObject({ paneAlive: true, paneDead: false });

    expect(inspectedSocketDirs).toEqual(['/attached-root']);
    expect(probeSocketDirs).toEqual(['/attached-root']);
  });

  it('treats socket absence for a legacy marker with no persisted root as inconclusive', async () => {
    let listPanesCalls = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      closePane: async () => undefined,
      listPanes: async () => {
        listPanesCalls += 1;
        throw new Error('zellij client cannot establish a session');
      },
      dumpScreen: async () => '',
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/current-home',
      actions,
      inspectSocketPresence: async () => 'absent',
    });

    const liveness = await adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'legacy-session',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    });

    expect(liveness).toMatchObject({ paneAlive: false, probeInconclusive: true });
    expect(liveness.paneDead).toBeUndefined();
    expect(listPanesCalls).toBe(1);
  });

  it('treats an ENOENT zellij probe spawn failure as inconclusive', async () => {
    const spawnError = Object.assign(new Error('spawn /deleted-snapshot/zellij ENOENT'), { code: 'ENOENT' });
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      closePane: async () => undefined,
      listPanes: async () => { throw spawnError; },
      dumpScreen: async () => '',
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/deleted-snapshot/zellij',
      happyHomeDir: '/current-home',
      actions,
      inspectSocketPresence: async () => 'present',
    });

    const liveness = await adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'spawn-missing',
      paneId: 'terminal_1',
      socketDir: '/attached-root',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    });

    expect(liveness).toMatchObject({ paneAlive: false, probeInconclusive: true });
    expect(liveness.paneDead).toBeUndefined();
  });

  it('keeps a socket-present probe timeout inconclusive (no false death on a wedged-but-alive host)', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      closePane: async () => undefined,
      listPanes: async () => {
        throw new ZellijActionTimeoutError('list-panes');
      },
      dumpScreen: async () => '',
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      inspectSocketPresence: async () => 'present',
    });

    const liveness = await adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-wedged',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    });

    expect(liveness).toMatchObject({ paneAlive: false, probeInconclusive: true });
    expect(liveness.paneDead).toBeUndefined();
  });

  it('wraps adopt probe timeouts as startup-attempt failures', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      closePane: async () => undefined,
      listPanes: async () => {
        throw new ZellijActionTimeoutError('list-panes');
      },
      dumpScreen: async () => '',
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
    });

    await expect(adapter.adoptExistingHost?.({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    })).rejects.toMatchObject({
      name: 'TerminalHostStartupError',
      reason: 'startup_action_timeout',
      diagnostics: expect.objectContaining({ action: 'list-panes', sessionName: 'session-a' }),
    });
  });

  it('starts foreground-attached sessions through an injected client launcher and detached command launcher', async () => {
    const calls: string[] = [];
    let launcherDisposed = false;
    let listCount = 0;
    let bootstrapClosed = false;
    const actions = {
      attachCreateBackground: async () => {
        throw new Error('should not create a background session');
      },
      runCommand: async () => {
        throw new Error('foreground launch should not await zellij run');
      },
      startCommandDetached: async (params: {
        sessionName: string;
        env: Readonly<Record<string, string>>;
        command: readonly string[];
        timeoutMs?: number;
      }) => {
        calls.push(`detached:${params.sessionName}:${params.env.ZELLIJ_SOCKET_DIR ?? ''}:${params.command.join('|')}:${params.timeoutMs ?? 'none'}`);
        return {
          pid: 12345,
          dispose: () => {
            launcherDisposed = true;
          },
        };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) {
          return [{ id: 1, is_plugin: false, terminal_command: null }];
        }
        if (bootstrapClosed) {
          return [{ id: 42, is_plugin: false, terminal_command: '/managed/node' }];
        }
        return [
          { id: 1, is_plugin: false, terminal_command: null },
          { id: 42, is_plugin: false, terminal_command: '/managed/node' },
        ];
      },
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
        bootstrapClosed = true;
      },
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      startCommandDetached(params: {
        sessionName: string;
        env: Readonly<Record<string, string>>;
        command: readonly string[];
        timeoutMs?: number;
      }): Promise<{ pid?: number; dispose(): void }>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 456,
      launchStrategy: {
        type: 'foregroundAttached',
        launchClient: async (params: {
          sessionName: string;
          env: Readonly<Record<string, string>>;
          cwd?: string;
          defaultShell?: string;
        }) => {
          calls.push(`foreground:${params.sessionName}:${params.env.ZELLIJ_SOCKET_DIR ?? ''}:${params.cwd ?? ''}:${params.defaultShell ?? ''}`);
        },
      },
      defaultShell: 'cmd.exe',
    } as Parameters<typeof createZellijTerminalHostAdapterBase>[0] & {
      launchStrategy: {
        type: 'foregroundAttached';
        launchClient(params: {
          sessionName: string;
          env: Readonly<Record<string, string>>;
          cwd?: string;
          defaultShell?: string;
        }): Promise<void>;
      };
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    const socketDir = join('/home/happier', 'zellij-sock');
    expect(calls).toEqual([
      `foreground:session-a:${socketDir}:/workspace/project:cmd.exe`,
      `detached:session-a:${socketDir}:/managed/node|claude_local_launcher.cjs:456`,
      'close:terminal_1',
    ]);
    expect(handle.paneId).toBe('terminal_42');
    expect(launcherDisposed).toBe(true);
  });

  it('rejects a foreground-attached launch when detached launcher cleanup removes the discovered command pane', async () => {
    let launcherDisposed = false;
    let bootstrapClosed = false;
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => {
        throw new Error('should not create a background session');
      },
      runCommand: async () => {
        throw new Error('foreground launch should not await zellij run');
      },
      startCommandDetached: async () => ({
        dispose: () => {
          launcherDisposed = true;
        },
      }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) {
          return [{ id: 1, is_plugin: false, terminal_command: null }];
        }
        if (launcherDisposed) {
          return bootstrapClosed ? [] : [{ id: 1, is_plugin: false, terminal_command: null }];
        }
        return [
          { id: 1, is_plugin: false, terminal_command: null },
          { id: 42, is_plugin: false, terminal_command: '/managed/node' },
        ];
      },
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        expect(params.paneId).toBe('terminal_1');
        bootstrapClosed = true;
      },
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      startCommandDetached(): Promise<{ dispose(): void }>;
    };
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      launchStrategy: {
        type: 'foregroundAttached',
        launchClient: async () => undefined,
      },
    } as Parameters<typeof createZellijTerminalHostAdapterBase>[0] & {
      launchStrategy: { type: 'foregroundAttached'; launchClient(): Promise<void> };
    });

    let error: unknown;
    await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    }).catch((caught: unknown) => {
      error = caught;
    });
    expect(isTerminalHostStartupError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'terminal_host_startup_failed',
      hostKind: 'zellij',
      reason: 'pane_disappeared_after_bootstrap_cleanup',
    });
    const diagnostics = (error as { diagnostics?: Record<string, unknown> }).diagnostics;
    expect(diagnostics).toMatchObject({
      previousPaneId: 'terminal_42',
      closedPaneIds: ['terminal_1'],
    });
    expect(JSON.parse(JSON.stringify(diagnostics))).toMatchObject({
      closedPaneIds: ['terminal_1'],
    });
    expect(launcherDisposed).toBe(true);
  });

  it('preserves the typed startup failure and attributes best-effort cleanup failures', async () => {
    let listCount = 0;
    let launcherDisposed = false;
    let bootstrapClosed = false;
    const actions = {
      attachCreateBackground: async () => {
        throw new Error('should not create a background session');
      },
      runCommand: async () => {
        throw new Error('foreground launch should not await zellij run');
      },
      startCommandDetached: async () => ({
        dispose: () => {
          launcherDisposed = true;
        },
      }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) {
          return [{ id: 1, is_plugin: false, terminal_command: null }];
        }
        if (launcherDisposed) {
          return bootstrapClosed ? [] : [{ id: 1, is_plugin: false, terminal_command: null }];
        }
        return [
          { id: 1, is_plugin: false, terminal_command: null },
          { id: 42, is_plugin: false, terminal_command: '/managed/node' },
        ];
      },
      dumpScreen: async () => '',
      closePane: async () => {
        bootstrapClosed = true;
      },
      killSession: async () => ({ exitCode: 1, stdout: '', stderr: 'cleanup denied' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      startCommandDetached(): Promise<{ dispose(): void }>;
    };
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      launchStrategy: {
        type: 'foregroundAttached',
        launchClient: async () => undefined,
      },
    } as Parameters<typeof createZellijTerminalHostAdapterBase>[0] & {
      launchStrategy: { type: 'foregroundAttached'; launchClient(): Promise<void> };
    });

    let error: unknown;
    await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    }).catch((caught: unknown) => {
      error = caught;
    });

    expect(isTerminalHostStartupError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'terminal_host_startup_failed',
      hostKind: 'zellij',
      reason: 'pane_disappeared_after_bootstrap_cleanup',
    });
    const diagnostics = (error as { diagnostics?: Record<string, unknown> }).diagnostics;
    expect(diagnostics).toMatchObject({
      previousPaneId: 'terminal_42',
      closedPaneIds: ['terminal_1'],
    });
    expect(JSON.parse(JSON.stringify(diagnostics))).toMatchObject({
      closedPaneIds: ['terminal_1'],
    });
    expect(String((error as { message?: unknown }).message)).not.toContain('cleanup failed');
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('kill-session'),
      expect.objectContaining({
        action: 'kill-session',
        callSite: 'integrations.zellij.adapter.startupCleanup',
        sessionName: 'session-a',
      }),
    );
    expect(launcherDisposed).toBe(true);
  });

  it('preserves a live session-name collision and creates this host under a fresh unique name', async () => {
    const calls: string[] = [];
    let attachAttempt = 0;
    let listCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async ({ sessionName }) => {
        attachAttempt += 1;
        calls.push(`attach:${sessionName}`);
        return attachAttempt === 1
          ? { exitCode: 1, stdout: '', stderr: '\u001b[31mSession "session-a" already exists\u001b[0m' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: 'terminal_42', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) {
          return [{ id: 7, is_plugin: false, terminal_command: '/managed/node' }];
        }
        return listCount === 2 ? [] : [{ id: 42, is_plugin: false, terminal_command: '/managed/node' }];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => {
        calls.push('kill');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => {
        calls.push('delete');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({
      kind: 'zellij',
      paneId: 'terminal_42',
    });

    expect(calls[0]).toBe('attach:session-a');
    expect(calls[1]).toMatch(/^attach:session-a-collision-/);
    expect(calls).not.toContain('kill');
    expect(calls).not.toContain('delete');
    expect(calls.at(-1)).toBe('run');
  });

  it('deletes a session-name collision only after exited-pane proof', async () => {
    const calls: string[] = [];
    let attachAttempt = 0;
    let listCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async ({ sessionName }) => {
        attachAttempt += 1;
        calls.push(`attach:${sessionName}`);
        return attachAttempt === 1
          ? { exitCode: 1, stdout: '', stderr: 'Session session-a already exists' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: 'terminal_42', stderr: '' };
      },
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) {
          return [{ id: 7, is_plugin: false, terminal_command: '/managed/node', exited: true, exit_status: 1 }];
        }
        return listCount === 2 ? [] : [{ id: 42, is_plugin: false, terminal_command: '/managed/node' }];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => {
        calls.push('kill');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => {
        calls.push('delete');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({
      sessionName: 'session-a',
      paneId: 'terminal_42',
    });

    expect(calls).toEqual([
      'attach:session-a',
      'kill',
      'delete',
      'attach:session-a',
      'run',
    ]);
  });

  it('waits for foreground-attached sessions to be listed before probing panes', async () => {
    const calls: string[] = [];
    let sessionListCount = 0;
    let paneListCount = 0;
    let launcherDisposed = false;
    const actions = {
      attachCreateBackground: async () => {
        throw new Error('should not create a background session');
      },
      runCommand: async () => {
        throw new Error('foreground launch should not await zellij run');
      },
      startCommandDetached: async () => ({
        dispose: () => {
          launcherDisposed = true;
        },
      }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listSessions: async () => {
        sessionListCount += 1;
        calls.push(`sessions:${sessionListCount}`);
        return {
          exitCode: 0,
          stdout: sessionListCount < 3
            ? 'other-session [Created 1s ago]\n'
            : '\u001B[32;1msession-a\u001B[m [Created 1s ago]\n',
          stderr: '',
        };
      },
      listPanes: async () => {
        paneListCount += 1;
        calls.push(`panes:${paneListCount}`);
        if (sessionListCount < 3) {
          throw new ZellijActionTimeoutError('list-panes');
        }
        return paneListCount === 1
          ? [{ id: 0, is_plugin: true, is_suppressed: true }]
          : [{ id: 42, is_plugin: false, terminal_command: '/managed/node' }];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      listSessions(): Promise<{ exitCode: number; stdout: string; stderr: string }>;
      startCommandDetached(): Promise<{ dispose(): void }>;
    };
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 1_000,
      launchStrategy: {
        type: 'foregroundAttached',
        launchClient: async () => undefined,
      },
    } as Parameters<typeof createZellijTerminalHostAdapterBase>[0] & {
      launchStrategy: { type: 'foregroundAttached'; launchClient(): Promise<void> };
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    expect(handle.paneId).toBe('terminal_42');
    expect(launcherDisposed).toBe(true);
    expect(calls).toEqual(['sessions:1', 'sessions:2', 'sessions:3', 'panes:1', 'panes:2', 'panes:3']);
  });

  it('disposes a foreground detached command launcher when pane discovery fails', async () => {
    let launcherDisposed = false;
    const actions = {
      attachCreateBackground: async () => {
        throw new Error('should not create a background session');
      },
      runCommand: async () => {
        throw new Error('foreground launch should not await zellij run');
      },
      startCommandDetached: async () => ({
        dispose: () => {
          launcherDisposed = true;
        },
      }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      listPanes: async () => [],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      startCommandDetached(): Promise<{ dispose(): void }>;
    };
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 5,
      launchStrategy: {
        type: 'foregroundAttached',
        launchClient: async () => undefined,
      },
    } as Parameters<typeof createZellijTerminalHostAdapterBase>[0] & {
      launchStrategy: { type: 'foregroundAttached'; launchClient(): Promise<void> };
    });

    let thrown: unknown;
    try {
      await adapter.createOrAttachHost({
        sessionName: 'session-a',
        workingDirectory: '/workspace/project',
        spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
        spawnEnv: {},
        isolatedEnv: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(isTerminalHostStartupError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      reason: 'startup_action_timeout',
      diagnostics: {
        action: 'pane_discovery',
        sessionName: 'session-a',
        timeoutMs: 5,
      },
    });
    expect(String((thrown as { message?: unknown }).message)).toMatch(/no terminal target pane/i);
    expect(launcherDisposed).toBe(true);
  });

  it('returns the command pane id observed after bootstrap cleanup when zellij rekeys panes', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      listPanes: async () => {
        listCount += 1;
        calls.push(`list:${listCount}`);
        if (listCount === 1) return [];
        if (listCount === 2) {
          return [
            { id: 1, is_plugin: false, terminal_command: null },
            { id: 42, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
          ];
        }
        return [{ id: 1, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' }];
      },
      dumpScreen: async () => '',
      closePane: async (params) => {
        calls.push(`close:${params.paneId}`);
      },
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions;
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_1' });

    expect(calls).toEqual(['list:1', 'list:2', 'close:terminal_1', 'list:3']);
  });

  it('injects into a created handle when zellij reports only executable command metadata', async () => {
    const calls: string[] = [];
    let listCount = 0;
    let dumpCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' }),
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}:${params.text}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => {
        listCount += 1;
        return listCount === 1 ? [] : [{ id: 42, is_plugin: false, terminal_command: '/managed/node' }];
      },
      dumpScreen: async () => {
        dumpCount += 1;
        return '';
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    await expect(adapter.injectUserPrompt(
      handle,
      { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
    )).resolves.toMatchObject({ status: 'injected' });

    expect(calls).toEqual(['write:terminal_42:prompt', 'enter:terminal_42']);
  });

  it('uses zellij action paste plus a separate Enter for argv-safe prompt delivery', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      pasteText: async (params) => {
        calls.push(`paste:${params.paneId}:${params.text}:${params.timeoutMs ?? 'none'}`);
      },
      writeBytesChunked: async () => {
        throw new Error('safe zellij prompt delivery should use action paste');
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}:${params.timeoutMs ?? 'none'}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
      pasteMaxBytes: 1024,
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: 'line one\nline two',
        multiline: true,
        origin: { kind: 'ui_pending', nonce: 'nonce-a' },
        scheduling: {},
      },
    )).resolves.toMatchObject({ status: 'injected', bytesWritten: Buffer.byteLength('line one\nline two') });

    expect(calls).toEqual([
      'paste:terminal_1:line one\nline two:123',
      expect.stringMatching(/^enter:terminal_1:\d+$/),
    ]);
  });

  it('submits a large zellij paste and retries Enter when it remains pending', async () => {
    const prompt = Array.from({ length: 6_000 }, (_, index) => `line ${index} ${'x'.repeat(36)}`).join('\n');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(250_000);
    const calls: string[] = [];
    let dumpCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      pasteText: async (params) => {
        calls.push(`paste:${params.paneId}`);
      },
      writeBytesChunked: async () => {
        throw new Error('safe zellij prompt delivery should use action paste');
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async (params) => {
        calls.push(`dump:${params.paneId}`);
        dumpCount += 1;
        return dumpCount === 1 ? '[Pasted text #1 +5999 lines]' : '';
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
      pasteMaxBytes: 1024 * 1024,
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: prompt,
        multiline: true,
        origin: { kind: 'ui_pending', nonce: 'nonce-large-zellij-verify' },
        scheduling: {},
      },
    )).resolves.toMatchObject({ status: 'injected' });

    expect(calls).toEqual([
      'paste:terminal_1',
      'enter:terminal_1',
      'dump:terminal_1',
      'enter:terminal_1',
      'dump:terminal_1',
    ]);
  });

  it('re-sends Enter once when a collapsed multiline paste remains in the composer after submit', async () => {
    const calls: string[] = [];
    let dumpCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      pasteText: async (params) => {
        calls.push(`paste:${params.paneId}`);
      },
      writeBytesChunked: async () => {
        throw new Error('safe zellij prompt delivery should use action paste');
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async (params) => {
        dumpCount += 1;
        calls.push(`dump:${params.paneId}`);
        return dumpCount === 1 ? '[Pasted text #1 +40 lines]' : '';
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
      pasteMaxBytes: 1024 * 1024,
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n'),
        multiline: true,
        origin: { kind: 'ui_pending', nonce: 'nonce-zellij-submit-retry' },
        scheduling: {},
      },
    )).resolves.toMatchObject({ status: 'injected' });

    expect(calls).toEqual([
      'paste:terminal_1',
      'enter:terminal_1',
      'dump:terminal_1',
      'enter:terminal_1',
      'dump:terminal_1',
    ]);
  });

  it('reports ambiguous failure when a collapsed zellij paste remains after the bounded Enter retry', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      pasteText: async (params) => {
        calls.push(`paste:${params.paneId}`);
      },
      writeBytesChunked: async () => {
        throw new Error('safe zellij prompt delivery should use action paste');
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async (params) => {
        calls.push(`dump:${params.paneId}`);
        return '> [Pasted text #1 +40 lines]';
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
      pasteMaxBytes: 1024 * 1024,
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n'),
        multiline: true,
        origin: { kind: 'ui_pending', nonce: 'nonce-zellij-submit-stuck' },
        scheduling: {},
      },
    )).resolves.toEqual({
      status: 'failed',
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      recoverable: true,
    });

    expect(calls).toEqual([
      'paste:terminal_1',
      'dump:terminal_1',
      'enter:terminal_1',
      'dump:terminal_1',
      'enter:terminal_1',
      'dump:terminal_1',
    ]);
  });

  it('submits a large zellij paste without requiring pre-submit screen proof', async () => {
    const prompt = Array.from({ length: 6_000 }, (_, index) => `line ${index} ${'x'.repeat(36)}`).join('\n');
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      pasteText: async (params) => {
        calls.push(`paste:${params.paneId}`);
      },
      writeBytesChunked: async () => {
        throw new Error('safe zellij prompt delivery should use action paste');
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async (params) => {
        calls.push(`dump:${params.paneId}`);
        return 'old composer contents';
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
      pasteMaxBytes: 1024 * 1024,
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: prompt,
        multiline: true,
        origin: { kind: 'ui_pending', nonce: 'nonce-large-zellij-unverified' },
        scheduling: { timeoutMs: 1 },
      },
    )).resolves.toMatchObject({ status: 'injected' });

    expect(calls[0]).toBe('paste:terminal_1');
    expect(calls.some((call) => call === 'dump:terminal_1')).toBe(true);
    expect(calls.some((call) => call === 'enter:terminal_1')).toBe(true);
  });

  it('does not treat a stale visible placeholder as a still-pending submitted paste', async () => {
    const prompt = Array.from({ length: 6_000 }, (_, index) => `line ${index} ${'x'.repeat(36)}`).join('\n');
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      pasteText: async (params) => {
        calls.push(`paste:${params.paneId}`);
      },
      writeBytesChunked: async () => {
        throw new Error('safe zellij prompt delivery should use action paste');
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async (params) => {
        calls.push(`dump:${params.paneId}`);
        return [
          'previous prompt already submitted',
          '[Pasted text +5999 lines]',
          '',
          '│ > │',
        ].join('\n');
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createClaudeZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
      pasteMaxBytes: 1024 * 1024,
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: prompt,
        multiline: true,
        origin: { kind: 'ui_pending', nonce: 'nonce-large-zellij-stale-placeholder' },
        scheduling: {},
      },
    )).resolves.toMatchObject({ status: 'injected', bytesWritten: Buffer.byteLength(prompt) });

    expect(calls).toEqual([
      'paste:terminal_1',
      'enter:terminal_1',
      'dump:terminal_1',
    ]);
  });

  it('falls back to chunked byte writes when prompt text exceeds the argv-safe paste cap', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      pasteText: async () => {
        throw new Error('over-cap zellij prompt delivery must not use action paste');
      },
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}:${params.text}:${params.chunkSize ?? 'none'}:${params.timeoutMs ?? 'none'}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}:${params.timeoutMs ?? 'none'}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
      pasteMaxBytes: 4,
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: 'hello',
        multiline: false,
        origin: { kind: 'ui_pending', nonce: 'nonce-a' },
        scheduling: {},
      },
    )).resolves.toMatchObject({ status: 'injected', bytesWritten: Buffer.byteLength('hello') });

    expect(calls).toEqual([
      `write:terminal_1:hello:${DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE}:123`,
      expect.stringMatching(/^enter:terminal_1:\d+$/),
    ]);
  });

  it('falls back to chunked byte writes when zellij action paste is unavailable', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      pasteText: async () => {
        calls.push('paste');
        throw new Error('zellij action paste failed: unknown action');
      },
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}:${params.text}:${params.timeoutMs ?? 'none'}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}:${params.timeoutMs ?? 'none'}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
      pasteMaxBytes: 1024,
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: 'hello',
        multiline: false,
        origin: { kind: 'ui_pending', nonce: 'nonce-a' },
        scheduling: {},
      },
    )).resolves.toMatchObject({ status: 'injected', bytesWritten: Buffer.byteLength('hello') });

    expect(calls).toEqual([
      'paste',
      'write:terminal_1:hello:123',
      expect.stringMatching(/^enter:terminal_1:\d+$/),
    ]);
  });

  it('does not fall back to chunked byte writes when zellij action paste times out', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      pasteText: async () => {
        calls.push('paste');
        throw new ZellijActionTimeoutError('paste');
      },
      writeBytesChunked: async () => {
        calls.push('write');
      },
      sendEnter: async () => {
        calls.push('enter');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
      pasteMaxBytes: 1024,
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: 'hello',
        multiline: false,
        origin: { kind: 'ui_pending', nonce: 'nonce-a' },
        scheduling: {},
      },
    )).resolves.toEqual({
      status: 'failed',
      reason: 'timeout',
      phase: 'during_write',
      duplicateRisk: 'possible',
      recoverable: true,
    });

    expect(calls).toEqual(['paste']);
  });

  it('does not close a proven command replacement that reuses a closed bootstrap pane id', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1\n', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) return [{ id: 0, is_plugin: false, terminal_command: null }];
        if (listCount === 2) {
          return [
            { id: 0, is_plugin: false, terminal_command: null },
            { id: 1, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
          ];
        }
        if (listCount === 3) {
          return [{ id: 0, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' }];
        }
        return [];
      },
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
      },
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).resolves.toMatchObject({ paneId: 'terminal_0' });

    expect(calls).toEqual(['close:terminal_0']);
  });

  it('fails closed when a closed bootstrap pane reappears with unrelated command metadata', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1\n', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) return [{ id: 0, is_plugin: false, terminal_command: null }];
        if (listCount === 2) {
          return [
            { id: 0, is_plugin: false, terminal_command: null },
            { id: 1, is_plugin: false, terminal_command: '/managed/node' },
          ];
        }
        return [{ id: 0, is_plugin: false, terminal_command: '/bin/zsh' }];
      },
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
      },
      killSession: async (params: { sessionName: string }) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
      killSession(params: { sessionName: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 5,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow();

    expect(calls).toContain('close:terminal_0');
    expect(calls).toContain('kill:session-a');
  });

  it('fails closed when a closed bootstrap pane reappears with another launch spec path', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1\n', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) return [{ id: 0, is_plugin: false, terminal_command: null }];
        if (listCount === 2) {
          return [
            { id: 0, is_plugin: false, terminal_command: null },
            { id: 1, is_plugin: false, terminal_command: '/managed/node terminal_launch_spec_runner.cjs /tmp/spec-a/launch.json' },
          ];
        }
        return [{ id: 0, is_plugin: false, terminal_command: '/managed/node terminal_launch_spec_runner.cjs /tmp/spec-b/launch.json' }];
      },
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
      },
      killSession: async (params: { sessionName: string }) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
      killSession(params: { sessionName: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 5,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'terminal_launch_spec_runner.cjs', '/tmp/spec-a/launch.json'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow();

    expect(calls).toContain('close:terminal_0');
    expect(calls).toContain('kill:session-a');
  });

  it('fails closed when a closed bootstrap pane reappears with only executable metadata', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1\n', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) return [{ id: 0, is_plugin: false, terminal_command: null }];
        if (listCount === 2) {
          return [
            { id: 0, is_plugin: false, terminal_command: null },
            { id: 1, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
          ];
        }
        return [{ id: 0, is_plugin: false, terminal_command: '/managed/node' }];
      },
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
      },
      killSession: async (params: { sessionName: string }) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
      killSession(params: { sessionName: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 5,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow();

    expect(calls).toContain('close:terminal_0');
    expect(calls).toContain('kill:session-a');
  });

  it('keeps the originally discovered live pane after bootstrap cleanup when zellij omits command metadata', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) return [];
        if (listCount === 2) {
          return [
            { id: 0, is_plugin: false, terminal_command: null },
            { id: 42, is_plugin: false },
          ];
        }
        return [{ id: 42, is_plugin: false }];
      },
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
      },
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    expect(calls).toEqual(['close:terminal_0']);
    expect(handle.paneId).toBe('terminal_42');
  });

  it('keeps the originally discovered live pane after bootstrap cleanup when zellij reports null command metadata', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) return [];
        if (listCount === 2) {
          return [
            { id: 0, is_plugin: false, terminal_command: null },
            { id: 42, is_plugin: false, terminal_command: '/managed/node' },
          ];
        }
        return [{ id: 42, is_plugin: false, terminal_command: null }];
      },
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
      },
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    expect(calls).toEqual(['close:terminal_0']);
    expect(handle.paneId).toBe('terminal_42');
  });

  it('fails closed when the launched pane is dead after cleanup instead of falling back to another command pane', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) return [];
        if (listCount === 2) {
          return [{ id: 42, is_plugin: false, terminal_command: '/managed/node' }];
        }
        return [
          { id: 42, is_plugin: false, terminal_command: '/managed/node', exited: true, exit_status: 127 },
          { id: 7, is_plugin: false, terminal_command: '/stale/claude' },
        ];
      },
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
      },
      killSession: async (params: { sessionName: string }) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
      killSession(params: { sessionName: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow(/launched terminal pane disappeared/i);
    expect(calls).toContain('kill:session-a');
  });

  it('fails closed when the launched pane is removed after cleanup instead of falling back to another command pane', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) return [];
        if (listCount === 2) return [{ id: 42, is_plugin: false, terminal_command: '/managed/node' }];
        return [{ id: 7, is_plugin: false, terminal_command: '/stale/claude' }];
      },
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
      },
      killSession: async (params: { sessionName: string }) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
      killSession(params: { sessionName: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow(/launched terminal pane disappeared/i);
    expect(calls).toContain('kill:session-a');
  });

  it('creates the shortened zellij socket directory before startup actions run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-zellij-socket-test-'));
    const happyHomeDir = join(root, 'long-happy-home-path-for-zellij-socket-dir-'.repeat(3));
    const socketDir = resolveZellijSocketDir(happyHomeDir);
    await rm(socketDir, { recursive: true, force: true });
    const observed: string[] = [];
    let listCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async (params) => {
        const socketStat = await stat(params.env.ZELLIJ_SOCKET_DIR);
        observed.push(`attach:${socketStat.isDirectory()}:${socketStat.mode & 0o777}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_42\n', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        return listCount === 1 ? [] : [{ id: 42, is_plugin: false, terminal_command: '/managed/node' }];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir,
      actions,
      prepareSocketDir: prepareZellijSocketDir,
    });

    try {
      await adapter.createOrAttachHost({
        sessionName: 'session-a',
        workingDirectory: '/workspace/project',
        spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
        spawnEnv: {},
        isolatedEnv: true,
      });

      expect(observed[0]).toMatch(/^attach:true:/);
      if (process.platform !== 'win32') {
        expect(observed[0]).toBe('attach:true:448');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(socketDir, { recursive: true, force: true });
    }
  });

  it('passes the configured action timeout to zellij startup and disposal actions', async () => {
    const observedTimeouts: Record<string, number | undefined> = {};
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async (params: { timeoutMs?: number }) => {
        observedTimeouts.attach = params.timeoutMs;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async (params: { timeoutMs?: number }) => {
        observedTimeouts.run = params.timeoutMs;
        return { exitCode: 0, stdout: 'terminal_1', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        return listCount === 1 ? [] : [{ id: 1, is_plugin: false, terminal_command: '/managed/node' }];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async (params: { timeoutMs?: number }) => {
        observedTimeouts.kill = params.timeoutMs;
        calls.push('kill');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async (params: { timeoutMs?: number }) => {
        observedTimeouts.delete = params.timeoutMs;
        calls.push('delete');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } as ZellijActions;
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 321,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });
    await adapter.dispose({
      ...handle,
      attachMetadata: { ...handle.attachMetadata, topology: 'exclusive' },
    });

    expect(observedTimeouts).toEqual({ attach: 321, run: 321, kill: 321, delete: 321 });
    expect(calls).toEqual(['kill', 'delete']);
  });

  it('destroys only the exact owned pane for shared zellij topology', async () => {
    const calls: string[] = [];
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      listPanes: async () => [],
      dumpScreen: async () => '',
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
      },
      killSession: async () => {
        calls.push('kill');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => {
        calls.push('delete');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    } as ZellijActions;
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await adapter.dispose({
      kind: 'zellij',
      sessionName: 'shared-session',
      paneId: 'terminal_9',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    });

    expect(calls).toEqual(['close:terminal_9']);
  });

  it('parks shared zellij destruction when the owned pane is missing', async () => {
    const closePane = vi.fn(async () => undefined);
    const killSession = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const deleteSession = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      listPanes: async () => [],
      dumpScreen: async () => '',
      closePane,
      killSession,
      deleteSession,
    } as ZellijActions;
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.dispose({
      kind: 'zellij',
      sessionName: 'shared-session',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    })).rejects.toThrow(/pane/i);
    expect(closePane).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('parks committed exclusive zellij destruction when teardown times out', async () => {
    const calls: string[] = [];
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => {
        calls.push('kill');
        throw new ZellijActionTimeoutError('kill-session');
      },
      deleteSession: async () => {
        calls.push('delete');
        throw new ZellijActionTimeoutError('delete-session');
      },
    } as ZellijActions;
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.dispose({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'exclusive' },
    })).rejects.toThrow(/owned zellij session/i);
    expect(calls).toEqual(['kill', 'delete']);
    expect(loggerWarn).toHaveBeenCalledTimes(2);
    expect(loggerWarn).toHaveBeenNthCalledWith(1, expect.stringContaining('kill-session'), expect.objectContaining({
      callSite: 'integrations.zellij.adapter.dispose',
      sessionName: 'session-a',
    }));
    expect(loggerWarn).toHaveBeenNthCalledWith(2, expect.stringContaining('delete-session'), expect.objectContaining({
      callSite: 'integrations.zellij.adapter.dispose',
      sessionName: 'session-a',
    }));
  });

  it('preserves the startup attempt error when kill and delete cleanup actions time out', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        throw new ZellijActionTimeoutError('attach');
      },
      runCommand: async () => {
        throw new Error('should not run after failed attach');
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        throw new Error('should not list panes after failed attach');
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => {
        calls.push('kill');
        throw new ZellijActionTimeoutError('kill-session');
      },
      deleteSession: async () => {
        calls.push('delete');
        throw new ZellijActionTimeoutError('delete-session');
      },
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
    });

    let thrown: unknown;
    try {
      await adapter.createOrAttachHost({
        sessionName: 'session-a',
        workingDirectory: '/workspace/project',
        spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
        spawnEnv: {},
        isolatedEnv: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'TerminalHostStartupError',
      reason: 'startup_action_timeout',
      diagnostics: expect.objectContaining({ action: 'attach' }),
    });
    expect(String((thrown as Error).message)).not.toContain('cleanup failed');
    expect(calls).toEqual(['attach', 'kill', 'delete']);
    expect(loggerWarn).toHaveBeenCalledTimes(2);
  });

  it('cleans up the background zellij session when background attach throws after partial creation', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        throw new ZellijActionTimeoutError('attach');
      },
      runCommand: async () => {
        throw new Error('should not run after failed attach');
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        throw new Error('should not list panes after failed attach');
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}:${params.timeoutMs ?? 'none'}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
    });

    let thrown: unknown;
    try {
      await adapter.createOrAttachHost({
        sessionName: 'session-a',
        workingDirectory: '/workspace/project',
        spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
        spawnEnv: {},
        isolatedEnv: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(isTerminalHostStartupError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      reason: 'startup_action_timeout',
      diagnostics: {
        action: 'attach',
        sessionName: 'session-a',
        timeoutMs: 123,
      },
    });

    expect(calls).toEqual(['attach', 'kill:session-a:123']);
  });

  it('cleans up the background zellij session when background attach exits nonzero after partial creation', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 1, stdout: '', stderr: 'attach failed' };
      },
      runCommand: async () => {
        throw new Error('should not run after failed attach');
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        throw new Error('should not list panes after failed attach');
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}:${params.timeoutMs ?? 'none'}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
    });

    let thrown: unknown;
    try {
      await adapter.createOrAttachHost({
        sessionName: 'session-a',
        workingDirectory: '/workspace/project',
        spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
        spawnEnv: {},
        isolatedEnv: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(isTerminalHostStartupError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      reason: 'startup_action_failed',
      diagnostics: {
        action: 'attach',
        cmd: [
          '/tools/zellij',
          'attach',
          '--create-background',
          'session-a',
          'options',
          '--default-cwd',
          '/workspace/project',
        ],
        cwd: '/workspace/project',
        exitCode: 1,
        stderr: 'attach failed',
        stdout: '',
        sessionName: 'session-a',
        timeoutMs: 123,
      },
    });

    expect(calls).toEqual(['attach', 'kill:session-a:123']);
  });

  it('cleans up the background zellij session when zellij run throws after attach', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        throw new ZellijActionTimeoutError('run');
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        calls.push('list');
        return [];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}:${params.timeoutMs ?? 'none'}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
    });

    let thrown: unknown;
    try {
      await adapter.createOrAttachHost({
        sessionName: 'session-a',
        workingDirectory: '/workspace/project',
        spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
        spawnEnv: {},
        isolatedEnv: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(isTerminalHostStartupError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      reason: 'startup_action_timeout',
      diagnostics: {
        action: 'run',
        sessionName: 'session-a',
        timeoutMs: 123,
      },
    });

    expect(calls).toEqual(['attach', 'list', 'run', 'kill:session-a:123']);
  });

  it('preserves zellij run command diagnostics when run exits nonzero after attach', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 2, stdout: 'run stdout', stderr: 'run stderr' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        calls.push('list');
        return [];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}:${params.timeoutMs ?? 'none'}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
    });

    let thrown: unknown;
    try {
      await adapter.createOrAttachHost({
        sessionName: 'session-a',
        workingDirectory: '/workspace/project',
        spawnArgv: ['/managed/node', 'claude_local_launcher.cjs', '--model', 'sonnet'],
        spawnEnv: {},
        isolatedEnv: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(isTerminalHostStartupError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      reason: 'startup_action_failed',
      diagnostics: {
        action: 'run',
        cmd: [
          '/tools/zellij',
          '-s',
          'session-a',
          'run',
          '--cwd',
          '/workspace/project',
          '--',
          '/managed/node',
          'claude_local_launcher.cjs',
          '--model',
          'sonnet',
        ],
        cwd: '/workspace/project',
        exitCode: 2,
        stderr: 'run stderr',
        stdout: 'run stdout',
        sessionName: 'session-a',
        timeoutMs: 123,
      },
    });
    expect(String((thrown as { message?: unknown }).message)).toContain('run stderr');
    expect(calls).toEqual(['attach', 'list', 'run', 'kill:session-a:123']);
  });

  it('treats missing-session startup cleanup as successful cleanup and preserves the startup root cause', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return {
          exitCode: 0,
          stdout: 'Microsoft Windows [version 10.0.26200.8390]',
          stderr: '',
        };
      },
      runCommand: async () => {
        throw new Error('should not run after failed startup verification');
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        calls.push('list');
        throw new Error('zellij list-panes failed: No session named "session-a" found.');
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => {
        calls.push('kill');
        return { exitCode: 1, stdout: 'No session named "session-a" found.\n', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 1_000,
    });

    let thrown: unknown;
    try {
      await adapter.createOrAttachHost({
        sessionName: 'session-a',
        workingDirectory: '/workspace/project',
        spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
        spawnEnv: {},
        isolatedEnv: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('zellij session did not become addressable');
    expect((thrown as Error).message).toContain('No session named "session-a" found');

    expect(calls[0]).toBe('attach');
    expect(calls).toContain('list');
    expect(calls.at(-1)).toBe('kill');
  });

      it('closes the default shell pane left by zellij background session creation', async () => {
      const calls: string[] = [];
      let listCount = 0;
      let defaultShellClosed = false;
    const actions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: 'terminal_42\n', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
        listPanes: async () => {
          listCount += 1;
          calls.push(`list:${listCount}`);
          if (listCount === 1) {
            return [];
          }
          if (defaultShellClosed) {
            return [
              { id: 0, is_plugin: true, is_suppressed: true },
              { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
            ];
          }
          return [
            { id: 0, is_plugin: true, is_suppressed: true },
            { id: 1, is_plugin: false, terminal_command: null },
            { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
          ];
        },
        closePane: async (params: { paneId: string }) => {
          calls.push(`close:${params.paneId}`);
          defaultShellClosed = true;
        },
      dumpScreen: async () => '',
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
    };
      const adapter = createZellijTerminalHostAdapter({
        zellijBinary: '/tools/zellij',
        happyHomeDir: '/home/happier',
        actions,
        actionTimeoutMs: 1_000,
      });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    expect(handle.paneId).toBe('terminal_42');
    expect(calls).toEqual(['attach', 'list:1', 'run', 'list:2', 'close:terminal_1', 'list:3']);
  });

  it('runs a bounded post-launch cleanup pass for late bootstrap shell panes', async () => {
    const calls: string[] = [];
    const listTimeouts: number[] = [];
    const closeTimeouts: number[] = [];
    let listCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: 'terminal_42\n', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async (params) => {
        listCount += 1;
        calls.push(`list:${listCount}`);
        if (params.timeoutMs !== undefined) listTimeouts.push(params.timeoutMs);
        if (listCount === 1) {
          return [];
        }
          if (listCount === 2) {
            return [
              { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
            ];
          }
        if (listCount === 3) {
          return [
            { id: 0, is_plugin: true, is_suppressed: true },
            { id: 1, is_plugin: false, terminal_command: null },
            { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
          ];
        }
          return [
            { id: 0, is_plugin: true, is_suppressed: true },
            { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
          ];
        },
      closePane: async (params) => {
        calls.push(`close:${params.paneId}`);
        if (params.timeoutMs !== undefined) closeTimeouts.push(params.timeoutMs);
      },
      dumpScreen: async () => '',
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    expect(handle.paneId).toBe('terminal_42');
    expect(calls).toEqual(['attach', 'list:1', 'run', 'list:2', 'list:3', 'close:terminal_1', 'list:4']);
    expect(listTimeouts).toHaveLength(4);
    expect(listTimeouts.every((timeoutMs) => timeoutMs > 0 && timeoutMs <= 123)).toBe(true);
    expect(closeTimeouts).toEqual([123]);
  });

  it('continues bounded bootstrap cleanup until late shell panes stop appearing', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: 'terminal_42\n', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        calls.push(`list:${listCount}`);
        if (listCount === 1) {
          return [];
        }
        if (listCount === 2) {
          return [
            { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
          ];
        }
        if (listCount === 3) {
          return [
            { id: 1, is_plugin: false, terminal_command: null },
            { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
          ];
        }
        if (listCount === 4) {
          return [
            { id: 2, is_plugin: false, terminal_command: null },
            { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
          ];
        }
        return [
          { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
        ];
      },
      closePane: async (params) => {
        calls.push(`close:${params.paneId}`);
      },
      dumpScreen: async () => '',
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 1_000,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    expect(handle.paneId).toBe('terminal_42');
    expect(calls).toEqual([
      'attach',
      'list:1',
      'run',
      'list:2',
      'list:3',
      'close:terminal_1',
      'list:4',
      'close:terminal_2',
      'list:5',
    ]);
  });

  it('uses the launched command pane instead of the default shell pane when zellij run omits stdout', async () => {
      const calls: string[] = [];
      let listCount = 0;
      let defaultShellClosed = false;
    const actions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
        listPanes: async () => {
          listCount += 1;
          calls.push(`list:${listCount}`);
          if (listCount === 1) {
            return [];
          }
          if (defaultShellClosed) {
            return [
              { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
            ];
          }
          return [
            { id: 1, is_plugin: false, terminal_command: null },
            { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
          ];
        },
        closePane: async (params: { paneId: string }) => {
          calls.push(`close:${params.paneId}`);
          defaultShellClosed = true;
        },
      dumpScreen: async () => '',
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
    };
      const adapter = createZellijTerminalHostAdapter({
        zellijBinary: '/tools/zellij',
        happyHomeDir: '/home/happier',
        actions,
        actionTimeoutMs: 1_000,
      });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    expect(handle.paneId).toBe('terminal_42');
    expect(calls).toEqual(['attach', 'list:1', 'run', 'list:2', 'close:terminal_1', 'list:3']);
  });

  it('fails closed when run output is missing and multiple command panes are plausible', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        calls.push(`list:${listCount}`);
        if (listCount === 1) {
          return [];
        }
        return [
          { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
          { id: 43, is_plugin: false, is_focused: false, terminal_command: '/managed/node' },
        ];
      },
      closePane: async (params) => {
        calls.push(`close:${params.paneId}`);
      },
      dumpScreen: async () => '',
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 1,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow(/no terminal target pane/i);

    expect(calls.at(-1)).toBe('kill:session-a');
  });

  it('fails closed when zellij run reports a held target pane', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: 'terminal_42\n', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        calls.push(`list:${listCount}`);
        return listCount === 1
          ? []
          : [{ id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node', is_held: true }];
      },
      closePane: async (params) => {
        calls.push(`close:${params.paneId}`);
      },
      dumpScreen: async () => '',
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 1,
    });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow(/no terminal target pane/i);

    expect(calls.at(-1)).toBe('kill:session-a');
  });

  it('throws a typed startup error when bootstrap shell cleanup cannot converge', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: 'terminal_42\n', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        calls.push(`list:${listCount}`);
        if (listCount === 1) {
          return [];
        }
        return [
          { id: 1, is_plugin: false, terminal_command: null },
          { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
        ];
      },
      closePane: async (params) => {
        calls.push(`close:${params.paneId}`);
      },
      dumpScreen: async () => '',
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 1,
    });

    let error: unknown;
    try {
      await adapter.createOrAttachHost({
        sessionName: 'session-a',
        workingDirectory: '/workspace/project',
        spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
        spawnEnv: {},
        isolatedEnv: true,
      });
    } catch (caught) {
      error = caught;
    }

    expect(isTerminalHostStartupError(error)).toBe(true);
    expect(error).toMatchObject({
      hostKind: 'zellij',
      reason: 'bootstrap_cleanup_did_not_converge',
    });
    expect(calls).toContain('close:terminal_1');
    expect(calls.at(-1)).toBe('kill:session-a');
  });

    it('waits for the launched command pane when zellij run returns before pane discovery catches up', async () => {
      const calls: string[] = [];
      let listCount = 0;
      let defaultShellClosed = false;
    const actions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: 'terminal_42\n', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        calls.push(`list:${listCount}`);
        if (listCount === 1) {
          return [];
        }
          if (listCount === 2) {
            return [
              { id: 0, is_plugin: true, is_suppressed: true },
              { id: 1, is_plugin: false, terminal_command: null },
            ];
          }
          if (defaultShellClosed) {
            return [
              { id: 0, is_plugin: true, is_suppressed: true },
              { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
            ];
          }
          return [
            { id: 0, is_plugin: true, is_suppressed: true },
            { id: 1, is_plugin: false, terminal_command: null },
            { id: 42, is_plugin: false, is_focused: true, terminal_command: '/managed/node' },
          ];
        },
        closePane: async (params: { paneId: string }) => {
          calls.push(`close:${params.paneId}`);
          defaultShellClosed = true;
        },
      dumpScreen: async () => '',
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    const handle = await adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    expect(handle.paneId).toBe('terminal_42');
    expect(calls).toEqual(['attach', 'list:1', 'run', 'list:2', 'list:3', 'close:terminal_1', 'list:4']);
  });

  it('fails closed when zellij run only exposes the bootstrap shell pane', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions = {
      attachCreateBackground: async () => {
        calls.push('attach');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async () => {
        calls.push('run');
        return { exitCode: 0, stdout: 'terminal_1', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        calls.push(`list:${listCount}`);
        if (listCount === 1) {
          return [];
        }
        return [
          { id: 0, is_plugin: true, is_suppressed: true, terminal_command: null },
          { id: 0, is_plugin: false, is_focused: true, terminal_command: null, exited: false, exit_status: null },
        ];
      },
      closePane: async (params: { paneId: string }) => {
        calls.push(`close:${params.paneId}`);
      },
      dumpScreen: async () => '',
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      closePane(params: { paneId: string }): Promise<void>;
    };
      const adapter = createZellijTerminalHostAdapter({
        zellijBinary: '/tools/zellij',
        happyHomeDir: '/home/happier',
        actions,
        actionTimeoutMs: 1,
      });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow(/no terminal target pane/i);

      expect(calls.slice(0, 4)).toEqual(['attach', 'list:1', 'run', 'list:2']);
      expect(calls.at(-1)).toBe('kill:session-a');
    });

  it('uses a short socket directory when the stack happy home would make zellij IPC paths too long', async () => {
    const socketDirs: string[] = [];
    let listCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async (params) => {
        socketDirs.push(params.env.ZELLIJ_SOCKET_DIR ?? '');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runCommand: async (params) => {
        socketDirs.push(params.env.ZELLIJ_SOCKET_DIR ?? '');
        return { exitCode: 0, stdout: 'terminal_1', stderr: '' };
      },
      writeBytesChunked: async () => {
        throw new Error('should not write during host creation');
      },
      sendEnter: async () => {
        throw new Error('should not submit during host creation');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt during host creation');
      },
      listPanes: async () => {
        listCount += 1;
        return listCount === 1 ? [] : [{ id: 1, is_plugin: false, is_focused: true, terminal_command: '/managed/node' }];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/Users/leeroy/.happier/stacks/repo-remote-dev-d72117acdb/cli',
      actions,
    });

    await adapter.createOrAttachHost({
      sessionName: 'happier-claude-unified-73835-1780408351977',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    });

    if (process.platform === 'win32') {
      const expectedSocketDir = join('/Users/leeroy/.happier/stacks/repo-remote-dev-d72117acdb/cli', 'zellij-sock');
      expect(socketDirs).toEqual([expectedSocketDir, expectedSocketDir]);
    } else {
      expect(socketDirs).toEqual([
        expect.stringMatching(/^\/tmp\/happier-zellij-[a-f0-9]{16}$/),
        expect.stringMatching(/^\/tmp\/happier-zellij-[a-f0-9]{16}$/),
      ]);
    }
  });

  it('treats failed zellij session cleanup as best-effort disposal', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => {
        calls.push('kill');
        return { exitCode: 1, stdout: '', stderr: 'session still alive' };
      },
      deleteSession: async () => {
        calls.push('delete');
        return { exitCode: 1, stdout: '', stderr: 'metadata still present' };
      },
    };
      const adapter = createZellijTerminalHostAdapter({
        zellijBinary: '/tools/zellij',
        happyHomeDir: '/home/happier',
        actions,
      });

    await expect(adapter.dispose({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'exclusive' },
    })).rejects.toThrow(/owned zellij session/i);
    expect(calls).toEqual(['kill', 'delete']);
  });

  it('treats an already-missing zellij session as disposed', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'No session named "session-a" found.\n',
      }),
      deleteSession: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'No session named "session-a" found.\n',
      }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.dispose({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'exclusive' },
    })).resolves.toBeUndefined();
    expect(recordTerminalHostKillAudit).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'zellij.adapter',
      reason: 'dispose',
      sessionId: null,
      runnerPid: process.pid,
      zellijName: 'session-a',
      signal: 'kill-session',
      callSite: 'integrations.zellij.adapter.dispose',
    }));
  });

  it('cleans up the background zellij session when pane discovery fails after launch', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => {
        throw new Error('list-panes failed');
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
      const adapter = createZellijTerminalHostAdapter({
        zellijBinary: '/tools/zellij',
        happyHomeDir: '/home/happier',
        actions,
      });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow(/list-panes failed/);
    expect(calls).toEqual(['kill:session-a']);
  });

    it('fails closed and cleans up when zellij launch produces no terminal target pane', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => {
        listCount += 1;
        if (listCount === 1) return [];
        return [{ id: 0, is_plugin: true, is_suppressed: true }];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async (params) => {
        calls.push(`kill:${params.sessionName}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
      const adapter = createZellijTerminalHostAdapter({
        zellijBinary: '/tools/zellij',
        happyHomeDir: '/home/happier',
        actions,
        actionTimeoutMs: 1,
      });

    await expect(adapter.createOrAttachHost({
      sessionName: 'session-a',
      workingDirectory: '/workspace/project',
      spawnArgv: ['/managed/node', 'claude_local_launcher.cjs'],
      spawnEnv: {},
      isolatedEnv: true,
    })).rejects.toThrow(/no terminal target pane/i);
    expect(calls).toEqual(['kill:session-a']);
  });

  it('honors runtime-core terminal_busy deferral before touching zellij', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        calls.push('write');
      },
      sendEnter: async () => {
        calls.push('enter');
      },
      sendEscape: async () => {
        calls.push('escape');
      },
      listPanes: async () => {
        calls.push('list');
        return [{ id: 1, is_plugin: false, is_focused: true }];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(
      adapter.injectUserPrompt(
        {
          kind: 'zellij',
          sessionName: 'session-a',
          paneId: 'terminal_1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: 'prompt',
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-a' },
          scheduling: { deferReason: 'terminal_busy' },
        },
      ),
    ).resolves.toEqual({ status: 'deferred', reason: 'terminal_busy' });
    expect(calls).toEqual([]);
  });

  it('injects multiline Claude prompts as raw bytes plus Enter', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.text}`);
        expect(params.chunkSize).toBeGreaterThan(0);
      },
      sendEnter: async () => {
        calls.push('enter');
      },
      sendEscape: async () => {
        calls.push('escape');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };

    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    const result = await adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: 'line one\nline two',
        multiline: true,
        origin: { kind: 'ui_pending', nonce: 'nonce-a' },
        scheduling: {},
      },
    );

    const rawText = 'line one\nline two';
    expect(result).toMatchObject({ status: 'injected', bytesWritten: Buffer.byteLength(rawText) });
    expect(calls).toEqual([`write:${rawText}`, 'enter']);
  });

  it('waits for the Claude composer to stage the exact prompt before sending Enter', async () => {
    const prompt = 'continue';
    const calls: string[] = [];
    let dumpCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        calls.push('write');
      },
      sendEnter: async () => {
        calls.push('enter');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => {
        dumpCount += 1;
        calls.push(`dump:${dumpCount}`);
        if (dumpCount === 1) return 'Claude Code\n❯';
        if (dumpCount === 2) return `Claude Code\n❯ ${prompt}`;
        return 'Claude Code\n❯';
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 500,
      promptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: prompt,
        multiline: false,
        origin: { kind: 'ui_pending', nonce: 'nonce-stage-before-enter' },
        scheduling: {},
      },
    )).resolves.toMatchObject({ status: 'injected' });

    expect(calls.indexOf('dump:2')).toBeLessThan(calls.indexOf('enter'));
    expect(dumpCount).toBeGreaterThanOrEqual(4);
  });

  it('gives staging and Enter their own bounded phase after a slow successful write', async () => {
    let nowMs = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const prompt = 'continue';
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        calls.push('write');
        nowMs += 100;
      },
      sendEnter: async (params) => {
        expect(params.timeoutMs).toBeGreaterThan(0);
        calls.push('enter');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async (params) => {
        expect(params.timeoutMs).toBeGreaterThan(0);
        return calls.includes('enter') ? 'Claude Code\n❯' : `Claude Code\n❯ ${prompt}`;
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 100,
      promptSubmitVerification: createClaudePromptSubmitVerificationPolicy(),
    });

    try {
      await expect(adapter.injectUserPrompt(
        {
          kind: 'zellij',
          sessionName: 'session-a',
          paneId: 'terminal_1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        {
          text: prompt,
          multiline: false,
          origin: { kind: 'ui_pending', nonce: 'nonce-slow-write' },
          scheduling: { timeoutMs: 100 },
        },
      )).resolves.toMatchObject({ status: 'injected' });
    } finally {
      nowSpy.mockRestore();
    }

    expect(calls).toEqual(['write', 'enter']);
  });

  it('bounds prompt write and Enter with the size-aware prompt timeout when input has no timeout', async () => {
    const timeouts: Record<string, number | undefined> = {};
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async (params) => {
        timeouts.write = params.timeoutMs;
      },
      sendEnter: async (params) => {
        timeouts.enter = params.timeoutMs;
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 123,
    });

    await expect(adapter.injectUserPrompt(
      {
        kind: 'zellij',
        sessionName: 'session-a',
        paneId: 'terminal_1',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      },
      {
        text: 'prompt',
        multiline: false,
        origin: { kind: 'ui_pending', nonce: 'nonce-a' },
        scheduling: {},
      },
    )).resolves.toMatchObject({ status: 'injected' });

    expect(timeouts.write).toBeGreaterThan(123);
    expect(timeouts.enter).toBeGreaterThan(0);
    expect(timeouts.enter).toBeLessThanOrEqual(123);
  });

  it('reports unstable input state when zellij screen output changes during the quiet probe', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: vi
        .fn()
        .mockResolvedValueOnce('claude> hel')
        .mockResolvedValueOnce('claude> hello'),
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      inputStabilityDelayMs: 0,
      actions,
    });

    await expect(adapter.captureInputState?.({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    })).resolves.toMatchObject({
      stable: false,
      currentInput: 'claude> hello',
    });
  });

  it('defers injection when scheduled quiet input is unstable', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        calls.push('write');
      },
      sendEnter: async () => {
        calls.push('enter');
      },
      sendEscape: async () => {
        calls.push('escape');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: vi
        .fn()
        .mockResolvedValueOnce('claude> hel')
        .mockResolvedValueOnce('claude> hello'),
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      inputStabilityDelayMs: 0,
      actions,
    });

    await expect(
      adapter.injectUserPrompt(
        { kind: 'zellij', sessionName: 'session-a', paneId: 'terminal_1', attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } },
        { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: { deferredUntilQuietMs: 250 } },
      ),
    ).resolves.toEqual({ status: 'deferred', reason: 'user_typing', retryAfterMs: 250 });
    expect(calls).toEqual([]);
  });

  it('does not authorize a final-check deferral and makes a post-authorization write throw ambiguous', async () => {
    const calls: string[] = [];
    let stable = false;
    let captureCount = 0;
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      pasteText: async () => {
        calls.push('paste');
        throw new Error('write race');
      },
      writeBytesChunked: async () => {
        calls.push('write');
        throw new Error('write race');
      },
      sendEnter: async () => { calls.push('enter'); },
      sendEscape: async () => undefined,
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => stable ? 'idle' : captureCount++ === 0 ? 'draft-a' : 'draft-b',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const authorizeBeforeWrite = vi.fn(async () => {
      calls.push('authorize_write');
      return true;
    });
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      inputStabilityDelayMs: 0,
      actions,
    });
    const input = {
      text: 'attempt prompt',
      multiline: false,
      origin: { kind: 'ui_pending' as const, nonce: 'attempt-zellij' },
      scheduling: { deferredUntilQuietMs: 1 },
    };

    await expect(adapter.injectUserPrompt(
      { kind: 'zellij', sessionName: 'session-a', paneId: 'terminal_1', attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } },
      input,
      { authorizeBeforeWrite },
    )).resolves.toMatchObject({ status: 'deferred', reason: 'user_typing' });
    expect(authorizeBeforeWrite).not.toHaveBeenCalled();

    stable = true;
    captureCount = 0;
    calls.length = 0;
    await expect(adapter.injectUserPrompt(
      { kind: 'zellij', sessionName: 'session-a', paneId: 'terminal_1', attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } },
      input,
      { authorizeBeforeWrite },
    )).resolves.toMatchObject({
      status: 'failed',
      phase: 'during_write',
      duplicateRisk: 'possible',
    });
    expect(calls[0]).toBe('authorize_write');
    expect(authorizeBeforeWrite).toHaveBeenCalledTimes(1);
  });

  it('interrupts the active zellij turn with a bounded Escape action', async () => {
    const calls: string[] = [];
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async (params: { paneId: string; timeoutMs?: number }) => {
        calls.push(`escape:${params.paneId}:${params.timeoutMs ?? 'none'}`);
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions & {
      sendEscape(params: { paneId: string }): Promise<void>;
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 1_234,
    });
    const interruptTurn = (adapter as unknown as {
      interruptTurn?: (handle: {
        kind: 'zellij';
        sessionName: string;
        paneId?: string;
        attachMetadata: { attachStrategy: 'terminal_host'; topology: 'shared' };
      }) => Promise<void>;
    }).interruptTurn;

    expect(interruptTurn).toBeTypeOf('function');
    await interruptTurn?.({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    });

    expect(calls).toEqual(['escape:terminal_1:1234']);
  });

  it('uses the only live command pane when zellij rekeys the tracked pane after launch', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}:${params.text}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [
        { id: 0, is_plugin: true, terminal_command: null },
        { id: 0, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
        { id: 2, is_plugin: false, terminal_command: null },
      ],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: true,
      paneDead: false,
      paneCurrentCommand: '/managed/node claude_local_launcher.cjs',
    });
    await expect(adapter.injectUserPrompt(
      handle,
      { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
    )).resolves.toMatchObject({ status: 'injected' });

    expect(calls).toEqual(['write:terminal_0:prompt', 'enter:terminal_0']);
  });

  it('does not retarget a missing zellij pane to an unrelated sole command pane', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [
        { id: 0, is_plugin: false, terminal_command: '/bin/zsh' },
      ],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      expectedCommandFragments: ['/managed/node', 'terminal_launch_spec_runner.cjs'],
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.injectUserPrompt(
      handle,
      { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
    )).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(calls).toEqual([]);
  });

  it('does not retarget a missing zellij pane to a launch-spec runner with a different spec path', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [
        { id: 0, is_plugin: false, terminal_command: '/managed/node terminal_launch_spec_runner.cjs /tmp/spec-b/launch.json' },
      ],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      expectedCommandFragments: ['/managed/node', 'terminal_launch_spec_runner.cjs', '/tmp/spec-a/launch.json'],
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.injectUserPrompt(
      handle,
      { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
    )).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(calls).toEqual([]);
  });

  it('does not retarget a missing zellij pane to a sole pane that only shares the executable', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [
        { id: 0, is_plugin: false, terminal_command: '/managed/node' },
      ],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.injectUserPrompt(
      handle,
      { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
    )).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(calls).toEqual([]);
  });

  it('does not trust an exact zellij pane id when expected command metadata is absent', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [
        { id: 1, is_plugin: false },
      ],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: true,
      paneDead: false,
    });
    await expect(adapter.injectUserPrompt(
      handle,
      { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
    )).resolves.toMatchObject({ status: 'deferred', reason: 'pane_initializing' });

    expect(calls).toEqual([]);
  });

  it('does not trust an exact zellij pane id when command metadata only shares the executable with another script', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [
        { id: 1, is_plugin: false, terminal_command: '/managed/node unrelated_launcher.cjs' },
      ],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.injectUserPrompt(
      handle,
      { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
    )).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(calls).toEqual([]);
  });

  it('does not trust an exact zellij pane id when command metadata proves unrelated reuse', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [
        { id: 1, is_plugin: false, terminal_command: '/bin/zsh' },
      ],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.injectUserPrompt(
      handle,
      { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
    )).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(calls).toEqual([]);
  });

  it('does not retarget a missing zellij pane when multiple live command panes are plausible', async () => {
    const calls: string[] = [];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async (params) => {
        calls.push(`write:${params.paneId}`);
      },
      sendEnter: async (params) => {
        calls.push(`enter:${params.paneId}`);
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [
        { id: 0, is_plugin: false, terminal_command: '/managed/node claude_local_launcher.cjs' },
        { id: 2, is_plugin: false, terminal_command: '/other/node claude_local_launcher.cjs' },
      ],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      expectedCommandFragments: ['node', 'claude_local_launcher.cjs'],
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.injectUserPrompt(
      handle,
      { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
    )).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });

    expect(calls).toEqual([]);
  });

  it('defers a transient missing zellij pane before writing', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(
      adapter.injectUserPrompt(
        { kind: 'zellij', sessionName: 'session-a', paneId: 'missing', attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } },
        { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: { retryAfterMs: 250 } },
      ),
    ).resolves.toMatchObject({ status: 'deferred', reason: 'pane_initializing', retryAfterMs: 250 });
  });

  it('classifies an inactive zellij session as a dead host state', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => {
        throw new Error('zellij list-panes failed: There is no active session!');
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      paneScreenDumpError: expect.stringContaining('There is no active session'),
    });
    await expect(
      adapter.injectUserPrompt(
        handle,
        { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
      ),
    ).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });
  });

  it('returns an inconclusive liveness observation when list-panes times out', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      listPanes: async () => {
        throw new ZellijActionTimeoutError('list-panes');
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    })).resolves.toMatchObject({
      paneAlive: false,
      probeInconclusive: true,
      paneScreenDumpError: expect.stringContaining('timed out'),
    });
  });

  it('treats held exited zellij command panes as dead', async () => {
    const exitedPanes = JSON.parse('[{"id":1,"is_plugin":false,"is_focused":true,"terminal_command":"/managed/node","exited":true,"exit_status":127}]') as ZellijPane[];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => exitedPanes,
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
      paneExitStatus: 127,
    });
    await expect(
      adapter.injectUserPrompt(
        handle,
        { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
      ),
    ).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });
  });

  it('redacts zellij pane current command before returning liveness diagnostics', async () => {
    const secretCommand = 'env CLAUDE_CODE_OAUTH_TOKEN=raw-secret /managed/node --api-key sk-ant-secret-value';
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true, terminal_command: secretCommand }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    const liveness = await adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    });

    expect(liveness.paneCurrentCommand).toContain('[redacted-token]');
    expect(liveness.paneCurrentCommand).not.toContain('raw-secret');
    expect(liveness.paneCurrentCommand).not.toContain('sk-ant-secret-value');
  });

  it('captures a bounded redacted screen dump when a zellij command pane is dead', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{
        id: 1,
        is_plugin: false,
        is_focused: true,
        terminal_command: '/managed/node',
        exited: true,
        exit_status: 127,
      }],
      dumpScreen: async () => [
        'API Error: 401 Invalid authentication credentials',
        'ANTHROPIC_API_KEY=sk-ant-secret-value',
        'OPENAI_API_KEY=sk-openai-secret-value',
        'GEMINI_ACCESS_TOKEN=gemini-access-secret',
        'ANTHROPIC_AUTH_TOKEN: anthropic-auth-secret',
        'CLAUDE_CODE_OAUTH_TOKEN: claude-oauth-secret',
        'AWS_SECRET_ACCESS_KEY: aws-secret-value',
        'anthropic_api_key=lowercase-anthropic-secret',
        'npm_config_//registry.npmjs.org/:_authToken=npm-auth-token-secret',
        'MixedAccessToken: mixed-access-secret',
        'refresh_token=provider-refresh-secret',
        'Authorization: Bearer provider-bearer-secret',
      ].join('\n'),
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    const liveness = await adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    });

    expect(liveness).toMatchObject({
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
      paneExitStatus: 127,
      paneScreenDumpCaptured: true,
      paneScreenDumpTruncated: false,
    });
    expect(liveness).not.toHaveProperty('paneScreenDump');
  });

  it('redacts sensitive dump-screen error diagnostics when a zellij command pane is dead', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{
        id: 1,
        is_plugin: false,
        is_focused: true,
        terminal_command: '/managed/node',
        exited: true,
        exit_status: 127,
      }],
      dumpScreen: async () => {
        throw new Error('dump failed: ANTHROPIC_API_KEY=sk-ant-secret-value Authorization: Bearer provider-bearer-secret');
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    const liveness = await adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    });

    expect(liveness.paneScreenDumpError).toContain('ANTHROPIC_API_KEY=[redacted-token]');
    expect(liveness.paneScreenDumpError).not.toContain('sk-ant-secret-value');
    expect(liveness.paneScreenDumpError).not.toContain('provider-bearer-secret');
  });

  it('treats held zellij command panes as dead even before zellij reports an exit', async () => {
    const heldPanes = JSON.parse(
      '[{"id":1,"is_plugin":false,"is_focused":true,"terminal_command":"/managed/node","exited":false,"is_held":true}]',
    ) as ZellijPane[];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => heldPanes,
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host' as const, topology: 'shared' as const },
    };

    await expect(adapter.evaluateLiveness(handle)).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
    });
    await expect(
      adapter.injectUserPrompt(
        handle,
        { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
      ),
    ).resolves.toMatchObject({ status: 'failed', reason: 'pane_dead', recoverable: false });
  });

  it('ignores zellij plugin panes when resolving terminal liveness by pane id', async () => {
    const panes = JSON.parse(`[
      {"id":0,"is_plugin":true,"plugin_url":"zellij:link","exited":false,"exit_status":null},
      {"id":0,"is_plugin":false,"is_focused":true,"terminal_command":"/managed/node","exited":true,"exit_status":127}
    ]`) as ZellijPane[];
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_0', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => panes,
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_0',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    })).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      paneCurrentCommand: '/managed/node',
    });
  });

  it('bounds zellij liveness inspection with the configured action timeout', async () => {
    let observedTimeoutMs: number | undefined;
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async (params) => {
        observedTimeoutMs = params.timeoutMs;
        return [{ id: 1, is_plugin: false, is_focused: true }];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      actionTimeoutMs: 1_234,
    });

    await expect(adapter.evaluateLiveness({
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    })).resolves.toMatchObject({ paneAlive: true, paneDead: false });
    expect(observedTimeoutMs).toBe(1_234);
  });

  it('fails with no_target when the handle has no zellij pane id', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => {
        throw new Error('should not inspect');
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(
      adapter.injectUserPrompt(
        { kind: 'zellij', sessionName: 'session-a', attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } },
        { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: {} },
      ),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'no_target',
      phase: 'liveness',
      duplicateRisk: 'none',
      recoverable: true,
    });
  });

  it('defers when zellij liveness probing is inconclusive', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new Error('should not write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => {
        throw new Error('zellij missing');
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(
      adapter.injectUserPrompt(
        { kind: 'zellij', sessionName: 'session-a', paneId: 'terminal_1', attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } },
        { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: { retryAfterMs: 250 } },
      ),
    ).resolves.toEqual({
      status: 'deferred',
      reason: 'pane_initializing',
      retryAfterMs: 250,
    });
  });

  it('fails with timeout when zellij prompt injection exceeds its deadline', async () => {
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => {
        throw new ZellijActionTimeoutError('write');
      },
      sendEnter: async () => {
        throw new Error('should not submit');
      },
      sendEscape: async () => {
        throw new Error('should not interrupt');
      },
      listPanes: async () => [{ id: 1, is_plugin: false, is_focused: true }],
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    await expect(
      adapter.injectUserPrompt(
        { kind: 'zellij', sessionName: 'session-a', paneId: 'terminal_1', attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } },
        { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: { timeoutMs: 5 } },
      ),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'timeout',
      phase: 'during_write',
      duplicateRisk: 'possible',
      recoverable: true,
    });
  });

  it('does not report timeout while a zellij write command can still continue', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let finishWrite: (() => void) | undefined;
    const actions: ZellijActions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1', stderr: '' }),
      writeBytesChunked: async () => new Promise<void>((resolve) => {
        calls.push('write');
        finishWrite = resolve;
      }),
      sendEnter: async () => {
        calls.push('enter');
      },
      sendEscape: async () => {
        calls.push('escape');
      },
      listPanes: async () => {
        calls.push('list');
        return [{ id: 1, is_plugin: false, is_focused: true }];
      },
      dumpScreen: async () => '',
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
    });

    let settled = false;
    const injection = adapter.injectUserPrompt(
      { kind: 'zellij', sessionName: 'session-a', paneId: 'terminal_1', attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } },
      { text: 'prompt', multiline: false, origin: { kind: 'ui_pending', nonce: 'nonce-a' }, scheduling: { timeoutMs: 5 } },
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);

    finishWrite?.();
    await expect(injection).resolves.toMatchObject({ status: 'injected' });
    expect(calls).toEqual(['list', 'write', 'enter']);
  });

  it('reuses a fresh liveness inspection across evaluateLiveness + captureInputState within a tick (R-E2)', async () => {
    let listCount = 0;
    let dumpCount = 0;
    const actions = {
      attachCreateBackground: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runCommand: async () => ({ exitCode: 0, stdout: 'terminal_1\n', stderr: '' }),
      writeBytesChunked: async () => undefined,
      sendEnter: async () => undefined,
      sendEscape: async () => undefined,
      listPanes: async () => {
        listCount += 1;
        return [{ id: 1, is_plugin: false, is_focused: true }];
      },
      dumpScreen: async () => {
        dumpCount += 1;
        return `screen-${dumpCount}`;
      },
      closePane: async () => undefined,
      killSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      deleteSession: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    } as ZellijActions;
    const adapter = createZellijTerminalHostAdapter({
      zellijBinary: '/tools/zellij',
      happyHomeDir: '/home/happier',
      actions,
      inputStabilityDelayMs: 0,
    });
    const handle = {
      kind: 'zellij',
      sessionName: 'session-a',
      paneId: 'terminal_1',
      attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
    } as const;

    // The readiness/liveness bridges call these back-to-back each poll tick. The second call must
    // reuse the first inspection instead of re-running listPanes.
    await adapter.evaluateLiveness(handle);
    await adapter.captureInputState?.(handle);

    expect(listCount).toBe(1);
  });
});
