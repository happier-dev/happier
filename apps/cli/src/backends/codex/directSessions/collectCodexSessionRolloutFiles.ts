import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export type CodexRolloutFile = Readonly<{ filePath: string; fileRelPath: string; sortMs: number; mtimeMs: number }>;

function parseRolloutTimestampFromFilename(filePath: string): number | null {
  const name = filePath.split(/[/\\\\]/).pop() ?? '';
  const match = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(name);
  if (!match) return null;
  const compact = match[1];
  const isoLike = compact.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  const ms = Date.parse(`${isoLike}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export async function collectCodexSessionRolloutFiles(params: Readonly<{ codexHome: string; remoteSessionId: string }>): Promise<CodexRolloutFile[]> {
  const matches: CodexRolloutFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 10) return;
    let entries: any[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
      const full = join(dir, name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      if (!name.includes(params.remoteSessionId)) continue;
      try {
        const s = await stat(full);
        const fromName = parseRolloutTimestampFromFilename(full);
        const fromBirth = Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0 ? s.birthtimeMs : null;
        const sortMs = Math.max(fromName ?? 0, fromBirth ?? 0, s.mtimeMs);
        const fileRelPath = relative(params.codexHome, full);
        matches.push({ filePath: full, fileRelPath, sortMs, mtimeMs: s.mtimeMs });
      } catch {
        // ignore
      }
    }
  };

  await walk(join(params.codexHome, 'sessions'), 0);
  await walk(join(params.codexHome, 'archived_sessions'), 0);

  matches.sort((a, b) => a.sortMs - b.sortMs || a.mtimeMs - b.mtimeMs);
  return matches;
}

