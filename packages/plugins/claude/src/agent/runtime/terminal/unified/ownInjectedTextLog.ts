/**
 * Bounded match log of every text the runtime itself wrote into the Claude TUI
 * (lane X1, incident 294-veto starvation loop). Lets the readiness/steer evaluator tell an
 * OWN injection leftover (safe to clear) apart from a genuine user draft (NEVER cleared).
 *
 * Match semantics are deliberately strict: the trimmed full text, the whitespace-collapsed form
 * of the full text, a collapsed-paste marker for a recent multiline injection, or a long visible
 * window from an interrupted injection while its bounded entry remains recorded. Individual prompt
 * lines are not clearable ownership evidence; short windows require explicit recent possible-write
 * evidence so a genuine user draft does not classify as ours.
 */

import {
  countPromptNewlines,
  pastedTextLineCountMatchesPrompt,
  parseExactClaudePastedTextMarkerLineCount,
} from './pastedTextMarker.js';

import {
  CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS,
  isClaudeUnifiedComposerTextMatch,
  normalizeClaudeUnifiedComposerRenderingText,
  normalizeClaudeUnifiedPromptIdentityText,
} from './promptIdentity.js';

const DEFAULT_OWN_INJECTED_TEXT_LOG_LIMIT = 32;
const DEFAULT_PREFIX_RESIDUE_WINDOW_MS = 2 * 60_000;
const DEFAULT_LARGE_COLLAPSED_PASTE_MARKER_WINDOW_MS = 10 * 60_000;
const LARGE_COLLAPSED_PASTE_MARKER_MIN_LINES = 200;
const MIN_CONTEXTUAL_PREFIX_RESIDUE_CHARS = 32;

export type ClaudeUnifiedOwnInjectedTextLog = Readonly<{
  record(text: string): void;
  /**
   * Mark a text whose terminal write failed after bytes may already have reached the composer.
   * This enables a short-prefix match for the same bounded residue window; ordinary records keep
   * rejecting short windows so genuine user drafts remain protected.
   */
  recordPossiblePartialResidue(text: string, opts?: Readonly<{ minPrefixChars?: number | undefined }>): void;
  matches(candidate: string | null | undefined): boolean;
  /**
   * Recorded texts (oldest first, bounded) for durable persistence across runner respawns
   * (ported S-1): a leftover own draft must still be recognized by the NEXT runner process.
   */
  snapshot(): readonly string[];
}>;

type OwnInjectedTextLogEntry = Readonly<{
  text: string;
  collapsedText: string;
  clearableCandidates: ReadonlySet<string>;
  collapsedPasteLineCount?: number | undefined;
  recordedAtMs: number;
  shortPrefixResidueUntilMs?: number | undefined;
  minShortPrefixResidueChars: number;
}>;

function isRecordedComposerWindow(params: Readonly<{
  entry: OwnInjectedTextLogEntry;
  normalizedDraft: string;
  nowMs: number;
}>): boolean {
  // A long exact window carries the same content identity as the full recorded text. Keep it valid
  // for as long as that bounded entry remains recorded: a failed Enter can leave Claude's viewport
  // parked on the tail for hours. Only weak, short possible-write evidence expires by time.
  const longRecordedWindow = params.normalizedDraft.length >= CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS;
  const contextualShortPrefixResidue = params.normalizedDraft.length >= params.entry.minShortPrefixResidueChars
    && params.entry.shortPrefixResidueUntilMs !== undefined
    && params.nowMs <= params.entry.shortPrefixResidueUntilMs;
  if (!longRecordedWindow && !contextualShortPrefixResidue) return false;
  return isClaudeUnifiedComposerTextMatch({
    promptText: params.entry.text,
    composerText: params.normalizedDraft,
    minPrefixChars: contextualShortPrefixResidue
      ? params.entry.minShortPrefixResidueChars
      : CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS,
  });
}

function isCollapsedPasteMarkerMatch(params: Readonly<{
  entry: OwnInjectedTextLogEntry;
  collapsedPasteLineCount: number | null;
  nowMs: number;
  prefixResidueWindowMs: number;
  largeCollapsedPasteMarkerWindowMs: number;
}>): boolean {
  if (
    params.collapsedPasteLineCount === null
    || params.entry.collapsedPasteLineCount === undefined
    || !pastedTextLineCountMatchesPrompt({
      promptText: params.entry.text,
      pastedLineCount: params.collapsedPasteLineCount,
    })
  ) {
    return false;
  }
  const markerWindowMs = params.collapsedPasteLineCount >= LARGE_COLLAPSED_PASTE_MARKER_MIN_LINES
    ? params.largeCollapsedPasteMarkerWindowMs
    : params.prefixResidueWindowMs;
  return params.nowMs - params.entry.recordedAtMs <= markerWindowMs;
}

