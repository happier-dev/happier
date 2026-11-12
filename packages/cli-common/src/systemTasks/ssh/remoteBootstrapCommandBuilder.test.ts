import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDedicatedDaemonInvocationCommand } from './remoteBootstrapCommandBuilder.js';

describe('dedicated daemon command identity', () => {
  it.skipIf(process.platform === 'win32').each([
    { uid: '1000', trace: '' },
    { uid: '0', trace: 'runuser\n' },
    { uid: '2000', trace: 'sudo\nrunuser\n' },
  ])('runs ordinary CLI work as happier from carrier UID $uid', async ({ uid, trace }) => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-daemon-command-'));
    try {
      const bin = join(root, 'bin'), home = join(root, 'dedicated home'), tracePath = join(root, 'trace');
      await mkdir(bin);
      await writeFile(tracePath, '');
      // Only OS identity, passwd lookup and privilege-switch executables are
      // substituted. The actual generated command runs in a real POSIX shell.
      const boundaries = {
        id: 'if [ "$#" -eq 2 ]; then echo 1000; else echo "$FIXTURE_UID"; fi',
        getent: 'printf "happier:x:1000:1000::%s:/bin/bash\\n" "$FIXTURE_HOME"',
        sudo: 'printf "sudo\\n" >> "$FIXTURE_TRACE"; if [ "$FIXTURE_UID" = 1000 ]; then echo "sudo: a password is required" >&2; exit 1; fi; shift; shift; FIXTURE_UID=0 exec "$@"',
        runuser: 'printf "runuser\\n" >> "$FIXTURE_TRACE"; shift; shift; shift; exec "$@"',
      };
      for (const [name, body] of Object.entries(boundaries)) {
        const path = join(bin, name);
        await writeFile(path, `#!/bin/sh\n${body}\n`);
        await chmod(path, 0o755);
      }
      const command = buildDedicatedDaemonInvocationCommand(
        'printf "%s\\n" "$USER" "$HOME" "$HAPPIER_HOME_DIR" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" "${FIXTURE_UID-unset}"; cat');
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', input: 'fake stdin\n',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_UID: uid,
          FIXTURE_HOME: home, FIXTURE_TRACE: tracePath } });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(result.stdout).toBe(`happier\n${home}\n${home}/.happier\n/run/user/1000\nunix:path=/run/user/1000/bus\nunset\nfake stdin\n`);
      expect(await readFile(tracePath, 'utf8')).toBe(trace);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
