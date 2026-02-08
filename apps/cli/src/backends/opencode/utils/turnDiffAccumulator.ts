import { TurnDiffEmitter } from '@/agent/tools/diff/turnDiffEmitter';

type UnknownRecord = Record<string, unknown>;

type FileDiff = { file: string; before: string; after: string };

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function extractFileDiff(value: unknown): FileDiff | null {
  const record = asRecord(value);
  if (!record) return null;

  const file = readString(record.file);
  const before = readString(record.before);
  const after = readString(record.after);
  if (!file || before == null || after == null) return null;
  if (!file.trim()) return null;
  return { file: file.trim(), before, after };
}

function extractFileDiffFromToolResult(raw: unknown): FileDiff | null {
  const record = asRecord(raw);
  if (!record) return null;

  // OpenCode commonly emits: { output, metadata: { filediff } }
  const direct = extractFileDiff(asRecord(record.metadata)?.filediff);
  if (direct) return direct;

  // Some wrappers nest under { output: { metadata: { filediff } } }
  const nested = extractFileDiff(asRecord(asRecord(record.output)?.metadata)?.filediff);
  if (nested) return nested;

  return null;
}

/**
 * Aggregate per-tool edit diffs into a single per-file before/after pair for the turn.
 *
 * Rationale: OpenCode can emit multiple edit tool calls for the same file in a single turn. We want to
 * display the final net change for the turn, not intermediate states. We therefore keep the earliest
 * observed "before" and the latest observed "after" per file.
 */
export class OpenCodeTurnDiffAccumulator {
  private readonly emitter = new TurnDiffEmitter();

  beginTurn(): void {
    this.emitter.beginTurn();
  }

  observeToolResult(_toolName: string, rawResult: unknown): void {
    const filediff = extractFileDiffFromToolResult(rawResult);
    if (!filediff) return;

    this.emitter.observeTextDiff({
      filePath: filediff.file,
      oldText: filediff.before,
      newText: filediff.after,
    });
  }

  flushTurn(): { files: Array<{ file_path: string; oldText: string; newText: string }> } {
    const out = this.emitter.flushTurn();
    if (out.files && Array.isArray(out.files)) {
      const files = out.files
        .filter((file) => file && typeof file === 'object')
        .map((file) => ({
          file_path: String((file as any).file_path),
          oldText: String((file as any).oldText ?? ''),
          newText: String((file as any).newText ?? ''),
        }));
      return { files };
    }
    return { files: [] };
  }
}
