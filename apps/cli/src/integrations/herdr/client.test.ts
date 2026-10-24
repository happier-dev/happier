import { describe, expect, it, vi } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { access } from 'node:fs/promises';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

vi.mock('node:net', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:net')>();
  return { ...original, createConnection: vi.fn(original.createConnection) };
});

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

import { createHerdrClient, readHerdrCreatedWorkspaceTarget } from './client';
import { withHerdrApi } from './herdrApi.testkit';

const launch = { label: 'work', cwd: '/tmp', argv: ['/managed/happier', 'claude'], env: {} };
const clientFor = (socketPath: string) => {
  inventory.socketPath = socketPath;
  return createHerdrClient({ binary: 'herdr', sessionName: 'work', actionTimeoutMs: 100, startupTimeoutMs: 100 });
};

describe('Herdr client workspace placement', () => {
  it.skipIf(process.platform === 'win32')('serves and cleans up a socket fixture when TMPDIR exceeds the Unix socket path budget', async () => {
    const env = createEnvKeyScope(['TMPDIR']);
    let socketPath = '';
    try {
      await withTempDir(`herdr-${'long-'.repeat(24)}`, async directory => {
        env.patch({ TMPDIR: directory });
        await withHerdrApi(async api => {
          socketPath = api.socketPath;
          await expect(clientFor(socketPath).ensureServer()).resolves.toBe(socketPath);
          await api.stop();
          await api.start();
          await expect(clientFor(socketPath).ensureServer()).resolves.toBe(socketPath);
        });
        await expect(access(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    } finally {
      env.restore();
    }
  });

  it('retains an admitted server socket when the ambient named-server inventory changes', async () => {
    await withHerdrApi(async selected => {
      await withHerdrApi(async ambient => {
        inventory.socketPath = ambient.socketPath;
        const client = createHerdrClient({ binary: 'herdr', sessionName: 'work', socketPath: selected.socketPath,
          actionTimeoutMs: 100, startupTimeoutMs: 100 });
        await expect(client.ensureServer()).resolves.toBe(selected.socketPath);
        expect(ambient.requests).toEqual([]);
        expect(selected.requests.map(request => request.method)).toEqual(['session.snapshot']);
      });
    });
  });

  it('does not substitute a live ambient server for an unreachable admitted socket', async () => {
    await withHerdrApi(async ambient => {
      inventory.socketPath = ambient.socketPath;
      const client = createHerdrClient({ binary: 'herdr', sessionName: 'work', socketPath: `${ambient.socketPath}.absent`,
        actionTimeoutMs: 100, startupTimeoutMs: 100 });
      await expect(client.ensureServer()).rejects.toMatchObject({ code: 'unreachable' });
      expect(ambient.requests).toEqual([]);
    });
  });
  it.each(['sendText', 'sendRaw'] as const)('preserves large escaped Unicode input through %s within the released request-line budget', async (method) => {
    await withHerdrApi(async (api) => {
      const client = createHerdrClient({
        binary: 'herdr', sessionName: 'work', socketPath: api.socketPath,
        actionTimeoutMs: 5_000, startupTimeoutMs: 5_000,
      });
      // Escaping expands this beyond 1 MiB even though its UTF-8 source fits.
      const text = `${'\\'.repeat(512 * 1024)}🌈你好\n${'😀'.repeat(100_000)}`;
      await expect(client[method]('managed', text)).resolves.toBeUndefined();
      const writes = api.requests.filter((request) => request.method === (method === 'sendText' ? 'pane.send_input' : 'pane.send_text'));
      expect(writes.map((request) => request.params.text).join('')).toBe(text);
      for (const write of writes) {
        expect(Buffer.byteLength(`${JSON.stringify({ id: 'happier', ...write })}\n`)).toBeLessThanOrEqual(1024 * 1024);
        expect(String(write.params.text)).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      }
    }, { maxInitialRequestBytes: 1024 * 1024 });
  });

  it('does not split a Unicode scalar at an odd UTF-16 request boundary', async () => {
    await withHerdrApi(async (api) => {
      const client = createHerdrClient({
        binary: 'herdr', sessionName: 'work', socketPath: api.socketPath,
        actionTimeoutMs: 5_000, startupTimeoutMs: 5_000,
      });
      const text = '😀'.repeat(600_000);
      await client.sendText('managed!', text);
      const chunks = api.requests.map((request) => String(request.params.text));
      expect(chunks.join('')).toBe(text);
      for (const chunk of chunks) expect(chunk).toMatch(/^(?:😀)+$/u);
    }, { maxInitialRequestBytes: 1024 * 1024 });
  });

  it('preserves terminal Unicode when a socket chunk splits a UTF-8 character', async () => {
    const text = '你好 🌈';
    const response = Buffer.from(`${JSON.stringify({ id: 'happier', result: { read: { text } } })}\n`);
    const split = response.indexOf(Buffer.from('你')) + 1;
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
        this.push(response.subarray(0, split));
        this.push(response.subarray(split));
      },
    });
    Object.assign(socket, { setTimeout: () => socket });
    // Only the OS socket is substituted; Node's readable UTF-8 decoding remains real.
    vi.mocked(createConnection).mockReturnValueOnce(socket as unknown as Socket);
    const client = createHerdrClient({
      binary: 'herdr', sessionName: 'work', socketPath: 'test-socket',
      actionTimeoutMs: 100, startupTimeoutMs: 100,
    });
    const result = client.readPane('managed');
    socket.emit('connect');
    await expect(result).resolves.toBe(text);
  });

  it('identifies the bootstrap tab returned by workspace.create for removal after managed pane creation', () => {
    expect(readHerdrCreatedWorkspaceTarget({
      workspace: { workspace_id: 'w2', active_tab_id: 'w2:t1' },
      tab: { tab_id: 'w2:t1' },
      root_pane: { pane_id: 'w2:p1' },
    })).toEqual({ workspaceId: 'w2', tabId: 'w2:t1' });
  });

  it('accepts the workspace active tab when an older response omits the tab object', () => {
    expect(readHerdrCreatedWorkspaceTarget({
      workspace: { workspace_id: 'w2', active_tab_id: 'w2:t1' },
    })).toEqual({ workspaceId: 'w2', tabId: 'w2:t1' });
  });

  it('removes only the bootstrap tab after the managed pane is identified', async () => {
    await withHerdrApi(async (api) => {
      api.setEmpty();
      await expect(clientFor(api.socketPath).createPane(launch)).resolves.toMatchObject({ paneId: 'managed' });
      expect([...api.panes]).toEqual(['managed']);
      expect([...api.tabs]).toEqual(['managed-tab']);
      expect(api.requests.slice(-2).map((request) => request.method)).toEqual(['pane.get', 'tab.close']);
    });
  });

  it('retires the known pane and bootstrap when inspection fails after layout creation', async () => {
    await withHerdrApi(async (api) => {
      api.setEmpty();
      api.faults.set('pane.get', 'error');
      const error = await clientFor(api.socketPath).createPane(launch).catch((failure: unknown) => failure);
      expect([...api.panes]).toEqual([]);
      expect([...api.tabs]).toEqual([]);
      expect(error).toMatchObject({ launchDisposition: 'stopped' });
      expect(api.requests.slice(-2).map((request) => request.method)).toEqual(['pane.close', 'tab.close']);
    });
  });

  it('retains unrelated panes and tabs when managed pane inspection fails', async () => {
    await withHerdrApi(async (api) => {
      api.panes.add('user-pane');
      api.tabs.add('user-tab');
      api.faults.set('pane.get', 'error');
      await expect(clientFor(api.socketPath).createPane(launch)).rejects.toMatchObject({ launchDisposition: 'stopped' });
      expect([...api.panes]).toEqual(['user-pane']);
      expect([...api.tabs]).toEqual(['user-tab']);
    });
  });

  it('retains both creation and cleanup failures when a known pane cannot be retired', async () => {
    await withHerdrApi(async (api) => {
      api.faults.set('pane.get', 'error');
      api.faults.set('pane.close', 'error');
      const error = await clientFor(api.socketPath).createPane(launch).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        launchDisposition: 'unconfirmed',
        errors: [expect.objectContaining({ code: 'pane.get_failed' }), expect.objectContaining({ code: 'pane.close_failed' })],
      });
      expect([...api.panes]).toEqual(['managed']);
    });
  });

  it('stops the known pane and exposes bootstrap cleanup failure without hiding it', async () => {
    await withHerdrApi(async (api) => {
      api.setEmpty();
      api.faults.set('tab.close', 'error');
      const error = await clientFor(api.socketPath).createPane(launch).catch((failure: unknown) => failure);
      expect([...api.panes]).toEqual([]);
      expect([...api.tabs]).toEqual(['bootstrap']);
      expect(error).toMatchObject({ launchDisposition: 'stopped', cleanupIncomplete: true });
    });
  });

  it('reports a submitted layout timeout as unconfirmed without submitting another layout', async () => {
    await withHerdrApi(async (api) => {
      api.setEmpty();
      api.faults.set('layout.apply', 'timeout');
      const error = await clientFor(api.socketPath).createPane(launch).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ launchDisposition: 'unconfirmed' });
      expect([...api.panes]).toEqual(['managed']);
      expect([...api.tabs]).toEqual(['managed-tab']);
      expect(api.requests.filter((request) => request.method === 'layout.apply')).toHaveLength(1);
    });
  });
});
