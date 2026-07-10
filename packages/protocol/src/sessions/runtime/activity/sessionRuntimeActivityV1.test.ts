import { describe, expect, it } from "vitest";

import {
  buildSessionRuntimeActivityV1,
  hasActiveSessionRuntimeActivity,
  isRuntimeActivityOwnerLive,
  isSessionRuntimeActivityProjectionIdleForPendingDrain,
  listActiveSessionRuntimeActivitySources,
  readSessionRuntimeActivityV1,
  SESSION_RUNTIME_ACTIVITY_OWNER_LIVE_FRESHNESS_MS,
  SESSION_RUNTIME_ACTIVITY_PROJECTION_LEASE_MS,
} from "./sessionRuntimeActivityV1.js";

describe("SessionRuntimeActivityV1", () => {
  it("uses a generous dead-owner display backstop lease", () => {
    expect(SESSION_RUNTIME_ACTIVITY_PROJECTION_LEASE_MS).toBe(900_000);
  });

  it("uses the shared owner-liveness freshness window for runtime activity gates", () => {
    expect(SESSION_RUNTIME_ACTIVITY_OWNER_LIVE_FRESHNESS_MS).toBe(600_000);

    const nowMs = 1_000_000;
    expect(isRuntimeActivityOwnerLive({
      active: true,
      lastActiveAtMs: nowMs - SESSION_RUNTIME_ACTIVITY_OWNER_LIVE_FRESHNESS_MS + 1,
      nowMs,
    })).toBe(true);
    expect(isRuntimeActivityOwnerLive({
      active: true,
      lastActiveAtMs: nowMs - SESSION_RUNTIME_ACTIVITY_OWNER_LIVE_FRESHNESS_MS,
      nowMs,
    })).toBe(false);
  });

  it("builds a bounded active-source snapshot without treating stale sources as active", () => {
    const snapshot = buildSessionRuntimeActivityV1({
      observedAtMs: 1_000,
      nowMs: 1_000,
      sources: [
        {
          id: "task-active",
          kind: "provider_detached_task",
          status: "active",
          startedAtMs: 100,
          lastObservedAtMs: 900,
          expiresAtMs: 2_000,
        },
        {
          id: "task-stale",
          kind: "provider_detached_task",
          status: "active",
          startedAtMs: 100,
          lastObservedAtMs: 800,
          expiresAtMs: 999,
        },
      ],
    });

    expect(snapshot.activeCount).toBe(1);
    expect(hasActiveSessionRuntimeActivity(snapshot, 1_000)).toBe(true);
    expect(listActiveSessionRuntimeActivitySources(snapshot, 1_000).map((source) => source.id)).toEqual([
      "task-active",
    ]);
  });

  it("rejects malformed public activity snapshots instead of coercing unsafe values", () => {
    expect(readSessionRuntimeActivityV1({
      v: 1,
      observedAtMs: 1_000,
      activeCount: -1,
      sources: [],
    })).toBeNull();
    expect(readSessionRuntimeActivityV1({
      v: 1,
      observedAtMs: 1_000,
      activeCount: 1,
      sources: [
        {
          id: "task-active",
          kind: "provider_detached_task",
          status: "active",
          startedAtMs: 100,
          lastObservedAtMs: 900,
          expiresAtMs: -1,
        },
      ],
    })).toBeNull();
  });

  it.each([
    {
      name: "active count with fresh owner presence fails open after expiry",
      activeCount: 1,
      expiresAt: 4_999,
      ownerLive: true,
      expectedIdle: true,
    },
    {
      name: "active count with fresh owner presence fails open without expiry",
      activeCount: 1,
      expiresAt: null,
      ownerLive: true,
      expectedIdle: true,
    },
    {
      name: "active count without fresh owner presence stays non-idle before expiry",
      activeCount: 1,
      expiresAt: 10_000,
      ownerLive: false,
      expectedIdle: false,
    },
    {
      name: "active count without fresh owner presence fails open after expiry",
      activeCount: 1,
      expiresAt: 5_000,
      ownerLive: false,
      expectedIdle: true,
    },
    {
      name: "active count without fresh owner presence fails open without expiry",
      activeCount: 1,
      expiresAt: null,
      ownerLive: false,
      expectedIdle: true,
    },
    {
      name: "zero count stays idle even with fresh owner presence",
      activeCount: 0,
      expiresAt: 10_000,
      ownerLive: true,
      expectedIdle: true,
    },
  ])("derives pending-drain idleness when $name", ({ activeCount, expiresAt, ownerLive, expectedIdle }) => {
    expect(isSessionRuntimeActivityProjectionIdleForPendingDrain({
      runtimeActivityActiveCount: activeCount,
      runtimeActivityObservedAt: 4_000,
      runtimeActivityExpiresAt: expiresAt,
      runtimeActivitySourceClass: "provider_detached_task",
    }, 5_000, ownerLive)).toBe(expectedIdle);
  });

  it("accepts bigint projection timestamps for pending-drain idleness", () => {
    expect(isSessionRuntimeActivityProjectionIdleForPendingDrain({
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: BigInt(4_000),
      runtimeActivityExpiresAt: BigInt(10_000),
      runtimeActivitySourceClass: "provider_detached_task",
    }, 5_000, false)).toBe(false);
  });

});
