import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKSPACE_LOCK_LEASE_VERSION = 1;

function normalizeWorkspaceLockPath(lockPath) {
  const resolved = resolve(String(lockPath ?? '').trim());
  let normalized = resolved;
  try {
    normalized = realpathSync.native(resolved);
  } catch {
    // Lease parsing can outlive lock cleanup. Preserve the absolute lexical identity when the
    // lock no longer exists; live owner checks canonicalize the existing lock on both sides.
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function createWorkspaceLockLeaseValue({ lockPath, ownerToken }) {
  const normalizedPath = String(lockPath ?? '').trim();
  const normalizedToken = String(ownerToken ?? '').trim();
  if (!normalizedPath) throw new Error('Cannot create a workspace lock lease without a lock path');
  if (!normalizedToken) throw new Error('Cannot create a workspace lock lease without an owner token');

  return JSON.stringify({
    v: WORKSPACE_LOCK_LEASE_VERSION,
    path: normalizeWorkspaceLockPath(normalizedPath),
    token: normalizedToken,
  });
}

export function parseWorkspaceLockLeaseValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || parsed.v !== WORKSPACE_LOCK_LEASE_VERSION) return null;
    const path = String(parsed.path ?? '').trim();
    const token = String(parsed.token ?? '').trim();
    if (!path || !token) return null;
    return { path: normalizeWorkspaceLockPath(path), token };
  } catch {
    // Path-only values were the legacy reentry signal. They are deliberately rejected because a
    // successor owner can acquire the same path after the original owner releases it.
    return null;
  }
}

export function workspaceLockLeaseMatchesOwner({ lockPath, leaseValue, owner }) {
  const lease = parseWorkspaceLockLeaseValue(leaseValue);
  const ownerToken = typeof owner?.token === 'string' ? owner.token.trim() : '';
  if (!lease || !ownerToken) return false;
  return (
    normalizeWorkspaceLockPath(lease.path) === normalizeWorkspaceLockPath(lockPath)
    && lease.token === ownerToken
  );
}
