import { randomUUID } from 'node:crypto';

type ExternalSessionViewerLease = Readonly<{
  leaseId: string;
  sessionId: string;
  expiresAtMs: number;
}>;

type ExternalSessionViewerLeaseRegistryParams = Readonly<{
  now?: () => number;
  randomId?: () => string;
}>;

const MAX_ACTIVE_VIEWER_LEASES_PER_SESSION = 64;

export class ExternalSessionViewerLeaseCapacityExceededError extends Error {
  readonly name = 'ExternalSessionViewerLeaseCapacityExceededError';

  constructor() {
    super('External Session viewer lease capacity exceeded');
  }
}

export function createExternalSessionViewerLeaseRegistry(params?: ExternalSessionViewerLeaseRegistryParams) {
  const now = params?.now ?? Date.now;
  const randomId = params?.randomId ?? randomUUID;
  const leasesBySessionId = new Map<string, Map<string, ExternalSessionViewerLease>>();

  function pruneExpiredLeases(sessionId?: string): void {
    const cutoff = now();
    const targetEntries = sessionId
      ? [[sessionId, leasesBySessionId.get(sessionId) ?? new Map<string, ExternalSessionViewerLease>()] as const]
      : [...leasesBySessionId.entries()];

    for (const [targetSessionId, leases] of targetEntries) {
      for (const [leaseId, lease] of leases.entries()) {
        if (lease.expiresAtMs <= cutoff) {
          leases.delete(leaseId);
        }
      }
      if (leases.size === 0) {
        leasesBySessionId.delete(targetSessionId);
      }
    }
  }

  return {
    attach(input: Readonly<{ sessionId: string; leaseId?: string | null; ttlMs: number }>) {
      pruneExpiredLeases(input.sessionId);
      const sessionLeases = leasesBySessionId.get(input.sessionId) ?? new Map<string, ExternalSessionViewerLease>();
      leasesBySessionId.set(input.sessionId, sessionLeases);

      const requestedLeaseId = typeof input.leaseId === 'string' && input.leaseId.trim().length > 0
        ? input.leaseId.trim()
        : null;
      const existing = requestedLeaseId ? sessionLeases.get(requestedLeaseId) ?? null : null;
      if (!existing && sessionLeases.size >= MAX_ACTIVE_VIEWER_LEASES_PER_SESSION) {
        throw new ExternalSessionViewerLeaseCapacityExceededError();
      }
      const leaseId = existing?.leaseId ?? requestedLeaseId ?? randomId();
      const lease: ExternalSessionViewerLease = {
        leaseId,
        sessionId: input.sessionId,
        expiresAtMs: now() + input.ttlMs,
      };
      sessionLeases.set(leaseId, lease);
      return {
        leaseId,
        expiresAtMs: lease.expiresAtMs,
        renewed: existing !== null,
      } as const;
    },

    detach(input: Readonly<{ sessionId: string; leaseId: string }>) {
      pruneExpiredLeases(input.sessionId);
      const sessionLeases = leasesBySessionId.get(input.sessionId);
      if (!sessionLeases) {
        return { detached: false } as const;
      }
      const deleted = sessionLeases.delete(input.leaseId);
      if (sessionLeases.size === 0) {
        leasesBySessionId.delete(input.sessionId);
      }
      return { detached: deleted } as const;
    },

    countActiveLeases(sessionId: string): number {
      pruneExpiredLeases(sessionId);
      return leasesBySessionId.get(sessionId)?.size ?? 0;
    },
  };
}
