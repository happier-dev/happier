#!/usr/bin/env node

// @ts-check

// Reports 0.2 (`dev`) release/deploy pipeline commits that 0.3 has not dispositioned yet.
// docs/release-port-ledger.md is the disposition record; this report never fails a build.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RELEASE_PIPELINE_PATHS = [
  '.github',
  'scripts/pipeline',
  'scripts/release',
  'docker',
  'Dockerfile',
];
const DISPOSITIONS = new Set(['ported', 'different', 'n.a.', 'missing']);

function parseLedger(raw) {
  const sync = /<!--\s*release-port-sync:\s*([0-9a-f]{7,40})\s*-->/.exec(
    raw,
  )?.[1];
  if (!sync)
    throw new Error(
      '[release-port] ledger has no release-port-sync sync point',
    );
  const rows = [];
  for (const line of raw.split('\n')) {
    const cells = /^\|\s*([0-9a-f]{7,40})\s*\|(.*)\|\s*$/.exec(line);
    if (!cells) continue;
    const [, subject = '', disposition = '', note = ''] = cells[2]
      .split('|')
      .map((cell) => cell.trim());
    const kind = disposition.split(/\s+/)[0];
    if (!DISPOSITIONS.has(kind))
      throw new Error(
        `[release-port] ${cells[1]} has unknown disposition "${disposition}"`,
      );
    rows.push({ sha: cells[1], subject, disposition, kind, note });
  }
  return { sync, rows };
}

export function reportReleasePortGaps({
  ledgerPath,
  repoDir = process.cwd(),
  upstreamRef = 'origin/dev',
}) {
  const { sync, rows } = parseLedger(readFileSync(ledgerPath, 'utf8'));
  const log = execFileSync(
    'git',
    [
      'log',
      '--format=%H%x09%ad%x09%s',
      '--date=short',
      `${sync}..${upstreamRef}`,
      '--',
      ...RELEASE_PIPELINE_PATHS,
    ],
    {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const unrecorded = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, subject] = line.split('\t');
      return { sha, date, subject };
    })
    .filter(({ sha }) => !rows.some((row) => sha.startsWith(row.sha)));
  const missing = rows.filter((row) => row.kind === 'missing');
  const markdown = [
    '## 0.2 → 0.3 release pipeline port',
    '',
    `${unrecorded.length} upstream commits have no recorded 0.3 disposition (since ${sync}, ${upstreamRef}); ${missing.length} recorded as missing.`,
    'Record each in docs/release-port-ledger.md as ported <0.3 sha>, different <reason>, n.a. <reason> or missing <note>.',
    '',
    ...unrecorded.map(
      ({ sha, date, subject }) => `- ${sha.slice(0, 11)} ${date} ${subject}`,
    ),
    '',
  ].join('\n');
  return { sync, unrecorded, missing, markdown };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [
    ledgerPath = 'docs/release-port-ledger.md',
    upstreamRef = 'origin/dev',
  ] = process.argv.slice(2);
  const { markdown } = reportReleasePortGaps({ ledgerPath, upstreamRef });
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}
