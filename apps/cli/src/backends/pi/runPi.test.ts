import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { PI_BROKER_SELECTIONS_ENV, serializePiBrokerSelections } from '@/backends/pi/brokerExtension';
import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const { runStandardAcpProviderMock, createPiAcpRuntimeMock } = vi.hoisted(() => ({
  runStandardAcpProviderMock: vi.fn(),
  createPiAcpRuntimeMock: vi.fn(),
}));

vi.mock('@/daemon/startDaemon', () => ({
  initialMachineMetadata: {
    host: 'host',
    platform: 'darwin',
    happyCliVersion: '1.0.0',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/.happy',
    happyLibDir: '/tmp/lib',
  },
}));

vi.mock('@/agent/runtime/runStandardAcpProvider', () => ({
  runStandardAcpProvider: runStandardAcpProviderMock,
}));

vi.mock('@/backends/pi/acp/runtime', () => ({
  createPiAcpRuntime: createPiAcpRuntimeMock,
}));

vi.mock('@/backends/pi/acp/backend', async () => {
  const actual = await vi.importActual<typeof import('@/backends/pi/acp/backend')>('@/backends/pi/acp/backend');
  return {
    ...actual,
    buildPiToolsForPermissionMode: actual.buildPiToolsForPermissionMode,
  };
});

vi.mock('@/backends/pi/ui/PiTerminalDisplay', () => ({
  PiTerminalDisplay: vi.fn(),
}));

