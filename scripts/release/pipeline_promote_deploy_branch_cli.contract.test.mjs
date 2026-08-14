import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function writeGhStub(tmpDir) {
  const binDir = resolve(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const stubPath = resolve(binDir, 'gh');
  fs.writeFileSync(
    stubPath,
    `#!/usr/bin/env node
import fs from 'node:fs';

const callsPath = process.env.GH_STUB_CALLS;
const args = process.argv.slice(2);
if (callsPath) fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n');
const methodIndex = args.indexOf('-X');
const method = methodIndex >= 0 ? args[methodIndex + 1] : 'GET';
if (method === 'PATCH') {
  const outcome = process.env.GH_STUB_PATCH_OUTCOME ?? 'success';
  if (outcome === '404') {
    process.stderr.write('gh: Not Found (HTTP 404)\\n');
    process.exit(1);
  }
  if (outcome === '500') {
    process.stderr.write('gh: Internal Server Error (HTTP 500)\\n');
    process.exit(1);
  }
}
if (method === 'POST') process.stdout.write('{}\\n');
else process.stdout.write('{"object":{"sha":"old-sha"}}\\n');
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  return binDir;
}

function readGhCalls(callsPath) {
  return fs
    .readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runPromotionWithStub(tmpDir, patchOutcome) {
  const callsPath = resolve(tmpDir, 'gh-calls.jsonl');
  const binDir = writeGhStub(tmpDir);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    GH_REPO: 'test/test',
    GITHUB_REPOSITORY: 'test/test',
    GH_STUB_CALLS: callsPath,
    GH_STUB_PATCH_OUTCOME: patchOutcome,
  };
  const args = [
    resolve(repoRoot, 'scripts', 'pipeline', 'github', 'promote-deploy-branch.mjs'),
    '--deploy-environment',
    'production',
    '--component',
    'server',
    '--sha',
    '0123456789abcdef0123456789abcdef01234567',
  ];
  let error;
  try {
    execFileSync(process.execPath, args, {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (caught) {
    error = caught;
  }
  return { calls: readGhCalls(callsPath), error };
}

test('pipeline CLI can promote deploy branch in dry-run', async () => {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-promote-deploy-branch-'));
  const summaryPath = resolve(tmpDir, 'summary.md');

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'promote-deploy-branch',
      '--deploy-environment',
      'production',
      '--component',
      'server',
      '--source-ref',
      'dev',
      '--summary-file',
      summaryPath,
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GH_TOKEN: '', GH_REPO: '', GITHUB_REPOSITORY: '' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] promote deploy branch: deploy\/production\/server <= dev/);
  assert.match(out, /\[dry-run\] gh api /);
  assert.match(out, /deploy%2Fproduction%2Fserver/, 'gh api ref path must URL-encode deploy branch slashes');
  assert.match(out, /-F force=true/, 'gh api PATCH should send boolean force with --field (typed)');
  assert.match(out, /-X PATCH/, 'dry-run should print the intended PATCH update call');

  const summary = fs.readFileSync(summaryPath, 'utf8');
  assert.match(summary, /^## Promote deploy branch/m);
  assert.match(summary, /target: `deploy\/production\/server`/);
});

test('promote deploy branch sends one PATCH and no POST when the ref exists', () => {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-promote-existing-'));
  const { calls, error } = runPromotionWithStub(tmpDir, 'success');
  assert.equal(error, undefined);
  const patchCalls = calls.filter((args) => args.includes('PATCH'));
  const postCalls = calls.filter((args) => args.includes('POST'));
  assert.equal(patchCalls.length, 1, `expected one PATCH, got ${JSON.stringify(calls)}`);
  assert.equal(postCalls.length, 0, `unexpected POST: ${JSON.stringify(calls)}`);
});

test('promote deploy branch creates the ref only after an explicit PATCH 404', () => {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-promote-missing-'));
  const { calls, error } = runPromotionWithStub(tmpDir, '404');
  assert.equal(error, undefined);
  const patchCalls = calls.filter((args) => args.includes('PATCH'));
  const postCalls = calls.filter((args) => args.includes('POST'));
  assert.equal(patchCalls.length, 1, `expected one PATCH, got ${JSON.stringify(calls)}`);
  assert.equal(postCalls.length, 1, `expected one POST, got ${JSON.stringify(calls)}`);
});

test('promote deploy branch does not create a ref for non-404 PATCH failures', () => {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), 'happier-promote-failure-'));
  const { calls, error } = runPromotionWithStub(tmpDir, '500');
  assert.notEqual(error, undefined);
  const patchCalls = calls.filter((args) => args.includes('PATCH'));
  const postCalls = calls.filter((args) => args.includes('POST'));
  assert.equal(patchCalls.length, 1, `expected one PATCH, got ${JSON.stringify(calls)}`);
  assert.equal(postCalls.length, 0, `unexpected POST: ${JSON.stringify(calls)}`);
});
