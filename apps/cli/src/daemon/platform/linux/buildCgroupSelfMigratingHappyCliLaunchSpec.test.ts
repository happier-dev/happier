import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCgroupSelfMigratingHappyCliLaunchSpec } from './buildCgroupSelfMigratingHappyCliLaunchSpec';

describe('buildCgroupSelfMigratingHappyCliLaunchSpec', () => {
  let sandboxDir: string | null = null;

  afterEach(async () => {
    if (!sandboxDir) return;
    await rm(sandboxDir, { recursive: true, force: true });
    sandboxDir = null;
  });

  it('targets a sibling scope outside app.slice when the daemon runs as a user service', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-launch-spec-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const daemonProcDir = join(procfsRootDir, '111');
    await mkdir(daemonProcDir, { recursive: true });
    await writeFile(
      join(daemonProcDir, 'cgroup'),
      '0::/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service\n',
      'utf8',
    );

    const result = await buildCgroupSelfMigratingHappyCliLaunchSpec({
      args: ['codex', '--happy-starting-mode', 'remote'],
      daemonPid: 111,
      procfsRootDir,
    });

    expect(result?.filePath).toBe('/bin/sh');
    expect(result?.env?.HAPPIER_DAEMON_SESSION_CGROUP_BASE_DIR).toBe(
      '/sys/fs/cgroup/user.slice/user-501.slice/user@501.service',
    );
    expect(result?.args.join(' ')).toContain('happier-session-$$.scope');

    const shellScript = result?.args[1] ?? '';
    expect(shellScript).toContain('exec "$@"');
    expect(shellScript).toContain('|| true');
  });

  it('wraps the admitted immutable runner decision without recomputing the child entrypoint', async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), 'happier-cgroup-immutable-launch-spec-'));
    const procfsRootDir = join(sandboxDir, 'proc');
    const daemonProcDir = join(procfsRootDir, '222');
    await mkdir(daemonProcDir, { recursive: true });
    await writeFile(
      join(daemonProcDir, 'cgroup'),
      '0::/user.slice/user-501.slice/user@501.service/app.slice/happier-daemon.default.service\n',
      'utf8',
    );
    const immutableEntrypoint = '/runtime/.runner-snapshots/0123456789abcdef/index.mjs';

    const result = await buildCgroupSelfMigratingHappyCliLaunchSpec({
      args: ['codex', '--happy-terminal-mode', 'plain'],
      daemonPid: 222,
      procfsRootDir,
      launchOptions: {
        runtimeDecision: {
          runtime: 'node',
          argvPrefix: ['--no-warnings', '--no-deprecation', immutableEntrypoint],
          env: { HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef' },
        },
      },
    });

    expect(result?.args).toEqual(expect.arrayContaining([
      immutableEntrypoint,
      'codex',
      '--happy-terminal-mode',
      'plain',
    ]));
    expect(result?.env).toMatchObject({
      HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef',
    });
  });
});
