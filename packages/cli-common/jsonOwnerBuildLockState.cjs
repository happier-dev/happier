'use strict';

const { readFileSync, statSync } = require('node:fs');

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function isJsonOwnerBuildLockActive(lockPath, opts = {}) {
  let stats;
  try {
    stats = statSync(lockPath);
  } catch {
    return false;
  }

  let owner = null;
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    owner = raw ? JSON.parse(raw) : null;
  } catch {
    owner = null;
  }

  const ownerPid = Number(owner?.pid);
  if (Number.isFinite(ownerPid) && ownerPid > 1) {
    return isPidAlive(ownerPid);
  }

  const staleAfterMs = Number(opts.staleAfterMs ?? 240_000);
  const ownerUpdatedAtMs = Number(owner?.updatedAtMs ?? owner?.createdAtMs ?? 0);
  if (ownerUpdatedAtMs > 0) {
    return Date.now() - ownerUpdatedAtMs <= staleAfterMs;
  }

  if (opts.ownerlessFreshIsActive === false) {
    return false;
  }

  const updatedAtMs = Number(stats.mtimeMs ?? 0);
  return updatedAtMs > 0 && Date.now() - updatedAtMs <= staleAfterMs;
}

module.exports = {
  isJsonOwnerBuildLockActive,
};
