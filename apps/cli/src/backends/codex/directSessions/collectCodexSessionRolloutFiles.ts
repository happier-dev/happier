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

function parseRemoteSessionTimestampMs(remoteSessionId: string): number | null {
  const normalized = String(remoteSessionId ?? '').replace(/-/g, '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) return null;
  try {
    const ms = Number.parseInt(normalized.slice(0, 12), 16);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    if (year < 2020 || year > 2100) return null;
    return ms;
  } catch {
    return null;
  }
}

function readTargetedDayScanLimitDays(env?: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env?.HAPPIER_CODEX_DIRECT_SESSIONS_MAX_DAY_SCAN_DAYS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 365;
  return Math.max(1, Math.min(3_650, configured));
}

function toDayDirParts(date: Date): readonly [string, string, string] {
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ];
}

function buildLikelyRolloutDayDirs(params: Readonly<{ codexHome: string; remoteSessionId: string; env?: NodeJS.ProcessEnv }>): string[] {
  const remoteSessionTimestampMs = parseRemoteSessionTimestampMs(params.remoteSessionId);
  if (remoteSessionTimestampMs === null) return [];

  const maxDayScanDays = readTargetedDayScanLimitDays(params.env);
  const startDayMs = Date.UTC(
    new Date(remoteSessionTimestampMs).getUTCFullYear(),
    new Date(remoteSessionTimestampMs).getUTCMonth(),
    new Date(remoteSessionTimestampMs).getUTCDate(),
  );
  const currentDay = new Date();
  const currentDayMs = Date.UTC(currentDay.getUTCFullYear(), currentDay.getUTCMonth(), currentDay.getUTCDate());
  const elapsedDays = Math.max(0, Math.trunc((currentDayMs - startDayMs) / 86_400_000));
  if (elapsedDays > maxDayScanDays) return [];

  const results: string[] = [];
  const seen = new Set<string>();
  for (let offsetDays = -1; offsetDays <= elapsedDays + 1; offsetDays++) {
    const dayMs = startDayMs + offsetDays * 86_400_000;
    const parts = toDayDirParts(new Date(dayMs));
    const sessionDir = join(params.codexHome, 'sessions', ...parts);
    const archivedDir = join(params.codexHome, 'archived_sessions', ...parts);
    if (!seen.has(sessionDir)) {
      seen.add(sessionDir);
      results.push(sessionDir);
    }
    if (!seen.has(archivedDir)) {
      seen.add(archivedDir);
      results.push(archivedDir);
    }
  }
  return results;
}

async function collectRolloutMatchesFromFlatDir(params: Readonly<{ codexHome: string; dir: string; remoteSessionId: string }>): Promise<CodexRolloutFile[]> {
  let entries: any[];
  try {
    entries = await readdir(params.dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: CodexRolloutFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
    if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
    if (!name.includes(params.remoteSessionId)) continue;

    const filePath = join(params.dir, name);
    try {
      const s = await stat(filePath);
      const fromName = parseRolloutTimestampFromFilename(filePath);
      const fromBirth = Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0 ? s.birthtimeMs : null;
      const sortMs = Math.max(fromName ?? 0, fromBirth ?? 0, s.mtimeMs);
      const fileRelPath = relative(params.codexHome, filePath);
      matches.push({ filePath, fileRelPath, sortMs, mtimeMs: s.mtimeMs });
    } catch {
      // ignore unreadable
    }
  }

  return matches;
}

export async function collectCodexSessionRolloutFiles(params: Readonly<{ codexHome: string; remoteSessionId: string }>): Promise<CodexRolloutFile[]> {
  const targetedMatches = (
    await Promise.all(
      buildLikelyRolloutDayDirs({
        codexHome: params.codexHome,
        remoteSessionId: params.remoteSessionId,
        env: process.env,
      }).map((dir) => collectRolloutMatchesFromFlatDir({
        codexHome: params.codexHome,
        dir,
        remoteSessionId: params.remoteSessionId,
      })),
    )
  ).flat();

  if (targetedMatches.length > 0) {
    targetedMatches.sort((a, b) => a.sortMs - b.sortMs || a.mtimeMs - b.mtimeMs);
    return targetedMatches;
  }

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
