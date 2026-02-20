import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'github', 'promote-branch.mjs');

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
      '  if (endpoint.includes("/git/ref/heads/dev")) { process.stdout.write("SOURCE_SHA\\n"); process.exit(0); }',
      '  if (endpoint.includes("/git/ref/heads/main")) { process.stdout.write("TARGET_SHA\\n"); process.exit(0); }',
      '  if (endpoint.includes("/compare/main...dev")) {',
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

function runPromoteBranch({ patchOutcome }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-promote-branch-script-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const logPath = path.join(dir, 'gh.log');
  writeGhStub(binDir);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    GH_REPO: 'happier-dev/happier',
    GH_TOKEN: 'test-token',
    GH_STUB_LOG: logPath,
    GH_STUB_PATCH_OUTCOME: patchOutcome ?? 'require_typed_force',
  };

  const res = spawnSync(
    process.execPath,
    [
      scriptPath,
      '--source',
      'dev',
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

