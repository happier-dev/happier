import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createTempSessionDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupTempSessionDir(dir: string): void {
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

export function writeSessionJsonl(dir: string, sessionId: string, lines: string[]): string {
  const filePath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

export function writeSessionObjectLines(
  dir: string,
  sessionId: string,
  records: Array<Record<string, unknown>>,
): string {
  return writeSessionJsonl(
    dir,
    sessionId,
    records.map((record) => JSON.stringify(record)),
  );
}

export function setSessionMtime(filePath: string, date: Date): void {
  utimesSync(filePath, date, date);
}
