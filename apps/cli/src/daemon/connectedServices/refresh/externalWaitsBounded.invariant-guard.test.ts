import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * RR-7b: a hung daemon or provider endpoint must never hang connected-services work forever. Every
 * external wait (network fetch, child-process spawn) in connected-services PRODUCTION code MUST carry
 * an abort/timeout budget. The second test is the NEGATIVE property scan: it FAILS when anyone adds a
 * NEW unbounded external wait anywhere under the CS root — the positive pin only locks a known leaf.
 *
 * dev routes OAuth refreshes through the `runtimeFetch` abstraction (bounded via `signal`); runtime-auth
 * bridge-call source that emits a raw stringified `fetch` lives in `@happier-dev/plugin-sdk` and is
 * guarded by its own boundedness invariant test.
 */

const CLI_SRC_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CS_ROOT = join(CLI_SRC_ROOT, 'daemon/connectedServices');

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

describe('connected service external wait boundedness invariant guard (RR-7b)', () => {
  it('keeps the OAuth refresh fetch bounded', async () => {
    const serviceRefreshers = await readSource('./serviceRefreshers.ts');
    expect.soft(serviceRefreshers, 'OAuth token refresh must pass a bounded AbortSignal to runtimeFetch').toMatch(
      /const CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS = \d[\d_]*;[\s\S]*signal: AbortSignal\.timeout\(CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS\)/u,
    );
  });

  it('rejects new unbounded external waits anywhere in connected-services production code', async () => {
    const files = await listProductionSources(CS_ROOT);
    expect(files.length).toBeGreaterThan(20);

    const violations: string[] = [];
    for (const file of files) {
      const source = blankComments(await readFile(file, 'utf8'));
      const relPath = relative(CLI_SRC_ROOT, file);

      // Synchronous child processes block the daemon outright.
      if (/\bspawnSync\s*\(|\bexecFileSync\s*\(|\bexecSync\s*\(/u.test(source)) {
        violations.push(`${relPath}: synchronous child_process call — use the bounded async spawn pattern`);
      }

      // Every raw fetch must carry an abort/timeout budget near the call. (runtimeFetch is a bounded
      // abstraction and does not match this lowercase-`fetch(` probe.)
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