export function createClaudeUnifiedOwnInjectedTextLog(
  limit: number = DEFAULT_OWN_INJECTED_TEXT_LOG_LIMIT,
  opts?: Readonly<{
    nowMs?: (() => number) | undefined;
    prefixResidueWindowMs?: number | undefined;
    largeCollapsedPasteMarkerWindowMs?: number | undefined;
  }>,
): ClaudeUnifiedOwnInjectedTextLog {
  const boundedLimit = Math.max(1, Math.trunc(limit));
  const nowMs = opts?.nowMs ?? Date.now;
  const prefixResidueWindowMs = Math.max(0, Math.trunc(opts?.prefixResidueWindowMs ?? DEFAULT_PREFIX_RESIDUE_WINDOW_MS));
  const largeCollapsedPasteMarkerWindowMs = Math.max(
    prefixResidueWindowMs,
    Math.trunc(opts?.largeCollapsedPasteMarkerWindowMs ?? DEFAULT_LARGE_COLLAPSED_PASTE_MARKER_WINDOW_MS),
  );
  const entries: OwnInjectedTextLogEntry[] = [];

  const createEntry = (
    trimmed: string,
    recordedAtMs: number,
    shortPrefixResidueUntilMs?: number | undefined,
    minShortPrefixResidueChars = MIN_CONTEXTUAL_PREFIX_RESIDUE_CHARS,
  ): OwnInjectedTextLogEntry => {
    const collapsedText = normalizeClaudeUnifiedComposerRenderingText(trimmed);
    const clearableCandidates = new Set<string>([trimmed, collapsedText]);
    const newlineCount = countPromptNewlines(trimmed);
    return {
      text: trimmed,
      collapsedText,
      clearableCandidates,
      ...(newlineCount > 0 ? { collapsedPasteLineCount: newlineCount } : {}),
      recordedAtMs,
      shortPrefixResidueUntilMs,
      minShortPrefixResidueChars,
    };
  };

  const trimToLimit = (): void => {
    while (entries.length > boundedLimit) {
      entries.shift();
    }
  };

  return {
    record(text) {
      const trimmed = normalizeClaudeUnifiedPromptIdentityText(text);
      if (!trimmed) return;
      entries.push(createEntry(trimmed, nowMs()));
      trimToLimit();
    },
    recordPossiblePartialResidue(text, recordOpts) {
      const trimmed = normalizeClaudeUnifiedPromptIdentityText(text);
      if (!trimmed) return;
      const now = nowMs();
      const shortPrefixResidueUntilMs = now + prefixResidueWindowMs;
      const minShortPrefixResidueChars = Math.max(
        1,
        Math.trunc(recordOpts?.minPrefixChars ?? MIN_CONTEXTUAL_PREFIX_RESIDUE_CHARS),
      );
      const existingIndex = entries.findIndex((entry) => entry.text === trimmed);
      if (existingIndex >= 0) {
        const existing = entries[existingIndex];
        if (existing) {
          entries[existingIndex] = {
            ...existing,
            shortPrefixResidueUntilMs,
            minShortPrefixResidueChars: Math.min(existing.minShortPrefixResidueChars, minShortPrefixResidueChars),
          };
        }
        return;
      }
      entries.push(createEntry(trimmed, now, shortPrefixResidueUntilMs, minShortPrefixResidueChars));
      trimToLimit();
    },
    matches(candidate) {
      const trimmed = typeof candidate === 'string'
        ? normalizeClaudeUnifiedPromptIdentityText(candidate)
        : '';
      if (!trimmed) return false;
      const collapsed = normalizeClaudeUnifiedComposerRenderingText(trimmed);
      const referenceMs = nowMs();
      const collapsedPasteLineCount = parseExactClaudePastedTextMarkerLineCount(trimmed);
      return entries.some((entry) => (
        entry.clearableCandidates.has(trimmed)
        || entry.clearableCandidates.has(collapsed)
        || isCollapsedPasteMarkerMatch({
          entry,
          collapsedPasteLineCount,
          nowMs: referenceMs,
          prefixResidueWindowMs,
          largeCollapsedPasteMarkerWindowMs,
        })
        || isRecordedComposerWindow({
          entry,
          normalizedDraft: trimmed,
          nowMs: referenceMs,
        })
        || (collapsed !== trimmed && isRecordedComposerWindow({
          entry,
          normalizedDraft: collapsed,
          nowMs: referenceMs,
        }))
      ));
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
    recordPossiblePartialResidue(text, recordOpts) {
      inner.recordPossiblePartialResidue(text, recordOpts);
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
