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

  it('matches a long visible window while the own injection remains recorded but rejects short windows', () => {
    let nowMs = 10_000;
    const log = createClaudeUnifiedOwnInjectedTextLog(undefined, {
      nowMs: () => nowMs,
      prefixResidueWindowMs: 5_000,
    });
    const longPrompt = `please continue with the full implementation ${'x'.repeat(320)}`;
    log.record(longPrompt);

    expect(log.matches(longPrompt.slice(0, 280))).toBe(true);
    expect(log.matches(longPrompt.slice(-280))).toBe(true);
    expect(log.matches(longPrompt.slice(-80))).toBe(false);

    nowMs += 5_001;
    expect(log.matches(longPrompt.slice(-280))).toBe(true);
  });

  it('matches a short prefix only after a risky terminal write marked it as possible own residue', () => {
    let nowMs = 10_000;
    const log = createClaudeUnifiedOwnInjectedTextLog(undefined, {
      nowMs: () => nowMs,
      prefixResidueWindowMs: 5_000,
    });
    const longPrompt = `please produce the full report ${'x'.repeat(320)}`;
    const shortResidue = longPrompt.slice(0, 34);
    log.record(longPrompt);

    expect(log.matches(shortResidue)).toBe(false);

    log.recordPossiblePartialResidue(longPrompt);

    expect(log.matches(shortResidue)).toBe(true);
    expect(log.matches('please produce a different draft')).toBe(false);

    nowMs += 5_001;
    expect(log.matches(shortResidue)).toBe(false);
  });

  it('keeps very short prefix clearing scoped to provider-claimed pending residue', () => {
    let nowMs = 10_000;
    const log = createClaudeUnifiedOwnInjectedTextLog(undefined, {
      nowMs: () => nowMs,
      prefixResidueWindowMs: 5_000,
    });
    const longPrompt = `continue the exact pending message ${'x'.repeat(320)}`;
    const shortProviderResidue = longPrompt.slice(0, 19);
    log.record(longPrompt);

    log.recordPossiblePartialResidue(longPrompt);
    expect(log.matches(shortProviderResidue)).toBe(false);

    log.recordPossiblePartialResidue(longPrompt, { minPrefixChars: 16 });
    expect(log.matches(shortProviderResidue)).toBe(true);
    expect(log.matches('continue a different')).toBe(false);

    nowMs += 5_001;
    expect(log.matches(shortProviderResidue)).toBe(false);
  });

  it('does not treat one line of a multiline injection as clearable own residue', () => {
    const log = createClaudeUnifiedOwnInjectedTextLog();
    const prompt = 'first instruction line\nsecond instruction line';
    log.record(prompt);

    expect(log.matches(prompt)).toBe(true);
    expect(log.matches('second instruction line')).toBe(false);
    expect(log.matches('first instruction line')).toBe(false);
    expect(log.matches('instruction line')).toBe(false);
  });

  it('does not match a genuine edited draft with a one-letter suffix after a recorded prompt', () => {
    const log = createClaudeUnifiedOwnInjectedTextLog();
    const prompt = 'please continue with the refactor';
    log.record(prompt);

    expect(log.matches(`${prompt} d`)).toBe(false);
    expect(log.matches(`${prompt}\nd`)).toBe(false);
  });

  it('matches a recent Claude collapsed paste marker for a recorded multiline injection', () => {
    let nowMs = 10_000;
    const log = createClaudeUnifiedOwnInjectedTextLog(undefined, {
      nowMs: () => nowMs,
      prefixResidueWindowMs: 5_000,
    });
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');
    log.record(prompt);

    expect(log.matches('[Pasted text #1 +40 lines]')).toBe(true);
    expect(log.matches('[Pasted text +40 lines]')).toBe(true);
    expect(log.matches('[Pasted text #1 +39 lines]')).toBe(true);
    expect(log.matches('[Pasted text #1 +43 lines]')).toBe(true);
    expect(log.matches('[Pasted text #1 +44 lines]')).toBe(false);

    nowMs += 5_001;
    expect(log.matches('[Pasted text #1 +40 lines]')).toBe(false);
  });

  it('keeps large collapsed paste markers matchable through the scaled provider-acceptance wait', () => {
    let nowMs = 10_000;
    const log = createClaudeUnifiedOwnInjectedTextLog(undefined, { nowMs: () => nowMs });
    const prompt = Array.from({ length: 3_663 }, (_, index) => `line ${index}`).join('\n');
    log.record(prompt);

    nowMs += 181_000;
    expect(log.matches('[Pasted text #1 +3662 lines]')).toBe(true);

    nowMs += 10 * 60_000;
    expect(log.matches('[Pasted text #1 +3662 lines]')).toBe(false);
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
