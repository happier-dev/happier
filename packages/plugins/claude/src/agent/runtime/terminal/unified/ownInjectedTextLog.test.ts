import { describe, expect, it } from 'vitest';

import { createClaudeUnifiedOwnInjectedTextLog, createPersistedClaudeUnifiedOwnInjectedTextLog } from './ownInjectedTextLog.js';

describe('createClaudeUnifiedOwnInjectedTextLog', () => {
  it('matches an exact runtime-injected text and never a partial or foreign draft', () => {
    const log = createClaudeUnifiedOwnInjectedTextLog();
    log.record('fix the failing test in utils.ts');

    expect(log.matches('fix the failing test in utils.ts')).toBe(true);
    expect(log.matches('  fix the failing test in utils.ts  ')).toBe(true);
    // Partial/substring content is NEVER ours — a genuine user draft must never match.
    expect(log.matches('fix the failing test')).toBe(false);
    expect(log.matches('my own typed draft')).toBe(false);
    expect(log.matches('')).toBe(false);
    expect(log.matches(null)).toBe(false);
  });

  it('matches any full line of a multiline injection (the composer shows the bottom line)', () => {
    const log = createClaudeUnifiedOwnInjectedTextLog();
    log.record('first instruction line\nsecond instruction line');

    expect(log.matches('second instruction line')).toBe(true);
    expect(log.matches('first instruction line')).toBe(true);
    expect(log.matches('instruction line')).toBe(false);
  });

  it('matches a soft-wrapped rendering of a recorded text (whitespace-collapse; ported S-2)', () => {
    // C11 live: the TUI soft-wraps a long draft across composer lines; the continuation capture
    // re-joins them with newlines, so equality must ignore WHERE whitespace breaks fall while
    // every word still matches exactly.
    const log = createClaudeUnifiedOwnInjectedTextLog();
    log.record('please refactor the parser and then run the full unit suite to confirm');

    expect(log.matches('please refactor the parser and\nthen run the full unit suite to\nconfirm')).toBe(true);
    expect(log.matches('please refactor the parser  and then run the full unit suite to confirm')).toBe(true);
    // Words must still match exactly: a genuine user draft never collapses to a recorded text.
    expect(log.matches('please refactor the parser andthen run the full unit suite to confirm')).toBe(false);
    expect(log.matches('please refactor the parser and then run the full unit suite')).toBe(false);
  });

  it('is bounded: old entries are evicted past the limit', () => {
    const log = createClaudeUnifiedOwnInjectedTextLog(4);
    for (let index = 0; index < 10; index += 1) {
      log.record(`injected prompt ${index}`);
    }

    expect(log.matches('injected prompt 0')).toBe(false);
    expect(log.matches('injected prompt 9')).toBe(true);
  });

  it('ignores empty/whitespace-only records', () => {
    const log = createClaudeUnifiedOwnInjectedTextLog();
    log.record('   ');

    expect(log.matches('   ')).toBe(false);
  });
});

describe('createPersistedClaudeUnifiedOwnInjectedTextLog (ported S-1)', () => {
  function memoryStorage() {
    const store = new Map<string, unknown>();
    return {
      store,
      scope: {
        get: async <T,>(key: string): Promise<T | null> => (store.has(key) ? (store.get(key) as T) : null),
        set: async (key: string, value: unknown): Promise<void> => {
          store.set(key, JSON.parse(JSON.stringify(value)));
        },
      },
    };
  }

  it('hydrates the previous runner texts from session storage so a respawn recognizes its leftover', async () => {
    const { scope } = memoryStorage();

    const first = createPersistedClaudeUnifiedOwnInjectedTextLog({ storage: scope });
    await first.hydrated;
    first.record('injected before the runner respawned');
    await first.flush();

    // New runner process: a fresh log over the same session storage.
    const second = createPersistedClaudeUnifiedOwnInjectedTextLog({ storage: scope });
    await second.hydrated;

    expect(second.matches('injected before the runner respawned')).toBe(true);
    expect(second.matches('a genuine user draft')).toBe(false);
  });

  it('persists a BOUNDED set and tolerates malformed stored values (fail-open to empty)', async () => {
    const { scope, store } = memoryStorage();

    const log = createPersistedClaudeUnifiedOwnInjectedTextLog({ storage: scope, limit: 3 });
    await log.hydrated;
    for (let index = 0; index < 6; index += 1) log.record(`prompt ${index}`);
    await log.flush();

    const rehydrated = createPersistedClaudeUnifiedOwnInjectedTextLog({ storage: scope, limit: 3 });
    await rehydrated.hydrated;
    expect(rehydrated.matches('prompt 5')).toBe(true);
    expect(rehydrated.matches('prompt 0')).toBe(false);

    // Malformed value: hydration must fail open (empty log), never throw.
    for (const key of store.keys()) store.set(key, { not: 'an array' });
    const malformed = createPersistedClaudeUnifiedOwnInjectedTextLog({ storage: scope });
    await malformed.hydrated;
    expect(malformed.matches('prompt 5')).toBe(false);
  });

  it('keeps matching usable when storage reads/writes fail (in-memory behavior intact)', async () => {
    const broken = {
      get: async (): Promise<never> => {
        throw new Error('storage read failed');
      },
      set: async (): Promise<never> => {
        throw new Error('storage write failed');
      },
    };

    const log = createPersistedClaudeUnifiedOwnInjectedTextLog({ storage: broken });
    await log.hydrated;
    log.record('still works in memory');
    await log.flush();

    expect(log.matches('still works in memory')).toBe(true);
  });
});
