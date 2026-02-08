import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTriageMarkdown, parseCodeRabbitPlainOutput, parseCodexReviewText } from './findings.mjs';

function joinLines(lines) {
  return lines.join('\n');
}

function makeCodeRabbitBlock({ file, line, type, commentLines = [], promptLines = [] }) {
  const lines = [
    '============================================================================',
    `File: ${file}`,
    `Line: ${line}`,
    `Type: ${type}`,
    '',
    'Comment:',
    ...commentLines,
  ];
  if (promptLines.length) {
    lines.push('', 'Prompt for AI Agent:', ...promptLines);
  }
  return lines;
}

function makeCodexFindingsJsonBlock(findings, { fenced = false } = {}) {
  const json = JSON.stringify(findings, null, 2);
  if (!fenced) return ['===FINDINGS_JSON===', json];
  return ['===FINDINGS_JSON===', '```json', json, '```'];
}

function withLabelPrefix(lines, label) {
  return lines.map((line) => `${label}${line}`);
}

test('parseCodeRabbitPlainOutput parses CodeRabbit plain blocks', () => {
  const out = joinLines([
    ...makeCodeRabbitBlock({
      file: 'apps/cli/src/utils/spawnHappyCLI.invocation.test.ts',
      line: '17 to 31',
      type: 'potential_issue',
      commentLines: ['Dynamic imports may be cached, causing test isolation issues.', '', 'Some more details.'],
      promptLines: ['Do the thing.'],
    }),
    ...makeCodeRabbitBlock({
      file: 'apps/ui/sources/app/(app)/_layout.tsx',
      line: '29 to 35',
      type: 'potential_issue',
      commentLines: ['Hooks order violation: useUnistyles() called after conditional return.', '', 'More details.'],
    }),
  ]);

  const findings = parseCodeRabbitPlainOutput(out);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, 'apps/cli/src/utils/spawnHappyCLI.invocation.test.ts');
  assert.deepEqual(findings[0].lines, { start: 17, end: 31 });
  assert.equal(findings[0].type, 'potential_issue');
  assert.equal(findings[0].title, 'Dynamic imports may be cached, causing test isolation issues.');
  assert.match(findings[0].comment, /Some more details/);
  assert.match(findings[0].prompt, /Do the thing/);
});

test('parseCodeRabbitPlainOutput supports log-prefixed lines and single-line range', () => {
  const label = '[monorepo:coderabbit:1/3] ';
  const out = joinLines(
    withLabelPrefix(
      makeCodeRabbitBlock({
        file: 'apps/stack/scripts/review.mjs',
        line: '42',
        type: 'nit',
        commentLines: ['Prefer a clearer constant name.'],
      }),
      label
    )
  );

  const findings = parseCodeRabbitPlainOutput(out);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'apps/stack/scripts/review.mjs');
  assert.deepEqual(findings[0].lines, { start: 42, end: 42 });
  assert.equal(findings[0].type, 'nit');
  assert.equal(findings[0].title, 'Prefer a clearer constant name.');
});

test('parseCodexReviewText extracts findings JSON trailer', () => {
  const review = joinLines([
    'Overall verdict: looks good.',
    '',
    ...makeCodexFindingsJsonBlock([
      {
        severity: 'major',
        file: 'apps/server/sources/main.light.ts',
        title: 'Do not exit after startup',
        recommendation: 'Remove process.exit(0) on success.',
      },
    ]),
  ]);

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'apps/server/sources/main.light.ts');
  assert.equal(findings[0].severity, 'major');
});

test('parseCodexReviewText extracts findings JSON trailer even when fenced', () => {
  const review = joinLines(['All good.', '', ...makeCodexFindingsJsonBlock([
    {
      severity: 'minor',
      file: 'cli/src/foo.ts',
      title: 'Prefer explicit return type',
      recommendation: 'Add an explicit return type for clarity.',
    },
  ], { fenced: true })]);

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'cli/src/foo.ts');
  assert.equal(findings[0].severity, 'minor');
});

test('parseCodexReviewText extracts findings JSON trailer when lines are log-prefixed', () => {
  const label = '[monorepo:augment:4/39] ';
  const prefixed = withLabelPrefix(
    makeCodexFindingsJsonBlock(
      [
        {
          severity: 'major',
          file: 'cli/src/x.ts',
          title: 'Fix thing',
          recommendation: 'Do it.',
          needsDiscussion: false,
        },
      ],
      { fenced: true }
    ).concat(['', 'Request ID: abc']),
    label
  );
  const review = joinLines([`${label}some preamble`, ...prefixed]);

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'cli/src/x.ts');
  assert.equal(findings[0].severity, 'major');
});

test('parseCodexReviewText falls back to parsing [P#] bullet lines', () => {
  const review = joinLines([
    '[monorepo:codex:2/21] Review comment:',
    '[monorepo:codex:2/21] - [P1] Fix thing one — /Users/me/repo/.project/review-worktrees/codex-2-of-21-abc/apps/cli/src/foo.ts:10-12',
    '[monorepo:codex:2/21] - [P3] Fix thing two — /Users/me/repo/.project/review-worktrees/codex-2-of-21-abc/apps/ui/sources/bar.tsx:7',
  ]);

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, 'apps/cli/src/foo.ts');
  assert.deepEqual(findings[0].lines, { start: 10, end: 12 });
  assert.equal(findings[0].severity, 'blocker');
  assert.equal(findings[0].title, 'Fix thing one');
  assert.equal(findings[1].file, 'apps/ui/sources/bar.tsx');
  assert.deepEqual(findings[1].lines, { start: 7, end: 7 });
  assert.equal(findings[1].severity, 'minor');
  assert.equal(findings[1].title, 'Fix thing two');
});

test('parseCodexReviewText falls back when marker exists but JSON is missing/invalid', () => {
  const review = joinLines([
    'instructions...',
    '===FINDINGS_JSON===',
    'this is not json',
    '[monorepo:codex:2/21] - [P2] Fix thing — /Users/me/repo/.project/review-worktrees/codex-2-of-21-abc/apps/server/src/x.ts:1-2',
  ]);

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'apps/server/src/x.ts');
  assert.deepEqual(findings[0].lines, { start: 1, end: 2 });
  assert.equal(findings[0].severity, 'major');
});

test('parseCodexReviewText returns empty list when no findings marker/bullets exist', () => {
  const findings = parseCodexReviewText('No actionable findings.');
  assert.deepEqual(findings, []);
});

test('formatTriageMarkdown includes required workflow fields', () => {
  const md = formatTriageMarkdown({
    runLabel: 'review-123',
    baseRef: 'upstream/main',
    findings: [
      {
        reviewer: 'coderabbit',
        id: 'CR-001',
        file: 'cli/src/x.ts',
        title: 'Thing',
        type: 'potential_issue',
      },
    ],
  });
  assert.match(md, /Trust checklist/i);
  assert.match(md, /Final decision: \*\*TBD\*\*/);
  assert.match(md, /Verified in validation worktree:/);
  assert.match(md, /Commit:/);
});
