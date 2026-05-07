/**
 * Resolve the version string of a Happier CLI installation by spawning the
 * installed binary with `--version`. Shared across:
 *
 * - `resolveDaemonServiceInventoryEntries` (daemon/service/cli.ts) — fills
 *   `configuredCliVersion` on background-service inventory rows.
 * - `buildCurrentCliInfo` (diagnostics/doctorRepair/resolveDoctorRepairReport.ts)
 *   — resolves the version of the CLI actually installed at the path launchd
 *   will exec, which may differ from the repo-bundled version when invoked
 *   from a local-dev build.
 *
 * Having one implementation is the point: anywhere we're reading a version
 * from an installed binary path, we go through this helper — no parallel
 * realpath-parsers or package.json readers drifting apart.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { buildServiceCommandEnv } from '@happier-dev/cli-common/service';

/**
 * Spawn `<binaryPath> --version` and return the first trimmed non-empty line
 * of stdout. Falls back to invoking via `bash` on unix when the direct exec
 * returns non-zero (handles scripts or variants where the shebang isn't
 * respected). Returns null on any failure — missing binary, non-zero exit,
 * timeout, or empty output.
 */
export function resolveCliVersionFromBinary(params: Readonly<{
  binaryPath: string;
  platform: NodeJS.Platform;
  timeoutMs?: number;
}>): string | null {
  const binaryPath = String(params.binaryPath ?? '').trim();
  if (!binaryPath) return null;
  if (!existsSync(binaryPath)) return null;

  const timeout = params.timeoutMs ?? 2000;
  const commonEnv = { cmd: binaryPath, args: ['--version'], env: process.env } as const;

  try {
    let res = spawnSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env: buildServiceCommandEnv(commonEnv),
    });
    if (res.status !== 0 && params.platform !== 'win32') {
      res = spawnSync('bash', [binaryPath, '--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        env: buildServiceCommandEnv({ cmd: 'bash', args: [binaryPath, '--version'], env: process.env }),
      });
    }
    if (res.status !== 0) return null;
    const firstLine = String(res.stdout ?? '').trim().split(/\r?\n/u)[0]?.trim();
    return firstLine || null;
  } catch {
    return null;
  }
}
