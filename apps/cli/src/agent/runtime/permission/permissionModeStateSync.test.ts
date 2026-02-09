import { describe, expect, it } from 'vitest';

import {
  applyPermissionIntentFromMetadataIfNewer,
  applyStartupPermissionModeSeedIfNewer,
  readPermissionModeUpdatedAtFromMetadataSnapshot,
  type PermissionModeSeedSession,
} from './permissionModeStateSync';

describe('readPermissionModeUpdatedAtFromMetadataSnapshot', () => {
  it('returns 0 when metadata is missing updatedAt', () => {
    expect(readPermissionModeUpdatedAtFromMetadataSnapshot(null)).toBe(0);
    expect(readPermissionModeUpdatedAtFromMetadataSnapshot({} as any)).toBe(0);
  });

  it('returns metadata permissionModeUpdatedAt when present', () => {
    expect(readPermissionModeUpdatedAtFromMetadataSnapshot({ permissionModeUpdatedAt: 42 } as any)).toBe(42);
  });
});

describe('applyStartupPermissionModeSeedIfNewer', () => {
  const createSession = (seed: { intent: any; updatedAt: number } | null): PermissionModeSeedSession => ({
    getMetadataSnapshot: () => null,
    fetchLatestUserPermissionIntentFromTranscript: async () => seed,
  });

  it('skips transcript seeding when explicit permission mode is provided', async () => {
    let applied = false;

    const nextUpdatedAt = await applyStartupPermissionModeSeedIfNewer({
      explicitPermissionMode: 'plan',
      session: createSession({ intent: 'safe-yolo', updatedAt: 50 }),
      currentPermissionModeUpdatedAt: 10,
      apply: () => {
        applied = true;
      },
    });

    expect(nextUpdatedAt).toBe(10);
    expect(applied).toBe(false);
  });

  it('applies transcript seed only when newer than the current timestamp', async () => {
    let mode: string | null = null;
    let updatedAt = 10;

    const nextUpdatedAt = await applyStartupPermissionModeSeedIfNewer({
      explicitPermissionMode: undefined,
      session: createSession({ intent: 'safe-yolo', updatedAt: 25 }),
      currentPermissionModeUpdatedAt: updatedAt,
      apply: (next) => {
        mode = next.mode;
        updatedAt = next.updatedAt;
      },
    });

    expect(mode).toBe('safe-yolo');
    expect(updatedAt).toBe(25);
    expect(nextUpdatedAt).toBe(25);
  });

  it('does not apply transcript seed when it is missing or stale', async () => {
    const staleSession = createSession({ intent: 'safe-yolo', updatedAt: 9 });
    const emptySession = createSession(null);

    let staleApplied = false;
    let emptyApplied = false;

    const staleResult = await applyStartupPermissionModeSeedIfNewer({
      explicitPermissionMode: undefined,
      session: staleSession,
      currentPermissionModeUpdatedAt: 10,
      apply: () => {
        staleApplied = true;
      },
    });

    const emptyResult = await applyStartupPermissionModeSeedIfNewer({
      explicitPermissionMode: undefined,
      session: emptySession,
      currentPermissionModeUpdatedAt: 10,
      apply: () => {
        emptyApplied = true;
      },
    });

    expect(staleResult).toBe(10);
    expect(emptyResult).toBe(10);
    expect(staleApplied).toBe(false);
    expect(emptyApplied).toBe(false);
  });
});

describe('applyPermissionIntentFromMetadataIfNewer', () => {
  it('applies metadata permission intent when newer', () => {
    let mode: string | null = null;
    let updatedAt = 10;

    const nextUpdatedAt = applyPermissionIntentFromMetadataIfNewer({
      metadata: { permissionMode: 'acceptEdits', permissionModeUpdatedAt: 20 } as any,
      currentPermissionModeUpdatedAt: updatedAt,
      apply: (next) => {
        mode = next.intent;
        updatedAt = next.updatedAt;
      },
    });

    expect(mode).toBe('safe-yolo');
    expect(updatedAt).toBe(20);
    expect(nextUpdatedAt).toBe(20);
  });

  it('does nothing when metadata intent is absent or stale', () => {
    let applied = false;

    const absent = applyPermissionIntentFromMetadataIfNewer({
      metadata: { path: '/tmp' } as any,
      currentPermissionModeUpdatedAt: 10,
      apply: () => {
        applied = true;
      },
    });

    const stale = applyPermissionIntentFromMetadataIfNewer({
      metadata: { permissionMode: 'plan', permissionModeUpdatedAt: 10 } as any,
      currentPermissionModeUpdatedAt: 10,
      apply: () => {
        applied = true;
      },
    });

    expect(absent).toBe(10);
    expect(stale).toBe(10);
    expect(applied).toBe(false);
  });
});
