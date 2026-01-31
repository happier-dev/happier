import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTriageMarkdown, parseCodeRabbitPlainOutput, parseCodexReviewText } from './findings.mjs';

test('parseCodeRabbitPlainOutput parses CodeRabbit plain blocks', () => {
  const out = [
    '============================================================================',
    'File: packages/cli/src/utils/spawnHappyCLI.invocation.test.ts',
    'Line: 17 to 31',
    'Type: potential_issue',
    '',
    'Comment:',
    'Dynamic imports may be cached, causing test isolation issues.',
    '',
    'Some more details.',
    '',
    'Prompt for AI Agent:',
    'Do the thing.',
    '',
    '============================================================================',
    'File: packages/app/sources/app/(app)/_layout.tsx',
    'Line: 29 to 35',
    'Type: potential_issue',
    '',
    'Comment:',
    "Hooks order violation: useUnistyles() called after conditional return.",
    '',
    'More details.',
  ].join('\n');

  const findings = parseCodeRabbitPlainOutput(out);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, 'packages/cli/src/utils/spawnHappyCLI.invocation.test.ts');
  assert.deepEqual(findings[0].lines, { start: 17, end: 31 });
  assert.equal(findings[0].type, 'potential_issue');
  assert.equal(findings[0].title, 'Dynamic imports may be cached, causing test isolation issues.');
  assert.match(findings[0].comment, /Some more details/);
  assert.match(findings[0].prompt, /Do the thing/);
});

test('parseCodexReviewText extracts findings JSON trailer', () => {
  const review = [
    'Overall verdict: looks good.',
    '',
    '===FINDINGS_JSON===',
    JSON.stringify(
      [
        {
          severity: 'major',
          file: 'packages/server/sources/main.light.ts',
          title: 'Do not exit after startup',
          recommendation: 'Remove process.exit(0) on success.',
        },
      ],
      null,
      2
    ),
  ].join('\n');

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'packages/server/sources/main.light.ts');
  assert.equal(findings[0].severity, 'major');
});

test('parseCodexReviewText extracts findings JSON trailer even when fenced', () => {
  const review = [
    'All good.',
    '',
    '===FINDINGS_JSON===',
    '```json',
    JSON.stringify(
      [
        {
          severity: 'minor',
          file: 'cli/src/foo.ts',
          title: 'Prefer explicit return type',
          recommendation: 'Add an explicit return type for clarity.',
        },
      ],
      null,
      2
    ),
    '```',
  ].join('\n');

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'cli/src/foo.ts');
  assert.equal(findings[0].severity, 'minor');
});

test('parseCodexReviewText extracts findings JSON trailer when lines are log-prefixed', () => {
  const label = '[monorepo:augment:4/39] ';
  const review = [
    `${label}some preamble`,
    `${label}===FINDINGS_JSON===`,
    `${label}\`\`\`json`,
    `${label}[`,
    `${label}  {`,
    `${label}    \"severity\": \"major\",`,
    `${label}    \"file\": \"cli/src/x.ts\",`,
    `${label}    \"title\": \"Fix thing\",`,
    `${label}    \"recommendation\": \"Do it.\",`,
    `${label}    \"needsDiscussion\": false`,
    `${label}  }`,
    `${label}]`,
    `${label}\`\`\``,
    `${label}`,
    `${label}Request ID: abc`,
  ].join('\n');

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'cli/src/x.ts');
  assert.equal(findings[0].severity, 'major');
});

test('parseCodexReviewText falls back to parsing [P#] bullet lines', () => {
  const review = [
    '[monorepo:codex:2/21] Review comment:',
    '[monorepo:codex:2/21] - [P1] Fix thing one — /Users/me/repo/.project/review-worktrees/codex-2-of-21-abc/packages/cli/src/foo.ts:10-12',
    '[monorepo:codex:2/21] - [P3] Fix thing two — /Users/me/repo/.project/review-worktrees/codex-2-of-21-abc/packages/app/sources/bar.tsx:7',
  ].join('\n');

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, 'packages/cli/src/foo.ts');
  assert.deepEqual(findings[0].lines, { start: 10, end: 12 });
  assert.equal(findings[0].severity, 'blocker');
  assert.equal(findings[0].title, 'Fix thing one');
  assert.equal(findings[1].file, 'packages/app/sources/bar.tsx');
  assert.deepEqual(findings[1].lines, { start: 7, end: 7 });
  assert.equal(findings[1].severity, 'minor');
  assert.equal(findings[1].title, 'Fix thing two');
});

test('parseCodexReviewText falls back when marker exists but JSON is missing/invalid', () => {
  const review = [
    'instructions...',
    '===FINDINGS_JSON===',
    'this is not json',
    '[monorepo:codex:2/21] - [P2] Fix thing — /Users/me/repo/.project/review-worktrees/codex-2-of-21-abc/packages/server/src/x.ts:1-2',
  ].join('\n');

  const findings = parseCodexReviewText(review);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'packages/server/src/x.ts');
  assert.deepEqual(findings[0].lines, { start: 1, end: 2 });
  assert.equal(findings[0].severity, 'major');
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
