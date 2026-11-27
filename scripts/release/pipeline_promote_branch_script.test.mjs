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
      '',
      'const args = process.argv.slice(2);',
      "if (args[0] !== 'api') process.exit(0);",
      '',
      'const sourceShaSequence = String(process.env.GH_STUB_SOURCE_SHA_SEQUENCE ?? "SOURCE_SHA").split(",");',
      'const sourceShaStatePath = process.env.GH_STUB_SOURCE_SHA_STATE_PATH;',
      'let sourceShaReadCount = sourceShaStatePath && fs.existsSync(sourceShaStatePath) ? Number(fs.readFileSync(sourceShaStatePath, "utf8")) || 0 : 0;',
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
      'if (method === "GET") {',
      '  if (endpoint.includes("/git/ref/heads/dev")) {',
      '    const sourceSha = sourceShaSequence[Math.min(sourceShaReadCount, sourceShaSequence.length - 1)];',
      '    sourceShaReadCount += 1;',
      '    if (sourceShaStatePath) fs.writeFileSync(sourceShaStatePath, String(sourceShaReadCount), "utf8");',
      '    process.stdout.write(`${sourceSha}\\n`);',
      '    process.exit(0);',
      '  }',
      '  if (endpoint.includes("/git/ref/heads/main")) { process.stdout.write("TARGET_SHA\\n"); process.exit(0); }',
      '  if (endpoint.includes("/compare/")) {',
      '    process.stdout.write(JSON.stringify({ status: process.env.GH_STUB_COMPARE_STATUS ?? "ahead", ahead_by: 1, behind_by: 0, files: [] }));',
      '    process.exit(0);',
      '  }',
      '  process.stdout.write("");',
      '  process.exit(0);',
      '}',
      '',
      'if (method === "PATCH" && endpoint.includes("/git/refs/heads/main")) {',
      '  const outcome = process.env.GH_STUB_PATCH_OUTCOME ?? "require_typed_force";',
      '  if (outcome === "forbidden") write403("Forbidden");',
      '  if (outcome === "success") process.exit(0);',
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

// Git and GitHub are system boundaries; the canonical source resolver stays real.
function writeGitStub(binDir) {
  writeExecutable(path.join(binDir, 'git'), [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    'const args = process.argv.slice(2);',
    'if (args[0] === "fetch") process.exit(0);',
    'if (args[0] === "rev-parse") { process.stdout.write(args[1] === "FETCH_HEAD" ? process.env.GH_STUB_AUTHORIZED_SHA : "false"); process.exit(0); }',
    'if (args[0] === "ls-remote") {',
    '  const state = process.env.GH_STUB_SOURCE_SHA_STATE_PATH;',
    '  const count = fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) || 0 : 0;',
    '  const sequence = process.env.GH_STUB_SOURCE_SHA_SEQUENCE.split(",");',
    '  fs.writeFileSync(state, String(count + 1));',
    '  process.stdout.write(`${sequence[Math.min(count, sequence.length - 1)]}\\t${args[2]}\\n`); process.exit(0);',
    '}',
    'if (args[0] === "merge-base") process.exit(process.env.GH_STUB_SOURCE_REACHABLE === "false" ? 1 : 0);',
    'process.stderr.write(`Unexpected git arguments: ${args}`); process.exit(1);',
  ].join('\n'));
}

function runPromoteBranch({ patchOutcome, sourceShaSequence = [AUTHORIZED_SOURCE_SHA], sourceReachable = true, mode = 'reset', compareStatus = 'ahead', preserveTargetDescendant = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-promote-branch-script-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const logPath = path.join(dir, 'gh.log');
  const sourceShaStatePath = path.join(dir, 'source-sha-read-count');
  fs.writeFileSync(logPath, '', 'utf8');
  writeGhStub(binDir);
  writeGitStub(binDir);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    GH_REPO: 'happier-dev/happier',
    GH_TOKEN: 'test-token',
    GH_STUB_LOG: logPath,
    GH_STUB_PATCH_OUTCOME: patchOutcome ?? 'require_typed_force',
    GH_STUB_SOURCE_SHA_SEQUENCE: sourceShaSequence.join(','),
    GH_STUB_SOURCE_SHA_STATE_PATH: sourceShaStatePath,
    GH_STUB_AUTHORIZED_SHA: AUTHORIZED_SOURCE_SHA,
    GH_STUB_SOURCE_REACHABLE: String(sourceReachable),
    GH_STUB_COMPARE_STATUS: compareStatus,
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
      mode,
      '--allow-reset',
      'true',
      '--confirm',
      mode === 'reset' ? 'reset main from dev' : 'promote main from dev',
      ...(preserveTargetDescendant ? ['--preserve-target-descendant'] : []),
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

test('promote-branch fast-forwards to the pinned candidate when the source branch advances', () => {
  const { res, calls } = runPromoteBranch({
    sourceShaSequence: [AUTHORIZED_SOURCE_SHA, ADVANCED_SOURCE_SHA],
    patchOutcome: 'success',
    mode: 'fast_forward',
  });

  assert.equal(res.status, 0, res.stderr);
  const update = calls.find((c) => c.includes('-X') && c.includes('PATCH'));
  assert.ok(update.includes(`sha=${AUTHORIZED_SOURCE_SHA}`), 'the target moves to the pinned candidate');
  assert.ok(update.includes('force=false'));
  assert.ok(!update.includes(`sha=${ADVANCED_SOURCE_SHA}`), 'later source commits are not promoted');
});

test('promote-branch refuses a candidate no longer reachable from its source branch', () => {
  const { res, calls } = runPromoteBranch({ sourceShaSequence: [ADVANCED_SOURCE_SHA], sourceReachable: false });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /not an ancestor/);
  assert.ok(!calls.some((c) => c.includes('-X')), 'must not mutate the target for an unreachable candidate');
});

test('development synchronization preserves newer target commits only when explicitly requested', () => {
  const args = { mode: 'fast_forward', compareStatus: 'behind' };
  const exact = runPromoteBranch(args);
  assert.notEqual(exact.res.status, 0, 'a release destination must not silently keep a different SHA');
  const sync = runPromoteBranch({ ...args, preserveTargetDescendant: true });
  assert.equal(sync.res.status, 0, sync.res.stderr);
  assert.ok(!sync.calls.some((c) => c.includes('-X')), 'newer target history stays untouched');
  const divergent = runPromoteBranch({ ...args, compareStatus: 'diverged', preserveTargetDescendant: true });
  assert.notEqual(divergent.res.status, 0, 'synchronization still rejects divergence');
});
