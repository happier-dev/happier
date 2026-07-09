import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * RR-7b: connected-service broker bridge sources emit self-contained runtime JS that performs the
 * daemon-bridge network call. A hung daemon must never hang a provider's auth path forever, so every
 * external wait (network fetch, child-process spawn) inside these broker sources MUST carry an
 * abort/timeout budget. This is the NEGATIVE property scan: it FAILS when anyone adds a NEW unbounded
 * external wait anywhere in the broker package — the per-leaf positive pins below only lock known sites.
 */

const BROKER_ROOT = fileURLToPath(new URL('.', import.meta.url));

async function readSource(relativeUrl: string): Promise<string> {
  return await readFile(new URL(relativeUrl, import.meta.url), 'utf8');
}

async function listProductionSources(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
      out.push(path);
    }
  }
  await walk(root);
  return out;
}

/**
 * Occurrences that ARE bounded but whose budget lives outside the heuristic window. Every entry needs
 * a one-line justification; additions without one should be treated as review findings.
 */
const BOUNDED_CALL_ALLOWLIST: ReadonlyArray<Readonly<{ file: string; marker: string; reason: string }>> = [];

function windowAround(source: string, index: number, before: number, after: number): string {
  const lines = source.slice(0, index).split('\n');
  const lineIndex = lines.length - 1;
  const all = source.split('\n');
  return all.slice(Math.max(0, lineIndex - before), lineIndex + after).join('\n');
}

/** Blanks comments (preserving offsets/newlines) so the scan only sees executable call sites. */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:"'`])\/\/[^\n]*/gu, (match, prefix: string) =>
      `${prefix}${' '.repeat(match.length - prefix.length)}`);
}

describe('connected service broker external wait boundedness invariant guard (RR-7b)', () => {
  it('keeps the emitted broker bridge fetch bounded', async () => {
    const bridgeCallSource = await readSource('./bridgeCallSource.ts');
    expect.soft(bridgeCallSource, 'broker bridge fetch must attach a bounded AbortSignal').toMatch(
      /const BRIDGE_FETCH_TIMEOUT_MS = \d[\d_]*;[\s\S]*AbortSignal\.timeout\(BRIDGE_FETCH_TIMEOUT_MS\)[\s\S]*fetch\("http:\/\/127\.0\.0\.1:"[\s\S]*\.\.\.bridgeAbort/u,
    );
  });

  it('rejects new unbounded external waits anywhere in broker production code', async () => {
    const files = await listProductionSources(BROKER_ROOT);
    expect(files.length).toBeGreaterThan(3);

    const violations: string[] = [];
    for (const file of files) {
      const source = blankComments(await readFile(file, 'utf8'));
      const relPath = relative(BROKER_ROOT, file);

      // Synchronous child processes block the runtime outright.
      if (/\bspawnSync\s*\(|\bexecFileSync\s*\(|\bexecSync\s*\(/u.test(source)) {
        violations.push(`${relPath}: synchronous child_process call — use the bounded async spawn pattern`);
      }

      // Every fetch (including the stringified runtime-source fetch) must carry an abort/timeout budget.
      const fetchPattern = /(?<![.\w])fetch\s*\(/gu;
      for (const match of source.matchAll(fetchPattern)) {
        const index = match.index ?? 0;
        const context = windowAround(source, index, 4, 14);
        const bounded = /signal|abort|timeout/iu.test(context);
        const allowlisted = BOUNDED_CALL_ALLOWLIST.some(
          (entry) => relPath.endsWith(entry.file) && context.includes(entry.marker),
        );
        if (!bounded && !allowlisted) {
          violations.push(`${relPath}: fetch() without an abort/timeout budget in its statement window`);
        }
      }

      // Every async child_process spawn must have kill-on-timeout handling nearby.
      const spawnPattern = /(?<![.\w])spawn\s*\(/gu;
      for (const match of source.matchAll(spawnPattern)) {
        const index = match.index ?? 0;
        const context = windowAround(source, index, 10, 30);
        const bounded = /timeout|SIGTERM|SIGKILL|\.kill\(/iu.test(context);
        const allowlisted = BOUNDED_CALL_ALLOWLIST.some(
          (entry) => relPath.endsWith(entry.file) && context.includes(entry.marker),
        );
        if (!bounded && !allowlisted) {
          violations.push(`${relPath}: spawn() without kill-on-timeout handling in its window`);
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
