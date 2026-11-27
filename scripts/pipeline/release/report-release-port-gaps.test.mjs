import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { reportReleasePortGaps } from './report-release-port-gaps.mjs';

function repoWithHistory(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'release-port-gaps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'a',
        GIT_AUTHOR_EMAIL: 'a@a',
        GIT_COMMITTER_NAME: 'a',
        GIT_COMMITTER_EMAIL: 'a@a',
      },
    }).trim();
  git('init', '-q', '-b', 'dev');
  const commit = (file, subject) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), subject);
    git('add', '--', file);
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  return { dir, commit };
}

function ledger(sync, rows) {
  return [
    '# Release port ledger',
    '',
    `<!-- release-port-sync: ${sync.slice(0, 11)} -->`,
    '',
    '| 0.2 commit | date | subject | disposition | note |',
    '|---|---|---|---|---|',
    ...rows.map(
      ([sha, disposition, note]) =>
        `| ${sha.slice(0, 11)} | 2026-11-27 | subject | ${disposition} | ${note} |`,
    ),
    '',
  ].join('\n');
}

test('reports pipeline commits after the sync point with no disposition, and dispositions still missing', (t) => {
  const { dir, commit } = repoWithHistory(t);
  const sync = commit('.github/workflows/a.yml', 'ci: before sync');
  const ported = commit('Dockerfile', 'fix(docker): ported');
  const missing = commit('scripts/release/x.mjs', 'fix(release): known gap');
  commit('apps/ui/app.ts', 'feat(ui): outside the pipeline paths');
  const unrecorded = commit(
    'scripts/pipeline/y.mjs',
    'fix(release): new upstream change',
  );
  const unrecordedDocker = commit(
    'docker/entry.sh',
    'fix(docker): new docker change',
  );
  const ledgerPath = path.join(dir, 'ledger.md');
  writeFileSync(
    ledgerPath,
    ledger(sync, [
      [ported, 'ported', '0123456789a'],
      [missing, 'missing', 'needs the desktop gate'],
    ]),
  );

  const report = reportReleasePortGaps({
    ledgerPath,
    repoDir: dir,
    upstreamRef: 'dev',
  });

  assert.deepEqual(
    report.unrecorded.map((entry) => entry.sha),
    [unrecordedDocker, unrecorded],
  );
  assert.deepEqual(
    report.missing.map((entry) => entry.sha),
    [missing.slice(0, 11)],
  );
  assert.match(
    report.markdown,
    /2 upstream commits have no recorded 0\.3 disposition/,
  );
  assert.match(report.markdown, /new upstream change/);
  assert.match(report.markdown, /1 recorded as missing/);
});

test('rejects a ledger without a sync point or with an unknown disposition', (t) => {
  const { dir, commit } = repoWithHistory(t);
  const sync = commit('Dockerfile', 'base');
  const ledgerPath = path.join(dir, 'ledger.md');

  writeFileSync(ledgerPath, ledger(sync, []).replace(/<!--.*-->/, ''));
  assert.throws(
    () =>
      reportReleasePortGaps({ ledgerPath, repoDir: dir, upstreamRef: 'dev' }),
    /sync point/,
  );

  writeFileSync(ledgerPath, ledger(sync, [[sync, 'maybe', '']]));
  assert.throws(
    () =>
      reportReleasePortGaps({ ledgerPath, repoDir: dir, upstreamRef: 'dev' }),
    /disposition/,
  );
});
