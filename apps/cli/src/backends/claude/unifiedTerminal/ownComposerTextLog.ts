import {
  countPromptNewlines,
  pastedTextLineCountMatchesPrompt,
  parseExactClaudePastedTextMarkerLineCount,
} from './claudePastedTextMarker';

import {
  CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS,
  isClaudeUnifiedComposerTextMatch,
  normalizeClaudeUnifiedComposerRenderingText,
  normalizeClaudeUnifiedPromptIdentityText,
} from './promptIdentity';

const DEFAULT_LIMIT = 32;
const DEFAULT_PREFIX_RESIDUE_WINDOW_MS = 2 * 60_000;
const DEFAULT_LARGE_COLLAPSED_PASTE_MARKER_WINDOW_MS = 10 * 60_000;
const LARGE_COLLAPSED_PASTE_MARKER_MIN_LINES = 200;
const MIN_CONTEXTUAL_PREFIX_RESIDUE_CHARS = 32;

export type ClaudeOwnComposerTextLog = Readonly<{
  /** Record a text WE wrote into the TUI (injected prompt). Bounded FIFO. */
  record: (text: string) => void;
  /**
   * Mark a text whose terminal write failed after bytes may already have reached the composer.
   * This enables a short-prefix match for the same bounded residue window; ordinary records keep
   * rejecting short windows so genuine user drafts remain protected.
   */
  recordPossiblePartialResidue: (text: string, opts?: { minPrefixChars?: number | undefined }) => void;
  /**
   * True when the composer draft matches recorded own text, or a recent long visible window from
   * an interrupted own injection. Short/old windows are intentionally rejected so a genuine user
   * draft does not classify as ours.
   */
  matches: (draft: string) => boolean;
}>;

function normalize(value: string): string {
  return normalizeClaudeUnifiedPromptIdentityText(value);
}

/**
 * Soft-wrap-insensitive form (C11 live, runner pid 20327): the TUI renders a long draft wrapped
 * across lines, so equality must ignore WHERE whitespace breaks fall — but every word must still
 * match exactly (a genuine user draft never collapses to a recorded text).
 */
type OwnComposerTextLogEntry = Readonly<{
  text: string;
  collapsedText: string;
  clearableCandidates: readonly string[];
  collapsedPasteLineCount?: number | undefined;
  recordedAtMs: number;
  shortPrefixResidueUntilMs?: number | undefined;
  minShortPrefixResidueChars: number;
}>;

function isRecentRecordedResidue(params: Readonly<{
  entry: OwnComposerTextLogEntry;
  normalizedDraft: string;
  nowMs: number;
  prefixResidueWindowMs: number;
}>): boolean {
  const longPrefixResidue = params.normalizedDraft.length >= CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS
    && params.nowMs - params.entry.recordedAtMs <= params.prefixResidueWindowMs;
  const contextualShortPrefixResidue = params.normalizedDraft.length >= params.entry.minShortPrefixResidueChars
    && params.entry.shortPrefixResidueUntilMs !== undefined
    && params.nowMs <= params.entry.shortPrefixResidueUntilMs;
  if (!longPrefixResidue && !contextualShortPrefixResidue) return false;
  return isClaudeUnifiedComposerTextMatch({
    promptText: params.entry.text,
    composerText: params.normalizedDraft,
    minPrefixChars: contextualShortPrefixResidue
      ? params.entry.minShortPrefixResidueChars
      : CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS,
  });
}

