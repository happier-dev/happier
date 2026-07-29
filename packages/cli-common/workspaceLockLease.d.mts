export interface WorkspaceLockLeaseOwner {
  token?: string | null;
}

export interface WorkspaceLockLease {
  path: string;
  token: string;
}

export function createWorkspaceLockLeaseValue(params: {
  lockPath: string;
  ownerToken: string;
}): string;

export function parseWorkspaceLockLeaseValue(value: unknown): WorkspaceLockLease | null;

export function workspaceLockLeaseMatchesOwner(params: {
  lockPath: string;
  leaseValue: unknown;
  owner: WorkspaceLockLeaseOwner | null | undefined;
}): boolean;
