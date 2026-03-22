import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createReviewCommandFixture,
  findSingleReviewerResult,
  parseJsonStdout,
  runHstackForReview,
} from './testkit/review_command_testkit.mjs';

test('review --type=uncommitted routes codex to --uncommitted in normal depth', async (t) => {
  const { baseSha, env, label } = await createReviewCommandFixture(t, {
    labelPrefix: 'test-uncommitted-codex-normal',
  });

  const res = runHstackForReview({
    env,
    args: [
      'tools',
      'review',
      'cli',
      '--reviewers=codex',
      '--depth=normal',
      `--base-ref=${baseSha}`,
      '--type=uncommitted',
      `--run-label=${label}`,
      '--json',
    ],
  });
  const out = parseJsonStdout(res);
  const rr = findSingleReviewerResult(out, 'codex');
  const args = JSON.parse(String(rr.stdout ?? '').trim());
  assert.ok(args.includes('--uncommitted'));
  assert.ok(!args.includes('--base'));
});

test('review --type=uncommitted uses git diff HEAD in deep prompt mode for codex', async (t) => {
  const { baseSha, env, label } = await createReviewCommandFixture(t, {
    labelPrefix: 'test-uncommitted-codex-deep',
  });

  const res = runHstackForReview({
    env,
    args: [
      'tools',
      'review',
      'cli',
      '--reviewers=codex',
      '--depth=deep',
      `--base-ref=${baseSha}`,
      '--type=uncommitted',
      `--run-label=${label}`,
      '--json',
    ],
  });
  const out = parseJsonStdout(res);
  const rr = findSingleReviewerResult(out, 'codex');
  const args = JSON.parse(String(rr.stdout ?? '').trim());
  assert.ok(!args.includes('--uncommitted'));
  assert.ok(args.some((a) => String(a).includes('git diff HEAD')));
});

test('review --type=uncommitted routes coderabbit to --type uncommitted without base', async (t) => {
  const { baseSha, env, label } = await createReviewCommandFixture(t, {
    labelPrefix: 'test-uncommitted-coderabbit',
  });

  const res = runHstackForReview({
    env,
    args: [
      'tools',
      'review',
      'cli',
      '--reviewers=coderabbit',
      `--base-ref=${baseSha}`,
      '--type=uncommitted',
      `--run-label=${label}`,
      '--json',
    ],
  });
  const out = parseJsonStdout(res);
  const rr = findSingleReviewerResult(out, 'coderabbit');
  const args = JSON.parse(String(rr.stdout ?? '').trim());
  const idx = args.indexOf('--type');
  assert.ok(idx >= 0, '[test] expected coderabbit --type flag');
  assert.equal(args[idx + 1], 'uncommitted');
  assert.ok(!args.includes('--base'));
  assert.ok(!args.includes('--base-commit'));
});

test('review --type=uncommitted uses git diff HEAD in augment prompt', async (t) => {
  const { baseSha, env, label } = await createReviewCommandFixture(t, {
    labelPrefix: 'test-uncommitted-augment',
  });

  const res = runHstackForReview({
    env,
    args: [
      'tools',
      'review',
      'cli',
      '--reviewers=augment',
      '--depth=deep',
      `--base-ref=${baseSha}`,
      '--type=uncommitted',
      `--run-label=${label}`,
      '--json',
    ],
  });
  const out = parseJsonStdout(res);
  const rr = findSingleReviewerResult(out, 'augment');
  const args = JSON.parse(String(rr.stdout ?? '').trim());
  assert.ok(args.some((a) => String(a).includes('git diff HEAD')));
});
