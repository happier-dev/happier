import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  observeProcessLivenessSync,
  readProcessHostIdentitySync,
  readProcessInstanceFingerprintSync,
} from '@happier-dev/cli-common/processInstance';

const STAGING_NAME = /^(\.tmp|happier-workspace-capture)\.\d+\.(\d+)\.[a-f0-9]+$/;
const OWNER_SUFFIX = '.owner.json';

async function ownerHasDeparted(directory, pid, currentHost, allowLegacyPidOnly) {
  let owner;
  try {
    const info = await lstat(`${directory}${OWNER_SUFFIX}`);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    owner = JSON.parse(await readFile(`${directory}${OWNER_SUFFIX}`, 'utf8'));
  } catch (error) {
    // Older writers recorded only the PID in the staging name. Missing birth
    // evidence can never justify removing a directory whose PID is still live.
    return allowLegacyPidOnly && error?.code === 'ENOENT' && observeProcessLivenessSync(pid).status === 'dead';
  }
  if (owner?.v !== 1 || owner.pid !== pid || !currentHost || !owner.host) return false;
  const host = owner.host;
  // Mirrors can contain another host's staging. Its local PID says nothing
  // about that writer; Linux birth witnesses also need their boot/namespace.
  if (host.machineId !== currentHost.machineId || host.pidNamespaced !== currentHost.pidNamespaced) return false;
  if (host.bootId && currentHost.bootId && host.bootId !== currentHost.bootId) return true;
  if (host.bootId !== currentHost.bootId || host.pidNamespace !== currentHost.pidNamespace) return false;
  if (host.pidNamespaced && !host.pidNamespace) return false;

  const liveness = observeProcessLivenessSync(pid);
  if (liveness.status === 'dead') return true;
  if (liveness.status !== 'alive' || typeof owner.processInstanceFingerprint !== 'string' || !owner.processInstanceFingerprint) return false;
  const current = readProcessInstanceFingerprintSync(pid, { expectedFingerprint: owner.processInstanceFingerprint });
  return current !== null && current !== owner.processInstanceFingerprint;
}

/** Reclaim only this writer's staging siblings, once at the next build. */
export async function reclaimAbandonedBuildStaging(parent, currentHost, { prefix = '.tmp' } = {}) {
  const names = new Set((await readdir(parent)).map(name => name.endsWith(OWNER_SUFFIX) ? name.slice(0, -OWNER_SUFFIX.length) : name));
  for (const name of names) {
    const match = STAGING_NAME.exec(name);
    if (!match || match[1] !== prefix) continue;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const directory = join(parent, name);
    try {
      let info;
      try { info = await lstat(directory); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (info && (!info.isDirectory() || info.isSymbolicLink())) continue;
      if (!await ownerHasDeparted(directory, pid, currentHost, name.startsWith('.tmp.'))) continue;
      if (info) {
        const current = await lstat(directory);
        if (current.dev !== info.dev || current.ino !== info.ino) continue;
        await rm(directory, { recursive: true });
      }
      await rm(`${directory}${OWNER_SUFFIX}`, { force: true });
    } catch (error) {
      // Two builders can discover the same abandoned sibling concurrently.
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

/** Publish ownership before a build's temporary directory becomes visible. */
export async function createOwnedBuildStaging(parent, { prefix = '.tmp' } = {}) {
  const host = readProcessHostIdentitySync();
  // A killed writer cannot run cleanup; its next sibling build reclaims it.
  await reclaimAbandonedBuildStaging(parent, host, { prefix });
  const directory = join(parent, `${prefix}.${Date.now()}.${process.pid}.${Math.random().toString(16).slice(2)}`);
  const ownerFile = `${directory}${OWNER_SUFFIX}`;
  await writeFile(ownerFile, JSON.stringify({
    v: 1,
    pid: process.pid,
    host,
    processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid),
  }), { flag: 'wx' });
  try {
    await mkdir(directory);
  } catch (error) {
    await rm(ownerFile, { force: true }).catch(() => {});
    throw error;
  }
  return {
    directory,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
      await rm(ownerFile, { force: true });
    },
  };
}
