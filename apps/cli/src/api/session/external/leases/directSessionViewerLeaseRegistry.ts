import { randomUUID } from 'node:crypto';

type DirectSessionViewerLease = Readonly<{
  leaseId: string;
  sessionId: string;
  expiresAtMs: number;
}>;

type DirectSessionViewerLeaseRegistryParams = Readonly<{
  now?: () => number;
  randomId?: () => string;
}>;

export function createDirectSessionViewerLeaseRegistry(params?: DirectSessionViewerLeaseRegistryParams) {
  const now = params?.now ?? Date.now;
  const randomId = params?.randomId ?? randomUUID;
  const leasesBySessionId = new Map<string, Map<string, DirectSessionViewerLease>>();

  function pruneExpiredLeases(sessionId?: string): void {
    const cutoff = now();
    const targetEntries = sessionId
      ? [[sessionId, leasesBySessionId.get(sessionId) ?? new Map<string, DirectSessionViewerLease>()] as const]
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
      const sessionLeases = leasesBySessionId.get(input.sessionId) ?? new Map<string, DirectSessionViewerLease>();
      leasesBySessionId.set(input.sessionId, sessionLeases);

      const requestedLeaseId = typeof input.leaseId === 'string' && input.leaseId.trim().length > 0
        ? input.leaseId.trim()
        : null;
      const existing = requestedLeaseId ? sessionLeases.get(requestedLeaseId) ?? null : null;
      const leaseId = existing?.leaseId ?? requestedLeaseId ?? randomId();
      const lease: DirectSessionViewerLease = {
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
