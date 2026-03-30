import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { buildStackFixtureEnv } from '../../scripts/testkit/core/env_scope.mjs';
import { buildStackHarnessEnv, writeFakeBin } from '../../scripts/testkit/core/fake_bin_harness.mjs';
import { runCommandCaptureSync } from '../../scripts/testkit/core/run_node_capture.mjs';
import { ensureMinimalMonorepoLayout } from '../../scripts/testkit/core/minimal_monorepo_layout.mjs';
import { resolveHstackBinPath, resolveStackRootFromMeta } from '../../scripts/testkit/core/stack_root.mjs';
import { createTempFixture } from '../../scripts/testkit/core/temp_fixture.mjs';

const stackRoot = resolveStackRootFromMeta(import.meta.url);
const repoRoot = resolve(stackRoot, '..', '..');
const hstackBin = resolveHstackBinPath(stackRoot);

let runLabelCounter = 0;

function runOrThrow(command, args, { cwd, env } = {}) {
  const res = runCommandCaptureSync(command, args, { cwd, env });
  if (res.status !== 0) {
    const msg = [
      `[test] command failed: ${command} ${args.join(' ')}`,
      res.stdout ? `--- stdout ---\n${res.stdout}` : '',
      res.stderr ? `--- stderr ---\n${res.stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(msg);
  }
  return res;
}

function createRunLabel(prefix) {
  runLabelCounter += 1;
  return `${prefix}-${Date.now()}-${runLabelCounter}`;
}

async function writeReviewerStub(root, name) {
  writeFakeBin({
    root,
    name,
    content: `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");
`,
  });
}

async function writeReviewerStubs(root, reviewers = ['codex', 'coderabbit', 'auggie']) {
  for (const reviewer of reviewers) {
    await writeReviewerStub(root, reviewer);
  }
}

async function initReviewRepo(dir) {
  runOrThrow('git', ['init', '-b', 'main'], { cwd: dir });
  runOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  runOrThrow('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await ensureMinimalMonorepoLayout(dir);
}

async function seedReviewRepoWithCommittedAndUncommittedChanges(dir) {
  await writeFile(join(dir, 'a.txt'), 'base\n', 'utf8');
  runOrThrow('git', ['add', '.'], { cwd: dir });
  runOrThrow('git', ['commit', '-m', 'base'], { cwd: dir });
  const baseSha = String(runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout ?? '').trim();

  await writeFile(join(dir, 'a.txt'), 'committed\n', 'utf8');
  runOrThrow('git', ['add', '.'], { cwd: dir });
  runOrThrow('git', ['commit', '-m', 'committed change'], { cwd: dir });

  await writeFile(join(dir, 'a.txt'), 'uncommitted\n', 'utf8');
  await writeFile(join(dir, 'new.txt'), 'untracked\n', 'utf8');

  return { baseSha };
}

export async function createReviewCommandFixture(
  t,
  {
    labelPrefix,
    reviewers = ['codex', 'coderabbit', 'auggie'],
    seedUncommittedChanges = true,
  }
) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-review-command-' });
  const repoDir = fixture.path('repo');
  const homeDir = fixture.path('home');

  await mkdir(repoDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeReviewerStubs(fixture.root, reviewers);
  await initReviewRepo(repoDir);

  const baseSha = seedUncommittedChanges
    ? (await seedReviewRepoWithCommittedAndUncommittedChanges(repoDir)).baseSha
    : null;

  const env = buildStackHarnessEnv({
    baseEnv: buildStackFixtureEnv({
      extraEnv: {
        HOME: homeDir,
        HAPPIER_STACK_REPO_DIR: repoDir,
        HAPPIER_STACK_UPDATE_CHECK: '0',
        HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
        HAPPIER_STACK_CODERABBIT_HOME_DIR: join(homeDir, 'coderabbit'),
        HAPPIER_STACK_CODEX_HOME_DIR: join(homeDir, 'codex'),
        HAPPIER_STACK_AUGMENT_CACHE_DIR: join(homeDir, 'augment'),
      },
    }),
    binDirs: [join(fixture.root, 'bin')],
  });

  return {
    ...fixture,
    repoRoot,
    repoDir,
    homeDir,
    baseSha,
    env,
    label: createRunLabel(labelPrefix),
  };
}

export function runHstackForReview({ args, env }) {
  return runCommandCaptureSync(process.execPath, [hstackBin, ...args], {
    cwd: repoRoot,
    env,
  });
}

export function parseJsonStdout(res) {
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return JSON.parse(String(res.stdout ?? '').trim());
}

export function findSingleReviewerResult(out, reviewer) {
  const job = out?.results?.[0];
  assert.ok(job, '[test] expected one job result');
  const reviewerResult = Array.isArray(job.results) ? job.results.find((entry) => entry.reviewer === reviewer) : null;
  assert.ok(reviewerResult, `[test] missing reviewer result: ${reviewer}`);
  return reviewerResult;
}
