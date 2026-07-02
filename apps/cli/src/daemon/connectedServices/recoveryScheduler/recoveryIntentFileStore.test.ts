import { mkdtemp, rm } from 'node:fs/promises';
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
