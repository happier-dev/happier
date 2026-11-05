import { access, rmdir, unlink } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

const inventory = vi.hoisted(() => ({ socketPath: '' }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async () => ({
      stdout: JSON.stringify({ sessions: [{ name: 'work', socket_path: inventory.socketPath, running: true }] }),
      stderr: '',
    }),
  }),
}));

import { isTerminalHostStartupError } from '@/integrations/terminalHost/errors';
import { isClaudeUnifiedTerminalRuntimeIssueError } from '@/backends/claude/unifiedTerminal/surfaceClaudeUnifiedTerminalRuntimeIssue';
import { createTerminalAttachmentId } from '@/terminal/attachment/terminalAttachmentInfo';
import { prepareOwnedTerminalSpawn } from '@/terminal/runtime/terminalLaunchSpec';

import { createHerdrTerminalHostAdapter } from './adapter';
import { withHerdrApi } from './herdrApi.testkit';

const launch = { sessionName: 'work', workingDirectory: tmpdir(), spawnArgv: [process.execPath, '--version'], spawnEnv: {}, isolatedEnv: true };
const adapterFor = (socketPath: string) => {
  inventory.socketPath = socketPath;
  return createHerdrTerminalHostAdapter({ binary: 'herdr', sessionName: 'work', actionTimeoutMs: 100, startupTimeoutMs: 100 });
};

function readSpecPath(requests: readonly Readonly<{ method: string; params: Record<string, unknown> }>[]): string {
  const layout = requests.find((request) => request.method === 'layout.apply');
  const root = layout?.params.root as { command?: string[] } | undefined;
  return root?.command?.[2] ?? '';
}

async function discardSpec(specPath: string): Promise<void> {
  if (!specPath) return;
  await unlink(specPath).catch(() => {});
  await rmdir(dirname(specPath)).catch(() => {});
}

