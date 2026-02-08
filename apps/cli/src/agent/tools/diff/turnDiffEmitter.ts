type TurnDiffOutput = {
  unified_diff?: string;
  files?: Array<{
    file_path: string;
    unified_diff?: string;
    oldText?: string;
    newText?: string;
    description?: string;
  }>;
};

type TextDiffSignal = Readonly<{
  filePath: string;
  oldText: string;
  newText: string;
  description?: string;
}>;

type UnifiedDiffSignal = Readonly<{
  filePath?: string;
  unifiedDiff: string;
  description?: string;
}>;

type UnifiedDiffSnapshotSignal = Readonly<{
  unifiedDiff: string;
}>;

type Entry =
  | Readonly<{
      kind: 'text';
      filePath: string;
      oldText: string;
      newText: string;
      description?: string;
      order: number;
    }>
  | Readonly<{
      kind: 'unified';
      filePath: string;
      unifiedDiff: string;
      description?: string;
      order: number;
    }>;

export type TurnDiffEmitterOptions = Readonly<{
  /**
   * When enabled, `observeUnifiedDiffSnapshot()` stores a single `unified_diff` snapshot for the
   * whole turn. This is appropriate for providers like Codex that emit turn-level unified diffs.
   *
   * When disabled, snapshot signals are ignored.
   */
  snapshotUnifiedDiff?: boolean;
}>;

/**
 * Shared "turn diff" coalescer.
 *
 * Goal: emit a reliable per-turn representation of file changes:
 * - Prefer net text diffs (old/new full text pairs) when available.
 * - Otherwise keep the latest unified diff per file (best-effort).
 * - Optionally keep a single turn-level unified diff snapshot for snapshot providers.
 */
export class TurnDiffEmitter {
  private readonly snapshotUnifiedDiff: boolean;
  private orderCounter = 0;
  private readonly byFilePath = new Map<string, Entry>();
  private unifiedSnapshot: string | null = null;

  constructor(opts?: TurnDiffEmitterOptions) {
    this.snapshotUnifiedDiff = opts?.snapshotUnifiedDiff === true;
  }

  beginTurn(): void {
    this.orderCounter = 0;
    this.byFilePath.clear();
    this.unifiedSnapshot = null;
  }

  observeTextDiff(signal: TextDiffSignal): void {
    const filePath = signal.filePath.trim();
    if (!filePath) return;

    const existing = this.byFilePath.get(filePath);
    if (!existing) {
      this.byFilePath.set(filePath, {
        kind: 'text',
        filePath,
        oldText: signal.oldText,
        newText: signal.newText,
        description: signal.description,
        order: this.orderCounter++,
      });
      return;
    }

    if (existing.kind === 'text') {
      if (existing.newText === signal.newText) return;
      this.byFilePath.set(filePath, {
        kind: 'text',
        filePath,
        oldText: existing.oldText,
        newText: signal.newText,
        description: signal.description ?? existing.description,
        order: existing.order,
      });
      return;
    }

    // Override unified diffs with net text diffs when available.
    this.byFilePath.set(filePath, {
      kind: 'text',
      filePath,
      oldText: signal.oldText,
      newText: signal.newText,
      description: signal.description ?? existing.description,
      order: existing.order,
    });
  }

  observeUnifiedDiff(signal: UnifiedDiffSignal): void {
    const rawPath = signal.filePath?.trim() ?? '';
    const filePath = rawPath;
    if (!filePath) return;

    const existing = this.byFilePath.get(filePath);
    // Do not overwrite net text diffs.
    if (existing && existing.kind === 'text') return;

    if (!existing) {
      this.byFilePath.set(filePath, {
        kind: 'unified',
        filePath,
        unifiedDiff: signal.unifiedDiff,
        description: signal.description,
        order: this.orderCounter++,
      });
      return;
    }

    if (existing.kind === 'unified' && existing.unifiedDiff === signal.unifiedDiff) return;
    this.byFilePath.set(filePath, {
      kind: 'unified',
      filePath,
      unifiedDiff: signal.unifiedDiff,
      description: signal.description ?? existing.description,
      order: existing.order,
    });
  }

  observeUnifiedDiffSnapshot(signal: UnifiedDiffSnapshotSignal): void {
    if (!this.snapshotUnifiedDiff) return;
    if (this.unifiedSnapshot === signal.unifiedDiff) return;
    this.unifiedSnapshot = signal.unifiedDiff;
  }

  flushTurn(): TurnDiffOutput {
    const snapshot = this.unifiedSnapshot;
    const entries = Array.from(this.byFilePath.values()).sort((a, b) => a.order - b.order);

    this.byFilePath.clear();
    this.unifiedSnapshot = null;

    if (entries.length > 0) {
      return {
        files: entries.map((entry) => {
          if (entry.kind === 'text') {
            return {
              file_path: entry.filePath,
              oldText: entry.oldText,
              newText: entry.newText,
              ...(entry.description ? { description: entry.description } : {}),
            };
          }
          return {
            file_path: entry.filePath,
            unified_diff: entry.unifiedDiff,
            ...(entry.description ? { description: entry.description } : {}),
          };
        }),
      };
    }

    if (snapshot && snapshot.trim().length > 0) {
      return { unified_diff: snapshot };
    }

    return {};
  }
}
