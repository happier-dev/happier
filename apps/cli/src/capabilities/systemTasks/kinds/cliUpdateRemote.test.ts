import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { CliUpdateFacts } from '@happier-dev/protocol';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';

import { createCliUpdateRemoteTaskKind, type DetachedUpdaterSpawn } from './cliUpdateRemote';

function facts(overrides: Partial<CliUpdateFacts> = {}): CliUpdateFacts {
  return {
    currentVersion: '0.2.13-preview.1',
    latestVersion: '0.2.14-preview.1',
    channel: 'preview',
    installSource: 'managed',
    updateCommand: 'hprev self update',
    canUpdateRemotely: true,
    lastUpdate: null,
    ...overrides,
  };
}

function run(kind: ReturnType<typeof createCliUpdateRemoteTaskKind>, params: unknown) {
  return kind.run({ params: params as never, emit: () => {}, prompt: async () => null });
}

describe('cli.update.v1 hosted by the daemon (remote CLI update)', () => {
  it('starts `self update` detached from this daemon\'s own binary and answers at once', async () => {
    const spawns: Array<Parameters<DetachedUpdaterSpawn>[0]> = [];
    const kind = createCliUpdateRemoteTaskKind({
      readFacts: () => facts(),
      publicReleaseRing: 'preview',
      script: '/home/u/.happier/cli-preview/versions/0.2.13-preview.1/happier',
      cwd: '/home/u/.happier/cli-preview/versions/0.2.13-preview.1',
      logsDir: '/home/u/.happier/logs',
      spawnDetached: (spawnParams) => {
        spawns.push(spawnParams);
        const admission = new PassThrough();
        admission.end('{"admitted":true}\n');
        return { started: true, admission };
      },
      nowMs: () => 1_700_000_000_000,
    });

    await expect(run(kind, {})).resolves.toEqual({
      started: true,
      currentVersion: '0.2.13-preview.1',
      channel: 'preview',
      logPath: '/home/u/.happier/logs/cli-update-1700000000000.log',
    });
    expect(spawns).toEqual([expect.objectContaining({
      script: '/home/u/.happier/cli-preview/versions/0.2.13-preview.1/happier',
      args: ['self', 'update', '--preview'],
      logPath: '/home/u/.happier/logs/cli-update-1700000000000.log',
    })]);
  });

  it('reports another update in progress instead of started when the updater was refused admission', async () => {
    const kind = createCliUpdateRemoteTaskKind({
      readFacts: () => facts(),
      publicReleaseRing: 'preview',
      script: '/x/happier',
      cwd: '/x',
      logsDir: '/x/logs',
      spawnDetached: () => {
        const admission = new PassThrough();
        admission.end('{"admitted":false,"code":"cli_update_in_progress","message":"Another Happier process is installing or updating it."}\n');
        return { started: true, admission };
      },
    });
    await expect(run(kind, {})).rejects.toMatchObject({ code: 'cli_update_in_progress', message: expect.stringContaining('Another Happier process') });
  });

  it('fails by name, naming the log, when the updater exits before admission', async () => {
    const kind = createCliUpdateRemoteTaskKind({
      readFacts: () => facts(),
      publicReleaseRing: 'preview',
      script: '/x/happier',
      cwd: '/x',
      logsDir: '/x/logs',
      nowMs: () => 7,
      spawnDetached: () => {
        const admission = new PassThrough();
        admission.end();
        return { started: true, admission };
      },
    });
    await expect(run(kind, {})).rejects.toMatchObject({ code: 'cli_update_start_failed', message: expect.stringContaining('/x/logs/cli-update-7.log') });
  });

  it('fails by name when the updater could not be started', async () => {
    const kind = createCliUpdateRemoteTaskKind({
      readFacts: () => facts(),
      publicReleaseRing: 'preview',
      script: '/x/happier',
      cwd: '/x',
      logsDir: '/x/logs',
      spawnDetached: () => ({ started: false, admission: null }),
    });
    await expect(run(kind, {})).rejects.toMatchObject({ code: 'cli_update_start_failed' });
  });

  it('refuses a CLI Happier does not manage, naming the command that updates it', async () => {
    const kind = createCliUpdateRemoteTaskKind({
      readFacts: () => facts({ installSource: 'npm', updateCommand: 'npm install -g @happier-dev/cli@latest', canUpdateRemotely: false }),
      publicReleaseRing: 'preview',
      script: '/usr/lib/node_modules/@happier-dev/cli/bin/happier.mjs',
      cwd: '/tmp',
      logsDir: '/tmp/logs',
      spawnDetached: () => { throw new Error('must not spawn'); },
    });
    const error = await run(kind, {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SystemTaskExecutionError);
    expect(error).toMatchObject({ code: 'cli_not_managed', message: expect.stringContaining('npm install -g @happier-dev/cli@latest') });
  });

  it('refuses where the updater cannot outlive the service restart (Windows)', async () => {
    const kind = createCliUpdateRemoteTaskKind({
      readFacts: () => facts({ canUpdateRemotely: false }),
      publicReleaseRing: 'preview',
      script: 'C:\\Users\\u\\.happier\\cli-preview\\versions\\0.2.13-preview.1\\happier.exe',
      cwd: 'C:\\Users\\u',
      logsDir: 'C:\\Users\\u\\.happier\\logs',
      spawnDetached: () => { throw new Error('must not spawn'); },
    });
    await expect(run(kind, {})).rejects.toMatchObject({ code: 'cli_remote_update_unsupported', message: expect.stringContaining('hprev self update') });
  });

  it('rejects a channel other than the one this daemon runs', async () => {
    const kind = createCliUpdateRemoteTaskKind({
      readFacts: () => facts(),
      publicReleaseRing: 'preview',
      script: '/x/happier',
      cwd: '/x',
      logsDir: '/x/logs',
      spawnDetached: () => { throw new Error('must not spawn'); },
    });
    await expect(run(kind, { channel: 'stable' })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});
