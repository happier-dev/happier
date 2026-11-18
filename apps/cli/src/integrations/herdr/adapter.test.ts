import { access, rmdir, unlink } from 'node:fs/promises';
import { chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

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

import { isTerminalHostStartupError } from '@/integrations/terminal/host/errors';

import { createHerdrTerminalHostAdapter } from './adapter';
import { withHerdrApi } from './herdrApi.testkit';
import { createTerminalLaunchSpec } from '@/terminal/host/launchSpec';

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
  it.each(['spawned', 'failed'] as const)('uses the admitted native handoff as the sole launcher and reports actual OS %s', async (outcome) => {
    await withHerdrApi(async (api) => {
      const spawnArgv = outcome === 'spawned' ? [process.execPath, '-e', 'process.exit(0)'] : ['/missing/native-fixture'];
      const preparedLaunch = await createTerminalLaunchSpec({
        workingDirectory: tmpdir(), spawnArgv, spawnEnv: {}, envPassthroughKeys: [], reportNativeSpawn: true,
      });
      try {
        const request = { ...launch, spawnArgv, preparedLaunch };
        await adapterFor(api.socketPath).createOrAttachHost(request);
        const layout = api.requests.find(request => request.method === 'layout.apply');
        const root = layout?.params.root as { command: string[] };
        // A Herdr process boundary executes the actual submitted pane command.
        const child = spawn(root.command[0]!, root.command.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', data => { stderr += String(data); });
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => resolve());
        });
        expect(await preparedLaunch.awaitNativeSpawnResult!(Date.now(), 1), stderr).toBe(outcome);
        expect(root.command).toEqual(preparedLaunch.argv);
      } finally {
        await preparedLaunch.discard();
        await discardSpec(readSpecPath(api.requests));
      }
    });
  });
  it('classifies failed server admission before submitting any native pane command', async () => {
    await withHerdrApi(async (api) => {
      api.faults.set('session.snapshot', 'error');
      await expect(adapterFor(api.socketPath).createOrAttachHost(launch)).rejects.toMatchObject({
        creationDisposition: 'not_created', cleanupIncomplete: false,
        cause: expect.objectContaining({ code: 'session.snapshot_failed' }),
      });
      expect(api.requests.map((request) => request.method)).toEqual(['session.snapshot']);
      expect([...api.panes]).toEqual([]);
    });
  });
  it('reports an unsupported server before creating a pane', async () => {
    await withHerdrApi(async (api) => {
      api.setServerVersion('0.9.1');
      await expect(adapterFor(api.socketPath).createOrAttachHost(launch)).rejects.toMatchObject({
        code: 'terminal_host_startup_failed', hostKind: 'herdr', reason: 'server_version_unsupported',
      });
      expect(api.requests.map((request) => request.method)).toEqual(['session.snapshot']);
      expect([...api.panes]).toEqual([]);
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

  it.each([
    ['times out', 'timeout', { reason: 'timeout', duplicateRisk: 'likely', recoverable: true }],
    ['fails', 'error', { reason: 'submit_failed', duplicateRisk: 'possible', recoverable: false }],
  ] as const)('maps an Enter that %s through the shared submit-failure rule', async (_label, fault, expected) => {
    await withHerdrApi(async (api) => {
      api.panes.add('managed');
      api.faults.set('pane.send_keys', fault);
      const result = await createHerdrTerminalHostAdapter({
        binary: 'herdr', sessionName: 'work', actionTimeoutMs: 200, startupTimeoutMs: 200,
      }).injectUserPrompt({
        kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
        terminalId: 'terminal_1', paneId: 'managed',
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
      }, { text: 'queued prompt', multiline: false, origin: { kind: 'rpc', nonce: 'enter-failure' }, scheduling: {} });
      expect(result).toMatchObject({ status: 'failed', phase: 'after_enter_unknown', ...expected });
      expect(api.requests.filter((request) => request.method === 'pane.send_keys')).toHaveLength(1);
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
        });
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) throw error;
        // AggregateError.errors is non-enumerable; assert its public value directly.
        expect(error.errors).toHaveLength(2);
        expect(error.errors[0]).toMatchObject({ code: 'pane.get_failed' });
        const cleanupError = error.errors[1];
        expect(cleanupError).toBeInstanceOf(AggregateError);
        if (!(cleanupError instanceof AggregateError)) throw cleanupError;
        expect(cleanupError.errors).toEqual([
          expect.objectContaining({ code: 'EACCES' }), expect.objectContaining({ code: 'ENOTEMPTY' }),
        ]);
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
          const request = { ...launch, label };
          await expect(adapter.createOrAttachHost(request)).resolves.toMatchObject({
            kind: 'herdr', sessionName: 'work', socketPath: api.socketPath,
          });
          expect(api.requests.filter((request) => request.method === 'layout.apply').at(-1)?.params).toMatchObject({
            tab_label: label, root: { label },
          });
        }
      } finally {
        for (const request of api.requests.filter((request) => request.method === 'layout.apply')) {
          const root = request.params.root as { command?: string[] } | undefined;
          await discardSpec(root?.command?.[2] ?? '');
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
        expect(String(error)).not.toContain('sensitive-test-value');
        expect([...api.panes]).toEqual(['managed']);
      } finally {
        await discardSpec(readSpecPath(api.requests));
      }
    });
  });
});
