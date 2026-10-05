/**
 * The Find contract (plan §4.2): what one mounted findable surface's Find model exposes and what the
 * shared `HappierFindBar` draws. The surface owns matching, coverage and reveal; the bar owns chrome.
 */
export type FindOptions = Readonly<{ matchCase: boolean; regex: boolean }>;

/** Half-open UTF-16 ranges in the text owned by the addressed renderer. */
export type FindTextRange = Readonly<{ start: number; end: number; current: boolean }>;

/**
 * How much of the surface a result covers. Only `complete` may ever be reported as "no matches":
 * - `loaded`: the loaded window was searched; older content exists and was not.
 * - `olderRemaining`: older content remains after a stop.
 * - `limited`: an engine bound ended the search (terminal scrollback, decoration limit).
 * - `partialErrors`: some ranges could not be read (undecryptable pages, binary files).
 */
export type FindCoverage = 'complete' | 'loaded' | 'olderRemaining' | 'limited' | 'partialErrors';

export type FindStatus =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'invalidPattern' }>
  | Readonly<{ kind: 'results'; current: number | null; total: number; files?: number; coverage: FindCoverage }>
  /** Older content is still being searched; `current` keeps the selected match named ("2 of 4 so far"). */
  | Readonly<{ kind: 'searching'; total: number; current?: number | null }>
  | Readonly<{ kind: 'unavailable'; reason: 'offline' | 'unsupportedEngine' }>;

export type FindCapabilities = Readonly<{ regex: boolean; stop: boolean }>;

export interface FindController {
  readonly query: string;
  readonly options: FindOptions;
  readonly status: FindStatus;
  readonly capabilities: FindCapabilities;
  setQuery(query: string): void;
  setOptions(options: FindOptions): void;
  step(direction: 1 | -1): void;
  stop(): void;
  close(): void;
}
