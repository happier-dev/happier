import { createDirectSessionViewerLeaseRegistry } from './directSessionViewerLeaseRegistry';

export type DirectSessionFollowLease = Readonly<{
  release: () => void | Promise<void>;
}>;

type ManagedFollowLeaseRecord = {
  sessionId: string;
  release: (() => void | Promise<void>) | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
};

type DirectSessionFollowLeaseManagerParams = Readonly<{
  now?: () => number;
  randomId?: () => string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}>;

type FollowLeaseAcquirer = () => Promise<DirectSessionFollowLease | null>;

function clearManagedTimer(
  timer: ReturnType<typeof setTimeout> | null,
  clearTimer: typeof clearTimeout,
): void {
  if (timer) {
    clearTimer(timer);
  }
}

export function createDirectSessionFollowLeaseManager(params?: DirectSessionFollowLeaseManagerParams) {
  const now = params?.now ?? Date.now;
  const setTimer = params?.setTimer ?? setTimeout;
  const clearTimer = params?.clearTimer ?? clearTimeout;
  const viewerLeaseRegistry = createDirectSessionViewerLeaseRegistry({
    now,
    randomId: params?.randomId,
  });
  const followLeasesById = new Map<string, ManagedFollowLeaseRecord>();
  const backgroundFollowEnabledBySessionId = new Map<string, boolean>();
  const backgroundFollowAcquireBySessionId = new Map<string, FollowLeaseAcquirer>();
  const backgroundFollowLeasesBySessionId = new Map<string, ManagedFollowLeaseRecord>();

  const releaseFollowLease = async (leaseId: string, sessionId: string): Promise<boolean> => {
    const record = followLeasesById.get(leaseId) ?? null;
    if (!record || record.sessionId !== sessionId) return false;
    followLeasesById.delete(leaseId);
    clearManagedTimer(record.expiryTimer, clearTimer);
    await record.release?.();
    return true;
  };

  const releaseBackgroundFollowLease = async (sessionId: string): Promise<boolean> => {
    const record = backgroundFollowLeasesBySessionId.get(sessionId) ?? null;
    if (!record) return false;
    backgroundFollowLeasesBySessionId.delete(sessionId);
    clearManagedTimer(record.expiryTimer, clearTimer);
    await record.release?.();
    return true;
  };

  const acquireDetachedBackgroundFollowLease = async (
    sessionId: string,
    acquireFollowLease: FollowLeaseAcquirer | null | undefined,
  ): Promise<boolean> => {
    if (backgroundFollowLeasesBySessionId.has(sessionId)) {
      return false;
    }
    if (!acquireFollowLease) {
      return false;
    }
    const followLease = await acquireFollowLease();
    if (!followLease) {
      return false;
    }
    backgroundFollowLeasesBySessionId.set(sessionId, {
      sessionId,
      release: followLease.release,
      expiryTimer: null,
    });
    return true;
  };

  const handleNoActiveViewerLeases = async (sessionId: string): Promise<void> => {
    if (viewerLeaseRegistry.countActiveLeases(sessionId) > 0) {
      return;
    }
    if (backgroundFollowEnabledBySessionId.get(sessionId) === true) {
      const acquireFollowLease = backgroundFollowAcquireBySessionId.get(sessionId) ?? null;
      if (acquireFollowLease) {
        await acquireDetachedBackgroundFollowLease(sessionId, acquireFollowLease).catch(() => false);
      }
      return;
    }
    await releaseBackgroundFollowLease(sessionId);
  };

  const scheduleExpiry = (leaseId: string, sessionId: string, expiresAtMs: number): void => {
    const record = followLeasesById.get(leaseId);
    if (!record || record.sessionId !== sessionId) return;
    clearManagedTimer(record.expiryTimer, clearTimer);
    const delayMs = Math.max(0, expiresAtMs - now());
    record.expiryTimer = setTimer(() => {
      void (async () => {
        viewerLeaseRegistry.detach({ sessionId, leaseId });
        await releaseFollowLease(leaseId, sessionId).catch(() => false);
        await handleNoActiveViewerLeases(sessionId);
      })();
    }, delayMs);
  };

  return {
    async attach(input: Readonly<{
      sessionId: string;
      leaseId?: string | null;
      ttlMs: number;
      acquireFollowLease?: FollowLeaseAcquirer;
    }>) {
      const attached = viewerLeaseRegistry.attach({
        sessionId: input.sessionId,
        leaseId: input.leaseId,
        ttlMs: input.ttlMs,
      });

      const existing = followLeasesById.get(attached.leaseId) ?? null;
      if (!attached.renewed) {
        try {
          const followLease = backgroundFollowLeasesBySessionId.has(input.sessionId)
            ? null
            : (await input.acquireFollowLease?.()) ?? null;
          followLeasesById.set(attached.leaseId, {
            sessionId: input.sessionId,
            release: followLease?.release ?? null,
            expiryTimer: null,
          });
        } catch (error) {
          viewerLeaseRegistry.detach({
            sessionId: input.sessionId,
            leaseId: attached.leaseId,
          });
          throw error;
        }
      } else if (!existing) {
        followLeasesById.set(attached.leaseId, {
          sessionId: input.sessionId,
          release: null,
          expiryTimer: null,
        });
      }

      scheduleExpiry(attached.leaseId, input.sessionId, attached.expiresAtMs);
      return attached;
    },

    async detach(input: Readonly<{ sessionId: string; leaseId: string }>) {
      const detached = viewerLeaseRegistry.detach(input);
      if (detached.detached) {
        await releaseFollowLease(input.leaseId, input.sessionId).catch(() => false);
        await handleNoActiveViewerLeases(input.sessionId);
      }
      return detached;
    },

    async setBackgroundFollowEnabled(input: Readonly<{
      sessionId: string;
      enabled: boolean;
      acquireFollowLease?: FollowLeaseAcquirer;
    }>) {
      backgroundFollowEnabledBySessionId.set(input.sessionId, input.enabled);

      if (!input.enabled) {
        backgroundFollowAcquireBySessionId.delete(input.sessionId);
        if (viewerLeaseRegistry.countActiveLeases(input.sessionId) === 0) {
          await releaseBackgroundFollowLease(input.sessionId).catch(() => false);
        }
        return { enabled: false, leaseAcquired: false } as const;
      }

      if (input.acquireFollowLease) {
        backgroundFollowAcquireBySessionId.set(input.sessionId, input.acquireFollowLease);
      }

      if (backgroundFollowLeasesBySessionId.has(input.sessionId)) {
        return { enabled: true, leaseAcquired: false } as const;
      }

      if (viewerLeaseRegistry.countActiveLeases(input.sessionId) > 0) {
        return { enabled: true, leaseAcquired: false } as const;
      }

      const acquireFollowLease =
        input.acquireFollowLease ?? backgroundFollowAcquireBySessionId.get(input.sessionId) ?? null;
      if (!acquireFollowLease) {
        return { enabled: true, leaseAcquired: false } as const;
      }

      const followLease = await acquireFollowLease();
      if (!followLease) {
        return { enabled: true, leaseAcquired: false } as const;
      }
      backgroundFollowLeasesBySessionId.set(input.sessionId, {
        sessionId: input.sessionId,
        release: followLease.release,
        expiryTimer: null,
      });

      return { enabled: true, leaseAcquired: true, followLease } as const;
    },

    countActiveLeases(sessionId: string): number {
      return viewerLeaseRegistry.countActiveLeases(sessionId);
    },

    isBackgroundFollowEnabled(sessionId: string): boolean {
      return backgroundFollowEnabledBySessionId.get(sessionId) ?? false;
    },

    hasBackgroundFollowLease(sessionId: string): boolean {
      return backgroundFollowLeasesBySessionId.has(sessionId);
    },
  };
}
