/**
 * Bounded match log of every text the runtime itself wrote into the Claude TUI
 * (lane X1, incident 294-veto starvation loop). Lets the readiness/steer evaluator tell an
 * OWN injection leftover (safe to clear) apart from a genuine user draft (NEVER cleared).
 *
 * Match semantics are deliberately strict: the trimmed full text, one full trimmed line of a
 * multiline injection (the parsed composer shows the bottom line only), or the whitespace-
 * collapsed form of the full text (ported S-2 / C11 live: the TUI soft-wraps long drafts, so
 * equality must ignore WHERE whitespace breaks fall while every word still matches exactly).
 * A genuine user draft can only match if its words are identical to something we injected.
 */

const DEFAULT_OWN_INJECTED_TEXT_LOG_LIMIT = 32;

export type ClaudeUnifiedOwnInjectedTextLog = Readonly<{
  record(text: string): void;
  matches(candidate: string | null | undefined): boolean;
  /**
   * Recorded texts (oldest first, bounded) for durable persistence across runner respawns
   * (ported S-1): a leftover own draft must still be recognized by the NEXT runner process.
   */
  snapshot(): readonly string[];
}>;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ');
}

export function createClaudeUnifiedOwnInjectedTextLog(
  limit: number = DEFAULT_OWN_INJECTED_TEXT_LOG_LIMIT,
): ClaudeUnifiedOwnInjectedTextLog {
  const boundedLimit = Math.max(1, Math.trunc(limit));
  const entries: Array<Readonly<{ text: string; candidates: ReadonlySet<string> }>> = [];

  return {
    record(text) {
      const trimmed = text.replace(/\r\n?/g, '\n').trim();
      if (!trimmed) return;
      const candidates = new Set<string>([trimmed, collapseWhitespace(trimmed)]);
      for (const line of trimmed.split('\n')) {
        const trimmedLine = line.trim();
        if (trimmedLine) candidates.add(trimmedLine);
      }
      entries.push({ text: trimmed, candidates });
      while (entries.length > boundedLimit) {
        entries.shift();
      }
    },
    matches(candidate) {
      const trimmed = candidate?.replace(/\r\n?/g, '\n').trim();
      if (!trimmed) return false;
      const collapsed = collapseWhitespace(trimmed);
      return entries.some((entry) => entry.candidates.has(trimmed) || entry.candidates.has(collapsed));
    },
    snapshot() {
      return entries.map((entry) => entry.text);
    },
  };
}

const OWN_INJECTED_TEXT_LOG_STORAGE_KEY = 'ownInjectedTextLogV1';

type OwnInjectedTextLogStorageScope = Readonly<{
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}>;

export type PersistedClaudeUnifiedOwnInjectedTextLog = ClaudeUnifiedOwnInjectedTextLog & Readonly<{
  /** Resolves when the previous runner's texts are loaded (never rejects; fail-open to empty). */
  hydrated: Promise<void>;
  /** Awaits all scheduled persistence writes (test/teardown seam). */
  flush(): Promise<void>;
}>;

/**
 * Durable variant over the per-session plugin storage scope (ported S-1 / C11): a leftover own
 * draft must still be recognized by the NEXT runner process after a respawn, or the readiness
 * evaluator classifies our own residue as a foreign user draft and idle injection starves
 * forever. Storage failures fail open to the plain in-memory log — matching never breaks.
 */
export function createPersistedClaudeUnifiedOwnInjectedTextLog(params: Readonly<{
  storage: OwnInjectedTextLogStorageScope;
  limit?: number;
  onStorageError?: (operation: 'hydrate' | 'persist', error: unknown) => void;
}>): PersistedClaudeUnifiedOwnInjectedTextLog {
  const inner = createClaudeUnifiedOwnInjectedTextLog(params.limit);

  const hydrated: Promise<void> = (async () => {
    try {
      const stored = await params.storage.get<unknown>(OWN_INJECTED_TEXT_LOG_STORAGE_KEY);
      if (!Array.isArray(stored)) return;
      for (const text of stored) {
        if (typeof text === 'string') inner.record(text);
      }
    } catch (error) {
      params.onStorageError?.('hydrate', error);
    }
  })();

  // Serialized writes: each persists the CURRENT snapshot after hydration, so concurrent records
  // cannot interleave partial states and hydration seeds are never overwritten by an older write.
  let persistChain: Promise<void> = hydrated;

  function schedulePersist(): void {
    persistChain = persistChain
      .then(() => params.storage.set(OWN_INJECTED_TEXT_LOG_STORAGE_KEY, inner.snapshot()))
      .catch((error) => {
        params.onStorageError?.('persist', error);
      });
  }

  return {
    record(text) {
      inner.record(text);
      schedulePersist();
    },
    matches(candidate) {
      return inner.matches(candidate);
    },
    snapshot() {
      return inner.snapshot();
    },
    hydrated,
    flush() {
      return persistChain;
    },
  };
}
