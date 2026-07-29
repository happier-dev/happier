import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createRecoveryIntentFileStore } from './recoveryIntentFileStore';

type TestIntent = Readonly<{
  v: 1;
  status: 'waiting';
  nextRetryAtMs: number;
}>;

describe('createRecoveryIntentFileStore', () => {
  it('preserves concurrent writes for different sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    try {
      const store = createRecoveryIntentFileStore<TestIntent>(join(dir, 'intents.json'));

      await Promise.all([
        store.write('session_a', { v: 1, status: 'waiting', nextRetryAtMs: 1_000 }),
        store.write('session_b', { v: 1, status: 'waiting', nextRetryAtMs: 2_000 }),
      ]);

      expect(Object.fromEntries(store.readAll?.() ?? [])).toEqual({
        session_a: { v: 1, status: 'waiting', nextRetryAtMs: 1_000 },
        session_b: { v: 1, status: 'waiting', nextRetryAtMs: 2_000 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes conditional transactions across store instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    try {
      const path = join(dir, 'intents.json');
      const first = createRecoveryIntentFileStore<TestIntent>(path);
      const second = createRecoveryIntentFileStore<TestIntent>(path);
      await first.write('session_a', { v: 1, status: 'waiting', nextRetryAtMs: 1_000 });
      const advance = (store: typeof first) => store.transact?.('session_a', (current) => ({
        intent: current.intent
          ? { ...current.intent, nextRetryAtMs: current.intent.nextRetryAtMs + 1 }
          : null,
        effectClaimToken: current.effectClaimToken,
        result: current.intent?.nextRetryAtMs ?? null,
      }));

      await Promise.all([advance(first), advance(second)]);

      expect(createRecoveryIntentFileStore<TestIntent>(path).read('session_a')).toMatchObject({ nextRetryAtMs: 1_002 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves predecessor effect claims when rewriting a v1 snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    try {
      const path = join(dir, 'intents.json');
      await writeFile(path, JSON.stringify({
        v: 1,
        intentsBySessionId: {
          session_a: { v: 1, status: 'waiting', nextRetryAtMs: 1_000 },
        },
        effectClaimsByRecoveryKey: {
          session_a: 'claim-from-predecessor',
        },
      }));
      const store = createRecoveryIntentFileStore<TestIntent>(path);

      await store.write('session_a', { v: 1, status: 'waiting', nextRetryAtMs: 2_000 });

      await expect(readFile(path, 'utf8').then((value) => JSON.parse(value) as unknown))
        .resolves.toMatchObject({
          v: 1,
          intentsBySessionId: {
            session_a: { nextRetryAtMs: 2_000 },
          },
          effectClaimsByRecoveryKey: {
            session_a: 'claim-from-predecessor',
          },
        });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves a different key claim across stale cross-instance write and prune mutations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    try {
      const path = join(dir, 'intents.json');
      const seed = createRecoveryIntentFileStore<TestIntent>(path);
      await seed.write('session_claimed', { v: 1, status: 'waiting', nextRetryAtMs: 1_000 });
      await seed.write('session_pruned', { v: 1, status: 'waiting', nextRetryAtMs: 2_000 });

      const staleWriter = createRecoveryIntentFileStore<TestIntent>(path);
      const stalePruner = createRecoveryIntentFileStore<TestIntent>(path);
      staleWriter.readAll?.();
      stalePruner.readAll?.();

      const claimer = createRecoveryIntentFileStore<TestIntent>(path);
      await claimer.transact?.('session_claimed', (current) => ({
        intent: current.intent,
        effectClaimToken: 'live-effect-owner',
        result: undefined,
      }));

      await staleWriter.write('session_other', { v: 1, status: 'waiting', nextRetryAtMs: 3_000 });
      await stalePruner.prune?.(({ sessionId }) => sessionId === 'session_pruned');

      await expect(readFile(path, 'utf8').then((value) => JSON.parse(value) as unknown))
        .resolves.toMatchObject({
          intentsBySessionId: {
            session_claimed: { nextRetryAtMs: 1_000 },
            session_other: { nextRetryAtMs: 3_000 },
          },
          effectClaimsByRecoveryKey: {
            session_claimed: 'live-effect-owner',
          },
        });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes cleared recovery intents from the persisted snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    try {
      const store = createRecoveryIntentFileStore<TestIntent>(join(dir, 'intents.json'));

      await store.write('session_a', { v: 1, status: 'waiting', nextRetryAtMs: 1_000 });
      await store.write('session_b', { v: 1, status: 'waiting', nextRetryAtMs: 2_000 });
      await store.remove?.('session_a');

      expect(store.read('session_a')).toBeNull();
      expect(Object.fromEntries(store.readAll?.() ?? [])).toEqual({
        session_b: { v: 1, status: 'waiting', nextRetryAtMs: 2_000 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prunes matching recovery intents from the persisted snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-recovery-intents-'));
    try {
      const store = createRecoveryIntentFileStore(join(dir, 'intents.json'));

      await store.write('active-session', { status: 'waiting', attempt: 1 });
      await store.write('old-terminal-session', { status: 'cancelled', terminalAtMs: 1_000 });
      await store.write('fresh-terminal-session', { status: 'exhausted', terminalAtMs: 9_500 });

      await expect(store.prune?.(({ value }) => (
        typeof value === 'object'
        && value !== null
        && 'terminalAtMs' in value
        && typeof value.terminalAtMs === 'number'
        && value.terminalAtMs < 5_000
      ))).resolves.toEqual(['old-terminal-session']);

      expect(Object.fromEntries(store.readAll?.() ?? [])).toEqual({
        'active-session': { status: 'waiting', attempt: 1 },
        'fresh-terminal-session': { status: 'exhausted', terminalAtMs: 9_500 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
