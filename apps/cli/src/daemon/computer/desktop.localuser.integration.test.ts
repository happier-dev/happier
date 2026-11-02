import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { resolveExecutableCommand } from '@happier-dev/cli-common/process';
import { describe, expect, it, vi } from 'vitest';
import { createComputerDesktop } from './desktop';

const required = ['Xvfb', 'dbus-daemon', 'gdbus', 'xdpyinfo'] as const;
const available =
  process.platform === 'linux' &&
  required.every((name) => resolveExecutableCommand(name));

// An app the agent launches with an explicit DISPLAY carries no XAUTHORITY and no ~/.Xauthority.
async function connectsWithDisplayOnly(
  displayId: string,
  home: string,
): Promise<boolean> {
  try {
    await promisify(execFile)(
      resolveExecutableCommand('xdpyinfo')!,
      ['-display', displayId],
      { env: { PATH: process.env.PATH ?? '', HOME: home } },
    );
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!available)(
  'managed desktop explicit-DISPLAY admission (real Xvfb)',
  () => {
    it('admits the daemon user with DISPLAY alone, which a cookie-only display refuses', async () => {
      const scratch = await mkdtemp(
        join(tmpdir(), 'happier-desktop-localuser-'),
      );
      const home = join(scratch, 'home');
      const bin = join(scratch, 'bin');
      const desktop = createComputerDesktop();
      try {
        await promisify(execFile)('mkdir', ['-p', home, bin]);
        // Contrast: the same -auth display without the host entry refuses a DISPLAY-only client.
        const cookieFile = join(scratch, 'Xauthority');
        await writeFile(
          cookieFile,
          Buffer.concat([
            Buffer.from([0xff, 0xff, 0, 0, 0, 0, 0, 18]),
            Buffer.from('MIT-MAGIC-COOKIE-1'),
            Buffer.from([0, 16]),
            Buffer.alloc(16, 7),
          ]),
          { mode: 0o600 },
        );
        const bare = spawn(
          resolveExecutableCommand('Xvfb')!,
          ['-displayfd', '3', '-nolisten', 'tcp', '-auth', cookieFile],
          { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] },
        );
        const [chunk] = (await once(bare.stdio[3] as Readable, 'data')) as [
          Buffer,
        ];
        try {
          expect(
            await connectsWithDisplayOnly(`:${chunk.toString().trim()}`, home),
          ).toBe(false);
        } finally {
          bare.kill('SIGTERM');
          await once(bare, 'close');
        }

        // The owner's desktop: real Xvfb, D-Bus and AT-SPI; this host has no window manager,
        // so a placeholder process stands in for it.
        for (const name of ['Xvfb', 'dbus-daemon', 'gdbus'])
          await symlink(resolveExecutableCommand(name)!, join(bin, name));
        await writeFile(join(bin, 'openbox'), '#!/bin/sh\nexec sleep 600\n');
        await chmod(join(bin, 'openbox'), 0o755);
        vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
        const connection = await desktop.ensure();
        expect(await connectsWithDisplayOnly(connection.displayId, home)).toBe(
          true,
        );
      } finally {
        vi.unstubAllEnvs();
        await desktop.dispose();
        await rm(scratch, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
