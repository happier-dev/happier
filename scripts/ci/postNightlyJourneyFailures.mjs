import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { attributeBreakLane } from '../../apps/stack/scripts/perf/break-attribution.mjs';
import { ARCHIVED_BOARD_PATH, BOARD_PATH } from '../board/postBoardEntry.mjs';

// Posts the failing files of the latest nightly v0.3 journey run (tests-dispatch.yml on v0.3,
// dispatched by the default branch's schedule) to the board: one ASK per owning lane, attributed
// by the load sentinel's owner (board post naming the file's last commit). Run once after the
// nightly finishes: node scripts/ci/postNightlyJourneyFailures.mjs [--run <id>] [--dry-run]

const SENDER = 'NIGHTLY-JOURNEYS';
const FALLBACK_LANE = 'P03 ORCH';

const FILE_PATTERN = /(?:FAIL|❯|\d+\) \[[\w-]+\] ›)\s+(suites\/(?:core-e2e|ui-e2e|contracts|core-layer|runtime-unification)\/[\w./-]+?\.(?:test|spec)\.ts)/gu;

/** Failing journey files from a `gh run view --log-failed` text, repo-relative and sorted. */
export function parseFailingJourneyFiles(log) {
  const files = new Set();
  for (const line of String(log).split('\n')) {
    for (const match of line.matchAll(FILE_PATTERN)) files.add(`packages/tests/${match[1]}`);
  }
  return [...files].sort();
}

export function formatNightlyPosts({ at, runUrl, attributions, fallbackLane = FALLBACK_LANE }) {
  const stamp = at.toISOString().replace('T', ' ').slice(0, 16);
  const byLane = new Map();
  for (const item of attributions) {
    const lane = item.lane ?? fallbackLane;
    byLane.set(lane, [...(byLane.get(lane) ?? []), item]);
  }
  return [...byLane].map(([lane, items]) => [
    `### ${stamp} UTC — ${SENDER} → ${lane} — ASK — ${items.length} nightly v0.3 journey failure${items.length === 1 ? '' : 's'} in files your lane last changed`,
    '',
    `Run: ${runUrl}. Sort each as stale test, real defect or environment, and fix at the owner (QA lanes fix what they find).`,
    ...items.map((item) => `- \`${item.file}\`${item.basis ? ` (${item.basis})` : ' (no board post names its last commit)'}`),
    '',
  ].join('\n'));
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 << 20 });
}

async function main(argv) {
  const repoDir = process.cwd();
  const runIndex = argv.indexOf('--run');
  const runId = runIndex >= 0 ? argv[runIndex + 1] : JSON.parse(gh([
    'run', 'list', '--workflow', 'tests-dispatch.yml', '--branch', 'v0.3', '--event', 'workflow_dispatch',
    '--status', 'completed', '--limit', '1', '--json', 'databaseId',
  ]))[0]?.databaseId;
  if (!runId) throw new Error('No completed nightly v0.3 tests-dispatch run found.');
  const run = JSON.parse(gh(['run', 'view', String(runId), '--json', 'conclusion,url']));
  if (run.conclusion === 'success') {
    process.stdout.write(`Nightly run ${runId} passed; nothing to post.\n`);
    return;
  }
  const files = parseFailingJourneyFiles(gh(['run', 'view', String(runId), '--log-failed']));
  if (files.length === 0) {
    process.stdout.write(`Nightly run ${runId} failed without a failing journey file (setup or environment): ${run.url}\n`);
    return;
  }
  const attributions = [];
  for (const file of files) {
    let mtimeMs = 0;
    try { mtimeMs = statSync(resolve(repoDir, file)).mtimeMs; } catch { /* deleted since the run: attribute by history */ }
    let owner = null;
    // Commits posted before 2026-11-18 are named on the archived handoff board.
    for (const board of [BOARD_PATH, ARCHIVED_BOARD_PATH]) {
      owner = await attributeBreakLane({ repoDir, board: resolve(repoDir, board), files: [{ path: file, mtimeMs }], module: file });
      if (owner) break;
    }
    attributions.push({ file, lane: owner?.lane ?? null, basis: owner?.basis ?? null });
  }
  const posts = formatNightlyPosts({ at: new Date(), runUrl: run.url, attributions });
  if (argv.includes('--dry-run')) {
    process.stdout.write(`${posts.join('\n')}\n`);
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'nightly-journeys-'));
  try {
    for (const [index, post] of posts.entries()) {
      const entry = join(scratch, `post-${index}.md`);
      writeFileSync(entry, `${post}\n`);
      execFileSync('node', ['scripts/board/postBoardEntry.mjs', BOARD_PATH, entry], { cwd: repoDir, stdio: 'inherit' });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