describe('runPi', () => {
  const credentials: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array([1]) },
  };

  let runPi: typeof import('./runPi').runPi;

  beforeAll(async () => {
    ({ runPi } = await import('./runPi'));
  }, 60_000);

  beforeEach(() => {
    runStandardAcpProviderMock.mockReset();
    runStandardAcpProviderMock.mockResolvedValue(undefined);
    createPiAcpRuntimeMock.mockReset();
  });

  it('disables MCP server resolution for Pi sessions', async () => {
    await runPi({ credentials });

    expect(runStandardAcpProviderMock).toHaveBeenCalledTimes(1);
    expect(runStandardAcpProviderMock.mock.calls[0]?.[1]).toMatchObject({
      flavor: 'pi',
      supportsMcpServers: false,
    });
  });

  function withTty<T>(hasTTY: boolean, run: () => Promise<T>): Promise<T> {
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: hasTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: hasTTY, configurable: true });
    const restore = (stream: NodeJS.ReadStream | NodeJS.WriteStream, descriptor: PropertyDescriptor | undefined) => {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else delete (stream as { isTTY?: boolean }).isTTY;
    };
    return run().finally(() => {
      restore(process.stdin, stdin);
      restore(process.stdout, stdout);
    });
  }

  function createRuntimeParams() {
    return {
      directory: '/repo',
      machineId: 'machine-1',
      session: { sessionId: 'session-1' },
      messageBuffer: {},
      mcpServers: {},
      permissionHandler: {},
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      getAbortSignal: () => new AbortController().signal,
      memoryRecallGuidanceEnabled: false,
      processEnv: {},
      providerInputConsumer: {},
      requestRunnerTermination: vi.fn(),
    } as never;
  }

  it('runs the native Pi terminal with shared local control when started from a terminal TTY', async () => {
    await withTty(true, () => runPi({ credentials, startedBy: 'terminal' }));

    const config = runStandardAcpProviderMock.mock.calls[0]?.[1];
    expect(config.startRuntimeBeforeFirstPrompt).toBe(true);
    expect(config.shouldRenderTerminalDisplay()).toBe(false);
    expect(config.resolveKeepAliveMode()).toBe('local');
    // Pi's tools are fixed at launch; a changing key would reset the runtime under a live TUI.
    expect(config.resolvePermissionModeQueueKey('read-only')).toBe(config.resolvePermissionModeQueueKey('default'));
    // The runtime is the user's live Pi: /clear and restart-only settings are refused with a notice.
    expect(config.describeUnavailableRuntimeReset('clear')).toEqual(expect.any(String));

    config.createRuntime(createRuntimeParams());
    expect(createPiAcpRuntimeMock.mock.calls[0]?.[0].sharedTerminal).toBeDefined();

    let agentState: Record<string, unknown> = {};
    const session = {
      updateAgentState: vi.fn((updater: (state: Record<string, unknown>) => Record<string, unknown>) => {
        agentState = updater(agentState);
      }),
      sendAgentMessage: vi.fn(),
    };
    await config.onAfterStart({ session, runtime: {}, initialControlsApplied: true, prepareLocalAttachment: async () => false });
    expect(agentState.localControl).toEqual({
      attached: true,
      topology: 'shared',
      remoteWritable: true,
      canAttach: false,
      canDetach: false,
    });
    await config.onDispose({ session, runtime: {} });
  });

  it.each([
    ['daemon-started', { startedBy: 'daemon' as const }, true],
    ['terminal without a TTY', { startedBy: 'terminal' as const }, false],
  ])('keeps the Pi RPC runtime when %s', async (_label, start, hasTTY) => {
    await withTty(hasTTY, () => runPi({ credentials, ...start }));

    const config = runStandardAcpProviderMock.mock.calls[0]?.[1];
    expect(config.startRuntimeBeforeFirstPrompt).toBeUndefined();
    expect(config.shouldRenderTerminalDisplay).toBeUndefined();
    expect(config.describeUnavailableRuntimeReset).toBeUndefined();
    config.createRuntime(createRuntimeParams());
    expect(createPiAcpRuntimeMock.mock.calls[0]?.[0].sharedTerminal).toBeUndefined();
  });

  it('tells the terminal user before falling back to RPC for connected-service credentials', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const previous = process.env[PI_BROKER_SELECTIONS_ENV];
    process.env[PI_BROKER_SELECTIONS_ENV] = serializePiBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
    });
    let stderrWrites = 0;
    try {
      await withTty(true, () => runPi({ credentials, startedBy: 'terminal' }));
      stderrWrites = stderr.mock.calls.length;
    } finally {
      if (previous === undefined) delete process.env[PI_BROKER_SELECTIONS_ENV];
      else process.env[PI_BROKER_SELECTIONS_ENV] = previous;
      stderr.mockRestore();
    }

    expect(runStandardAcpProviderMock.mock.calls[0]?.[1].startRuntimeBeforeFirstPrompt).toBeUndefined();
    expect(stderrWrites).toBe(1);
  });

  it('uses the native Pi tool catalog as the unrestricted permission queue key', async () => {
    await runPi({ credentials });

    const config = runStandardAcpProviderMock.mock.calls[0]?.[1];
    expect(config.resolvePermissionModeQueueKey('default')).toBe('native');
    expect(config.resolvePermissionModeQueueKey('safe-yolo')).toBe('native');
    expect(config.resolvePermissionModeQueueKey('yolo')).toBe('native');
    expect(config.resolvePermissionModeQueueKey('read-only')).toBe('read,grep,find,ls');
  });

  describe('--continue', () => {
    const envScope = createEnvKeyScope([
      'HOME',
      'USERPROFILE',
      'PWD',
      'HAPPIER_STACK_INVOKED_CWD',
      'HAPPIER_SESSION_REQUESTED_DIRECTORY',
      'PI_CODING_AGENT_DIR',
      'PI_CODING_AGENT_SESSION_DIR',
    ]);
    let root: string;
    let cwd: string;
    let physicalCwd: string;
    let agentDir: string;
    let processCwd: string;
    let cwdSpy: { mockRestore: () => void } | null = null;

    beforeEach(async () => {
      root = await createTempDir('happier-run-pi-continue-');
      cwd = join(root, 'project');
      agentDir = join(root, 'agent');
      await mkdir(cwd, { recursive: true });
      // Pi encodes its session dir from its own process.cwd(), which is the physical path.
      physicalCwd = await realpath(cwd);
      envScope.patch({
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'home'),
        PWD: undefined,
        HAPPIER_STACK_INVOKED_CWD: undefined,
        HAPPIER_SESSION_REQUESTED_DIRECTORY: undefined,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: undefined,
      });
      processCwd = cwd;
      cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => processCwd);
    });

    afterEach(async () => {
      cwdSpy?.mockRestore();
      envScope.restore();
      await removeTempDir(root);
    });

    async function writeSession(name: string, piCwd = physicalCwd): Promise<string> {
      const dir = join(agentDir, 'sessions', formatPiSessionDirectoryForCwd(piCwd));
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, name);
      await writeFile(filePath, `${JSON.stringify({ type: 'session', version: 3, id: 'pi-1', timestamp: '', cwd: piCwd })}\n`);
      return filePath;
    }

    it('resumes the newest Pi session file for the working directory', async () => {
      const sessionFile = await writeSession('2026-11-16T00-00-00-000Z_pi-1.jsonl');

      await runPi({ credentials, continueRecentSession: true });

      expect(runStandardAcpProviderMock.mock.calls[0]?.[0].resume).toBe(sessionFile);
    });

    // POSIX getcwd() reports the physical path; Windows reports the launch path unresolved (below).
    it.skipIf(process.platform === 'win32')('on POSIX looks in the physical directory Happier launches Pi in, not the runner cwd', async () => {
      // hstack runs the CLI from the repo root and passes the user's (here symlinked) directory.
      processCwd = join(root, 'repo-root');
      await mkdir(processCwd, { recursive: true });
      const link = join(root, 'project-link');
      await symlink(cwd, link, 'junction');
      envScope.patch({ HAPPIER_STACK_INVOKED_CWD: link });
      const sessionFile = await writeSession('2026-11-16T00-00-00-000Z_pi-1.jsonl');

      await runPi({ credentials, continueRecentSession: true });

      expect(runStandardAcpProviderMock.mock.calls[0]?.[0].resume).toBe(sessionFile);
    });

    it('on Windows looks in the directory as launched, since Pi\'s process.cwd() keeps junctions there', async () => {
      const link = join(root, 'project-link');
      await symlink(cwd, link, 'junction');
      envScope.patch({ HAPPIER_STACK_INVOKED_CWD: link });
      const sessionFile = await writeSession('2026-11-16T00-00-00-000Z_pi-1.jsonl', link);
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        await runPi({ credentials, continueRecentSession: true });
      } finally {
        if (platform) Object.defineProperty(process, 'platform', platform);
      }

      expect(runStandardAcpProviderMock.mock.calls[0]?.[0].resume).toBe(sessionFile);
    });

    it('keeps an explicit --resume over --continue', async () => {
      await writeSession('2026-11-16T00-00-00-000Z_pi-1.jsonl');

      await runPi({ credentials, continueRecentSession: true, resume: 'explicit-id' });

      expect(runStandardAcpProviderMock.mock.calls[0]?.[0].resume).toBe('explicit-id');
    });

    it('starts a new session and names the directory when there is no previous session', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      let stderrText = '';
      try {
        await runPi({ credentials, continueRecentSession: true });
        stderrText = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      } finally {
        stderr.mockRestore();
      }

      expect(runStandardAcpProviderMock.mock.calls[0]?.[0].resume).toBeUndefined();
      expect(stderrText).toContain(physicalCwd);
    });
  });
});
