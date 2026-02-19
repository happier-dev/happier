// @ts-check

import { execFileSync } from 'node:child_process';

/**
 * @typedef {(cmd: string, args: string[]) => unknown} ExecFn
 */

/**
 * Ensures Docker can execute `linux/amd64` containers (required for some toolchains that are x86_64-only).
 *
 * On Apple Silicon, if amd64 emulation isn't enabled/configured, Docker will typically fail with
 * `exec format error`.
 *
 * @param {{ exec?: ExecFn }} [opts]
 */
export function assertDockerCanRunLinuxAmd64(opts) {
  /** @type {ExecFn} */
  const exec =
    typeof opts?.exec === 'function'
      ? opts.exec
      : (cmd, args) =>
          execFileSync(cmd, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            timeout: 30_000,
          });

  try {
    // Validate using a glibc-based image: on some Apple Silicon setups, `linux/amd64` might appear to work
    // for musl-based images (like Alpine) while still failing for glibc-based toolchains we actually need.
    exec('docker', ['run', '--rm', '--platform', 'linux/amd64', 'ubuntu:24.04', 'uname', '-m']);
  } catch (err) {
    // @ts-expect-error - node error shape
    const stderr = String(err?.stderr ?? '');
    const message = String(err?.message ?? err);
    const combined = `${message}\n${stderr}`.trim();

    if (/exec format error/i.test(combined)) {
      throw new Error(
        [
          '[pipeline] Docker cannot run linux/amd64 containers on this machine (exec format error).',
          'This is required for Android builds that use x86_64-only Linux toolchains.',
          '',
          'Fix (macOS Apple Silicon):',
          "- Docker Desktop → Settings → Features in development → enable 'Use Rosetta for x86/amd64 emulation', then restart Docker Desktop.",
          "- If that still fails, install QEMU binfmt in Docker's Linux VM:",
          '    docker run --privileged --rm tonistiigi/binfmt --install amd64',
          '',
          'Verify:',
          '  docker run --rm --platform linux/amd64 ubuntu:24.04 uname -m',
          '',
          `Raw error: ${combined || '<empty>'}`,
        ].join('\n'),
      );
    }

    throw new Error(
      [
        '[pipeline] Failed to validate Docker linux/amd64 support.',
        'Verify Docker Desktop is running and can run linux/amd64 images.',
        '',
        `Raw error: ${combined || '<empty>'}`,
      ].join('\n'),
    );
  }
}
