import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, relative, sep } from 'node:path';

export type WorkspaceRootOwnership = Readonly<{ ownerId: string; canonicalRoot: string; operation: 'sync' | 'bootstrap' | 'handoff' }>;
export type WorkspaceRootOwnershipHandle = Readonly<{ owner: WorkspaceRootOwnership; renew: () => Promise<void>; release: () => Promise<void> }>;
export type WorkspaceRootOwnershipResult = WorkspaceRootOwnershipHandle | Readonly<{ kind: 'overlap'; existing: WorkspaceRootOwnership }>;

const active = new Map<string, WorkspaceRootOwnership>();

function canonicalPath(input: string): string {
  const normalized = normalize(resolve(input.trim())).replace(/[\\/]+$/u, '') || sep;
  // Windows paths are case-insensitive even when this code is exercised from a test host.
  return /^[A-Za-z]:[\\/]/u.test(normalized) || process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
async function resolveCanonicalRoot(input: string): Promise<string> {
  const candidate = canonicalPath(input);
  try { return canonicalPath(await realpath(candidate)); } catch { return candidate; }
}
function overlaps(left: string, right: string): boolean {
  if (left === right) return true;
  const ancestor = (parent: string, child: string) => {
    const rest = relative(parent, child);
    return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
  };
  return ancestor(left, right) || ancestor(right, left);
}

export async function tryAcquireWorkspaceRootOwnership(input: WorkspaceRootOwnership): Promise<WorkspaceRootOwnershipResult> {
  if (!input.ownerId.trim()) throw new Error('workspace root ownership ownerId must be non-empty');
  const canonicalRoot = await resolveCanonicalRoot(input.canonicalRoot);
  if (!canonicalRoot) throw new Error('workspace root ownership root must be non-empty');
  for (const existing of active.values()) {
    if (existing.ownerId !== input.ownerId && overlaps(existing.canonicalRoot, canonicalRoot)) return { kind: 'overlap', existing };
  }
  const owner = Object.freeze({ ...input, ownerId: input.ownerId.trim(), canonicalRoot });
  active.set(canonicalRoot, owner);
  let released = false;
  return {
    owner,
    renew: async () => {
      if (released || active.get(canonicalRoot)?.ownerId !== owner.ownerId) throw new Error('workspace root ownership lost');
    },
    release: async () => {
      if (released) return;
      released = true;
      if (active.get(canonicalRoot)?.ownerId === owner.ownerId) active.delete(canonicalRoot);
    },
  };
}

export function __resetWorkspaceRootOwnershipForTests(): void { active.clear(); }
