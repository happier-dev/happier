import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { spawnSync } from 'node:child_process';

import { terminateProcessTreeByPid } from './processTree.mjs';

function resolveRepoRootDir() {
  const override = String(process.env.HAPPIER_TEST_PROCESS_LEASE_ROOT_DIR ?? '').trim();
  if (override) return override;
  // When invoked from `packages/tests`, repo root is `../..`.
  return resolvePath(process.cwd(), '..', '..');
}

function inspectProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const commandRes = spawnSync('ps', ['-o', 'args=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (commandRes.status !== 0) return null;
    const startRes = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid), '-ww'], { encoding: 'utf8' });
    if (startRes.status !== 0) return null;
    const command = String(commandRes.stdout ?? '').trim();
    const startTime = String(startRes.stdout ?? '').trim();
    if (!command || !startTime) return null;
    return { command, startTime };
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === 'object' && error.code !== 'ESRCH';
  }
}

function looksLikeUiWebMetroCommand(command) {
  const normalized = String(command).replaceAll('\\', '/');
  return normalized.includes('start --web')
    && normalized.includes('--host localhost')
    && (normalized.includes('/expo/bin/cli') || normalized.includes('expo') || normalized.includes('node'));
}

function looksLikeServerLightCommand(command) {
  const normalized = String(command).replaceAll('\\', '/');
  return normalized.includes('start:light')
    && ((normalized.includes('apps/server') && (normalized.includes('dist/index') || normalized.includes('sources/main.light.ts')))
      || (normalized.includes('happier') && normalized.includes('dist/index')));
}

const LEASE_KIND_MATCHERS = {
  'ui-web-metro': looksLikeUiWebMetroCommand,
  'server-light': looksLikeServerLightCommand,
};

export async function sweepStaleProcessOwnershipLeases(params) {
  const repoRootDir = params?.rootDir ?? resolveRepoRootDir();
  const leaseKinds = Array.isArray(params?.leaseKinds) && params.leaseKinds.length > 0
    ? params.leaseKinds
    : Object.keys(LEASE_KIND_MATCHERS);

  for (const leaseKind of leaseKinds) {
    const matcher = LEASE_KIND_MATCHERS[leaseKind];
    if (typeof matcher !== 'function') continue;

    const leasesDir = resolvePath(repoRootDir, '.project', 'tmp', `${leaseKind}-processes`);
    let entries = [];
    try {
      entries = readdirSync(leasesDir, { encoding: 'utf8' });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.startsWith('pid-') || !entry.endsWith('.json')) continue;
      const leasePath = resolvePath(leasesDir, entry);
      let lease;
      try {
        lease = JSON.parse(readFileSync(leasePath, 'utf8'));
      } catch {
        continue;
      }

      const childPid = Number(lease?.childPid);
      const ownerPid = Number(lease?.ownerPid);
      const childStartTime = typeof lease?.childStartTime === 'string' ? lease.childStartTime.trim() : '';
      if (!Number.isInteger(childPid) || childPid <= 1) continue;
      if (!Number.isInteger(ownerPid) || ownerPid <= 1) continue;
      if (!childStartTime) continue;

      if (isPidAlive(ownerPid)) {
        continue;
      }

      const childInfo = inspectProcess(childPid);
      if (!childInfo) {
        try {
          unlinkSync(leasePath);
        } catch {
          // ignore
        }
        continue;
      }
      if (childInfo.startTime !== childStartTime) {
        continue;
      }
      if (!matcher(childInfo.command, lease)) {
        continue;
      }

      await terminateProcessTreeByPid(childPid, { graceMs: 3_000, pollMs: 50 }).catch(() => {});
      try {
        unlinkSync(leasePath);
      } catch {
        // ignore
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await sweepStaleProcessOwnershipLeases();
}
