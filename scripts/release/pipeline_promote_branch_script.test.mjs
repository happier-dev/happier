import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'promote-branch.mjs');
const AUTHORIZED_SOURCE_SHA = '1111111111111111111111111111111111111111';
const ADVANCED_SOURCE_SHA = '2222222222222222222222222222222222222222';

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

function writeGhStub(binDir) {
  const ghPath = path.join(binDir, 'gh');
  writeExecutable(
    ghPath,
    [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      '',
      'const logPath = process.env.GH_STUB_LOG;',
      'if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(process.argv.slice(2))}\\n`, \"utf8\");',
      'const sourceShaSequence = String(process.env.GH_STUB_SOURCE_SHA_SEQUENCE ?? "1111111111111111111111111111111111111111").split(",");',
      'const sourceShaStatePath = process.env.GH_STUB_SOURCE_SHA_STATE;',
      '',
      'const args = process.argv.slice(2);',
      "if (args[0] !== 'api') process.exit(0);",
      '',
      "let method = 'GET';",
      'let endpoint = "";',
      'const rawFields = [];',
      'const typedFields = [];',
      '',
      'for (let i = 1; i < args.length; i++) {',
      '  const a = args[i];',
      "  if (a === '-X' || a === '--method') { method = args[i + 1] ?? method; i++; continue; }",
      '  if ((a === "-f" || a === "--raw-field") && args[i + 1]) { rawFields.push(args[i + 1]); i++; continue; }',
      '  if ((a === "-F" || a === "--field") && args[i + 1]) { typedFields.push(args[i + 1]); i++; continue; }',
      '  if (!endpoint && !a.startsWith("-")) endpoint = a;',
      '}',
      '',
      'function hasTypedForceTrue() {',
      '  return typedFields.some((f) => f === "force=true");',
      '}',
      '',
      'function nextSourceSha() {',
      '  if (!sourceShaStatePath) return sourceShaSequence[0];',
      '  const readCount = Number(fs.readFileSync(sourceShaStatePath, "utf8"));',
      '  fs.writeFileSync(sourceShaStatePath, String(readCount + 1), "utf8");',
      '  return sourceShaSequence[Math.min(readCount, sourceShaSequence.length - 1)];',
      '}',
      '',
      'function write422(message) {',
      '  process.stdout.write(JSON.stringify({ message, status: "422" }));',
      '  process.stderr.write(`gh: ${message} (HTTP 422)\\n`);',
      '  process.exit(1);',
      '}',
      '',
      'function write403(message) {',
      '  process.stdout.write(JSON.stringify({ message, status: "403" }));',
      '  process.stderr.write(`gh: ${message} (HTTP 403)\\n`);',
      '  process.exit(1);',
      '}',
      '',
      'function write404(message) {',
      '  process.stdout.write(JSON.stringify({ message, status: "404" }));',
      '  process.stderr.write(`gh: ${message} (HTTP 404)\\n`);',
      '  process.exit(1);',
      '}',
      '',
      'if (method === "GET") {',
      '  if (endpoint.includes("/git/ref/heads/dev")) { process.stdout.write(`${nextSourceSha()}\\n`); process.exit(0); }',
      '  if (endpoint.includes("/git/ref/heads/main")) { process.stdout.write(`${process.env.GH_STUB_TARGET_SHA ?? "TARGET_SHA"}\\n`); process.exit(0); }',
      '  if (endpoint.includes("/compare/")) {',
      '    process.stdout.write(JSON.stringify({ status: "ahead", ahead_by: 1, behind_by: 0, files: [] }));',
      '    process.exit(0);',
      '  }',
      '  process.stdout.write("");',
      '  process.exit(0);',
      '}',
      '',
      'if (method === "PATCH" && endpoint.includes("/git/refs/heads/main")) {',
      '  const outcome = process.env.GH_STUB_PATCH_OUTCOME ?? "require_typed_force";',
      '  if (outcome === "forbidden") write403("Forbidden");',
      '  if (outcome === "not_found") write404("Not Found");',
      '  if (!hasTypedForceTrue()) write422("Update is not a fast forward");',
      '  process.exit(0);',
      '}',
      '',
      'if (method === "POST" && endpoint.endsWith("/git/refs")) {',
      '  const message = process.env.GH_STUB_CREATE_MESSAGE ?? "Reference already exists";',
      '  write422(message);',
      '}',
      '',
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  return ghPath;
}

function runPromoteBranch({ patchOutcome, sourceShaSequence = [AUTHORIZED_SOURCE_SHA], targetSha = 'TARGET_SHA' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-promote-branch-script-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const logPath = path.join(dir, 'gh.log');
  const sourceShaStatePath = path.join(dir, 'source-sha-reads');
  fs.writeFileSync(logPath, '', 'utf8');
  fs.writeFileSync(sourceShaStatePath, '0', 'utf8');
  writeGhStub(binDir);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    GH_REPO: 'happier-dev/happier',
    GH_TOKEN: 'test-token',
    GH_STUB_LOG: logPath,
    GH_STUB_PATCH_OUTCOME: patchOutcome ?? 'require_typed_force',
    GH_STUB_SOURCE_SHA_SEQUENCE: sourceShaSequence.join(','),
    GH_STUB_SOURCE_SHA_STATE: sourceShaStatePath,
    GH_STUB_TARGET_SHA: targetSha,
  };

  const res = spawnSync(
    process.execPath,
    [
      scriptPath,
      '--source',
      'dev',
      '--source-sha',
      AUTHORIZED_SOURCE_SHA,
      '--target',
      'main',
      '--mode',
      'reset',
      '--allow-reset',
      'true',
      '--confirm',
      'reset main from dev',
    ],
    { cwd: repoRoot, env, encoding: 'utf8' },
  );

  const calls = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return { res, calls };
}

test('promote-branch accepts an already-promoted authorized target after the source branch advances', () => {
  const { res, calls } = runPromoteBranch({
    sourceShaSequence: [ADVANCED_SOURCE_SHA],
    targetSha: AUTHORIZED_SOURCE_SHA,
  });

  assert.equal(res.status, 0, `expected idempotent success (stderr: ${res.stderr})`);
  assert.ok(!calls.some((c) => c.includes('-X') && c.includes('PATCH')), 'must not PATCH an already-correct target');
  assert.ok(!calls.some((c) => c.includes('-X') && c.includes('POST')), 'must not recreate an already-correct target');
});

test('promote-branch reset uses typed force update (no fallback create)', () => {
  const { res, calls } = runPromoteBranch({ patchOutcome: 'require_typed_force' });

  assert.equal(res.status, 0, `expected success (stderr: ${res.stderr})`);
  assert.ok(calls.some((c) => c.includes('-X') && c.includes('PATCH')), 'expected PATCH call to update ref');
  assert.ok(calls.some((c) => c.includes('-F') && c.includes('force=true')), 'expected typed force=true field');
  assert.ok(!calls.some((c) => c.includes('-X') && c.includes('POST')), 'expected no POST fallback create call');
});

test('promote-branch does not mask PATCH failures by attempting create', () => {
  const { res, calls } = runPromoteBranch({ patchOutcome: 'forbidden' });

  assert.notEqual(res.status, 0, 'expected failure');
  assert.match(res.stderr, /\bForbidden\b/);
  assert.ok(!calls.some((c) => c.includes('-X') && c.includes('POST')), 'expected no POST fallback create call');
});

test('promote-branch refuses a source branch that advanced after authorization before mutating the target', () => {
  const { res, calls } = runPromoteBranch({
    sourceShaSequence: [AUTHORIZED_SOURCE_SHA, ADVANCED_SOURCE_SHA],
  });

  assert.notEqual(res.status, 0, 'expected the source drift fence to fail');
  assert.match(res.stderr, /Source branch changed after authorization/);
  assert.ok(!calls.some((c) => c.includes('-X') && c.includes('PATCH')), 'must not PATCH after source drift');
  assert.ok(!calls.some((c) => c.includes('-X') && c.includes('POST')), 'must not create a ref after source drift');
});

test('promote-branch revalidates the source before creating a missing target ref', () => {
  const { res, calls } = runPromoteBranch({
    patchOutcome: 'not_found',
    sourceShaSequence: [AUTHORIZED_SOURCE_SHA, AUTHORIZED_SOURCE_SHA, ADVANCED_SOURCE_SHA],
  });

  assert.notEqual(res.status, 0, 'expected the source drift fence to fail');
  assert.match(res.stderr, /Source branch changed after authorization/);
  assert.ok(!calls.some((c) => c.includes('-X') && c.includes('POST')), 'must not create a ref after source drift');
});