function isCollapsedPasteMarkerMatch(params: Readonly<{
  entry: OwnComposerTextLogEntry;
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

/**
 * Bounded log of texts the Claude Unified runtime itself wrote into the TUI (lane X, incident
 * cmq8y3nlx): a leftover composer draft that matches one of them, including a bounded recent long
 * viewport window from a truncated injection, is OUR OWN residue and may be cleared, while anything else is
 * treated as a genuine user draft.
 */
export function createClaudeOwnComposerTextLog(opts?: Readonly<{
  limit?: number;
  nowMs?: (() => number) | undefined;
  prefixResidueWindowMs?: number | undefined;
  largeCollapsedPasteMarkerWindowMs?: number | undefined;
}>): ClaudeOwnComposerTextLog {
  const limit = Math.max(1, Math.trunc(opts?.limit ?? DEFAULT_LIMIT));
  const nowMs = opts?.nowMs ?? Date.now;
  const prefixResidueWindowMs = Math.max(0, Math.trunc(opts?.prefixResidueWindowMs ?? DEFAULT_PREFIX_RESIDUE_WINDOW_MS));
  const largeCollapsedPasteMarkerWindowMs = Math.max(
    prefixResidueWindowMs,
    Math.trunc(opts?.largeCollapsedPasteMarkerWindowMs ?? DEFAULT_LARGE_COLLAPSED_PASTE_MARKER_WINDOW_MS),
  );
  const entries: OwnComposerTextLogEntry[] = [];

  const createEntry = (
    normalized: string,
    recordedAtMs: number,
    shortPrefixResidueUntilMs?: number | undefined,
    minShortPrefixResidueChars = MIN_CONTEXTUAL_PREFIX_RESIDUE_CHARS,
  ): OwnComposerTextLogEntry => {
    const collapsedText = normalizeClaudeUnifiedComposerRenderingText(normalized);
    const newlineCount = countPromptNewlines(normalized);
    return {
      text: normalized,
      collapsedText,
      // Clearable ownership is intentionally limited to the full injected text. Individual
      // prompt lines are only near-match evidence and must not become an Escape-clearing action.
      clearableCandidates: [normalized, collapsedText],
      ...(newlineCount > 0 ? { collapsedPasteLineCount: newlineCount } : {}),
      recordedAtMs,
      shortPrefixResidueUntilMs,
      minShortPrefixResidueChars,
    };
  };

  const trimToLimit = (): void => {
    while (entries.length > limit) entries.shift();
  };

  return {
    record(text) {
      const normalized = normalize(text);
      if (normalized.length === 0) return;
      entries.push(createEntry(normalized, nowMs()));
      trimToLimit();
    },
    recordPossiblePartialResidue(text, recordOpts) {
      const normalized = normalize(text);
      if (normalized.length === 0) return;
      const now = nowMs();
      const shortPrefixResidueUntilMs = now + prefixResidueWindowMs;
      const minShortPrefixResidueChars = Math.max(
        1,
        Math.trunc(recordOpts?.minPrefixChars ?? MIN_CONTEXTUAL_PREFIX_RESIDUE_CHARS),
      );
      const existingIndex = entries.findIndex((entry) => entry.text === normalized);
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
      entries.push(createEntry(normalized, now, shortPrefixResidueUntilMs, minShortPrefixResidueChars));
      trimToLimit();
    },
    matches(draft) {
      const normalized = normalize(draft);
      if (normalized.length === 0) return false;
      const collapsed = normalizeClaudeUnifiedComposerRenderingText(normalized);
      const referenceMs = nowMs();
      const collapsedPasteLineCount = parseExactClaudePastedTextMarkerLineCount(normalized);
      return entries.some((entry) => (
        entry.clearableCandidates.includes(normalized)
        || entry.clearableCandidates.includes(collapsed)
        || isCollapsedPasteMarkerMatch({
          entry,
          collapsedPasteLineCount,
          nowMs: referenceMs,
          prefixResidueWindowMs,
          largeCollapsedPasteMarkerWindowMs,
        })
        || isRecentRecordedResidue({
          entry,
          normalizedDraft: normalized,
          nowMs: referenceMs,
          prefixResidueWindowMs,
        })
        || (collapsed !== normalized && isRecentRecordedResidue({
          entry,
          normalizedDraft: collapsed,
          nowMs: referenceMs,
          prefixResidueWindowMs,
        }))
      ));
    },
  };
}