describe('Herdr terminal host creation', () => {
  it.each(['spawned', 'failed'] as const)('preserves one native handoff and its actual %s startup evidence', async (expected) => {
    await withHerdrApi(async (api) => {
      const prepared = await prepareOwnedTerminalSpawn({
        command: expected === 'spawned' ? process.execPath : '/nonexistent/happier-native-test',
        args: expected === 'spawned' ? ['--version'] : [], cwd: tmpdir(), env: process.env,
        reportNativeSpawn: true,
        diagnostics: { sessionId: 'single-native-handoff', logsDir: tmpdir(), sessionExitDir: tmpdir() },
      });
      const boundary: { child?: ChildProcess; completed?: Promise<void> } = {};
      api.beforeResponse.set('layout.apply', () => {
        const request = api.requests.at(-1)!;
        const root = request.params.root as { command: string[] };
        const [command, ...args] = root.command;
        boundary.child = spawn(command!, args, { cwd: tmpdir(), env: prepared.spawnEnv, stdio: 'ignore' });
        boundary.completed = new Promise((resolve, reject) => {
          boundary.child!.once('error', reject);
          boundary.child!.once('exit', () => resolve());
        });
      });
      try {
        const options = { ...launch, spawnArgv: prepared.spawnArgv, spawnEnv: prepared.spawnEnv, preparedLaunch: prepared };
        await adapterFor(api.socketPath).createOrAttachHost(options);
        await boundary.completed;
        expect(await prepared.awaitNativeSpawnResult!(Date.now() + 1_000, 10)).toBe(expected);
        const root = api.requests.find(request => request.method === 'layout.apply')?.params.root as { command: string[] };
        expect(root.command).toEqual(prepared.spawnArgv);
      } finally {
        boundary.child?.kill('SIGKILL');
        await boundary.completed;
        await prepared.cleanupUnreadArtifacts?.();
        const submittedSpec = readSpecPath(api.requests);
        if (submittedSpec !== prepared.launchSpecPath) await discardSpec(submittedSpec);
      }
    });
  });
  it('reports actionable host-version admission before a managed command is submitted', async () => {
    await withHerdrApi(async (api) => {
      await expect(adapterFor(api.socketPath).createOrAttachHost(launch)).rejects.toMatchObject({
        code: 'terminal_host_startup_failed', hostKind: 'herdr', reason: 'server_version_unsupported',
        launchFailure: { launchDisposition: 'not_started', cleanupIncomplete: false },
      });
      expect(api.requests.map((request) => request.method)).toEqual(['session.snapshot']);
      expect([...api.panes]).toEqual([]);
    }, { serverVersion: '0.9.1' });
  });
  it('proves non-creation when server admission fails before any layout is submitted', async () => {
    await withHerdrApi(async (api) => {
      api.faults.set('session.snapshot', 'error');
      await expect(adapterFor(api.socketPath).createOrAttachHost(launch)).rejects.toMatchObject({
        launchDisposition: 'not_started', cleanupIncomplete: false,
      });
      expect(api.requests.some(request => request.method === 'layout.apply')).toBe(false);
    });
  });
  it.each([false, true])('submits large staged input once, but never submits or replays a partial failed write (fail=%s)', async (fail) => {
    await withHerdrApi(async (api) => {
      api.panes.add('managed');
      const text = '\\🌈'.repeat(400_000);
      if (fail) api.beforeResponse.set('pane.send_input', () => {
        if (api.requests.filter((request) => request.method === 'pane.send_input').length === 2) {
          api.faults.set('pane.send_input', 'disconnect');
        }
      });
      const result = await createHerdrTerminalHostAdapter({
        binary: 'herdr', sessionName: 'work', actionTimeoutMs: 5_000, startupTimeoutMs: 5_000,
      }).injectUserPrompt({
        kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
        terminalId: 'terminal_1', paneId: 'managed',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      }, { text, multiline: false, origin: { kind: 'rpc', nonce: 'large-prompt' }, scheduling: {} });
      const writes = api.requests.filter((request) => request.method === 'pane.send_input');
      const enters = api.requests.filter((request) => request.method === 'pane.send_keys');
      if (fail) {
        expect(result).toMatchObject({ status: 'failed', phase: 'during_write', duplicateRisk: 'possible' });
        expect(writes).toHaveLength(2);
        expect(enters).toEqual([]);
      } else {
        expect(result).toMatchObject({ status: 'injected', bytesWritten: Buffer.byteLength(text) });
        expect(writes.map((request) => request.params.text).join('')).toBe(text);
        expect(enters.map((request) => request.params.keys)).toEqual([['enter']]);
      }
    }, { maxInitialRequestBytes: 1024 * 1024 });
  });

  it('refuses recovery into an older running server without replacing the retained host', async () => {
    await withHerdrApi(async (api) => {
      api.panes.add('managed');
      const attachmentId = createTerminalAttachmentId();
      await expect(adapterFor(api.socketPath).adoptExistingHost!({
        kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
        terminalId: 'terminal_1', paneId: 'old-pane', attachmentId,
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      })).rejects.toMatchObject({ code: 'unsupported_server_version' });
      expect([...api.panes]).toEqual(['managed']);
      expect(api.requests.map((request) => request.method)).toEqual(['session.snapshot']);
    }, { serverVersion: '0.9.1' });
  });

  it('adopts a moved terminal on the admitted server without creating another pane', async () => {
    await withHerdrApi(async (api) => {
      api.panes.add('managed');
      const attachmentId = createTerminalAttachmentId();
      await expect(adapterFor(api.socketPath).adoptExistingHost!({
        kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
        terminalId: 'terminal_1', paneId: 'old-pane', attachmentId,
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      })).resolves.toMatchObject({ paneId: 'managed', attachmentId });
      expect(api.requests.map((request) => request.method)).toEqual(['session.snapshot', 'pane.list']);
      expect([...api.panes]).toEqual(['managed']);
    });
  });

  it.skipIf(process.platform === 'win32')('preserves stopped disposition and both causes when launch handoff removal fails', async () => {
    await withHerdrApi(async (api) => {
      api.faults.set('pane.get', 'error');
      api.beforeResponse.set('pane.get', () => chmodSync(dirname(readSpecPath(api.requests)), 0o500));
      try {
        const error = await adapterFor(api.socketPath).createOrAttachHost(launch).catch((failure: unknown) => failure);
        expect(error).toMatchObject({
          launchDisposition: 'stopped', cleanupIncomplete: true,
          errors: [expect.objectContaining({ code: 'pane.get_failed' }), expect.objectContaining({ code: 'EACCES' })],
        });
        expect([...api.panes]).toEqual([]);
        await expect(access(readSpecPath(api.requests))).resolves.toBeUndefined();
      } finally {
        const specPath = readSpecPath(api.requests);
        if (specPath) chmodSync(dirname(specPath), 0o700);
        await discardSpec(specPath);
      }
    });
  });

  it('binds the attachment to the requested named Herdr session', async () => {
    await withHerdrApi(async (api) => {
      try {
        await expect(adapterFor(api.socketPath).createOrAttachHost(launch)).resolves.toMatchObject({
          kind: 'herdr', sessionName: 'work', socketPath: api.socketPath, terminalId: 'terminal_1',
        });
      } finally {
        await discardSpec(readSpecPath(api.requests));
      }
    });
  });

  it('keeps the requested server namespace separate from each pane display label', async () => {
    await withHerdrApi(async (api) => {
      try {
        const adapter = adapterFor(api.socketPath);
        for (const label of ['happier-claude-first', 'happier-codex-second']) {
          const options = { ...launch, label };
          const handle = await adapter.createOrAttachHost(options);
          expect(handle).toMatchObject({ sessionName: 'work', socketPath: api.socketPath });
          expect(api.requests.filter((request) => request.method === 'layout.apply').at(-1)?.params).toMatchObject({
            tab_label: label, root: { label },
          });
        }
      } finally {
        for (const request of api.requests.filter((request) => request.method === 'layout.apply')) {
          const root = request.params.root as { command?: string[] };
          await discardSpec(root.command?.[2] ?? '');
        }
      }
    });
  });

  it('discards the unread secret-bearing spec once failed creation is confirmed stopped', async () => {
    await withHerdrApi(async (api) => {
      api.faults.set('pane.get', 'error');
      await expect(adapterFor(api.socketPath).createOrAttachHost({
        ...launch, spawnEnv: { HERDR_TEST_SECRET: 'sensitive-test-value' },
      })).rejects.toMatchObject({ launchDisposition: 'stopped' });
      const specPath = readSpecPath(api.requests);
      expect(specPath).not.toBe('');
      await expect(access(specPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it.each(['timeout', 'disconnect'] as const)('keeps the launch handoff and blocks startup retry after an unconfirmed %s', async (fault) => {
    await withHerdrApi(async (api) => {
      api.faults.set('layout.apply', fault);
      try {
        const error = await adapterFor(api.socketPath).createOrAttachHost({
          ...launch, spawnEnv: { HERDR_TEST_SECRET: 'sensitive-test-value' },
        }).catch((failure: unknown) => failure);
        const specPath = readSpecPath(api.requests);
        expect(specPath).not.toBe('');
        await expect(access(specPath)).resolves.toBeUndefined();
        expect(error).toMatchObject({ launchDisposition: 'unconfirmed' });
        expect(isTerminalHostStartupError(error)).toBe(false);
        expect(isClaudeUnifiedTerminalRuntimeIssueError(error)).toBe(false);
        expect(String(error)).not.toContain('sensitive-test-value');
        expect([...api.panes]).toEqual(['managed']);
      } finally {
        await discardSpec(readSpecPath(api.requests));
      }
    });
  });
});

describe('Herdr terminal host liveness', () => {
  it('reports foreground process identities of a live pane', async () => {
    await withHerdrApi(async (api) => {
      api.panes.add('managed');
      const liveness = await adapterFor(api.socketPath).evaluateLiveness({
        kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
        terminalId: 'terminal_1', paneId: 'managed',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      });
      expect(liveness).toMatchObject({
        paneAlive: true,
        panePid: 42,
        paneForegroundProcesses: [{ pid: 101, argv: ['/bin/bash'] }, { pid: 202, argv: ['/managed/claude', '--session', 'x'] }],
      });
    }, {
      response: (method) => {
        if (method !== 'pane.process_info') return undefined;
        return {
          process_info: {
            shell_pid: 42,
            foreground_processes: [
              { pid: 101, argv: ['/bin/bash'] },
              { pid: 202, argv: ['/managed/claude', '--session', 'x'] },
            ],
          },
        };
      },
    });
  });
});
