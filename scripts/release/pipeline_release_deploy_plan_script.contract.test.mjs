import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

/**
 * @param {string} cwd
 * @param {string} relPath
 * @param {string} contents
 */
function writeFile(cwd, relPath, contents) {
  const abs = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf8');
}

test('compute-deploy-plan detects commits behind + relevant changes per deploy branch', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'happier-deploy-plan-'));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');

  git(dir, ['init', '--bare', origin]);
  git(dir, ['clone', origin, work]);

  git(work, ['config', 'user.email', 'ci@example.com']);
  git(work, ['config', 'user.name', 'CI']);

  // Base commit.
  writeFile(work, 'README.md', 'base\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'base']);
  git(work, ['branch', '-M', 'main']);
  git(work, ['push', '-u', 'origin', 'main']);

  // Create dev with a server change (relevant) + an unrelated change (irrelevant for docs).
  git(work, ['checkout', '-b', 'dev']);
  writeFile(work, 'apps/server/sources/app.ts', 'console.log("server");\n');
  writeFile(work, 'apps/ui/sources/app.tsx', 'export const ui = true;\n');
  writeFile(work, 'scripts/pipeline/release/sync-installers.mjs', '// changed\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'changes']);
  git(work, ['push', '-u', 'origin', 'dev']);

  const sourceSha = git(work, ['rev-parse', 'HEAD']);

  // Create deploy branches pointing at main (behind dev).
  for (const ref of ['deploy/production/server', 'deploy/production/ui', 'deploy/production/docs', 'deploy/production/website']) {
    git(work, ['checkout', 'main']);
    git(work, ['checkout', '-b', ref]);
    git(work, ['push', '-u', 'origin', ref]);
  }

  // Run script in a fresh clone so it exercises fetch+origin resolution.
  const runner = path.join(dir, 'runner');
  git(dir, ['clone', origin, runner]);

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'compute-deploy-plan.mjs'),
      '--deploy-environment',
      'production',
      '--source-ref',
      'dev',
      '--force-deploy',
      'false',
      '--deploy-ui',
      'true',
      '--deploy-server',
      'true',
      '--deploy-website',
      'true',
      '--deploy-docs',
      'true',
    ],
    {
      cwd: runner,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(out);

  assert.equal(parsed.source_sha, sourceSha);
  assert.equal(parsed.deploy_environment, 'production');
  assert.equal(parsed.source_ref, 'dev');

  // Server + UI have relevant changes and are enabled => needed true.
  assert.equal(parsed.deploy_server.needed, true);
  assert.equal(parsed.deploy_server.relevant_changes, true);
  assert.ok(parsed.deploy_server.commits_behind > 0);

  assert.equal(parsed.deploy_ui.needed, true);
  assert.equal(parsed.deploy_ui.relevant_changes, true);
  assert.ok(parsed.deploy_ui.commits_behind > 0);

  // Docs is enabled but there were no docs changes => needed false.
  assert.equal(parsed.deploy_docs.needed, false);
  assert.equal(parsed.deploy_docs.relevant_changes, false);

  // Website disabled => needed false regardless of changes.
  assert.equal(parsed.deploy_website.needed, true);
  assert.equal(parsed.deploy_website.relevant_changes, true);
  assert.ok(parsed.deploy_website.commits_behind > 0);
});

test('compute-deploy-plan respects force-deploy when deploy branch is missing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'happier-deploy-plan-missing-'));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');

  git(dir, ['init', '--bare', origin]);
  git(dir, ['clone', origin, work]);
  git(work, ['config', 'user.email', 'ci@example.com']);
  git(work, ['config', 'user.name', 'CI']);

  writeFile(work, 'README.md', 'base\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'base']);
  git(work, ['branch', '-M', 'main']);
  git(work, ['push', '-u', 'origin', 'main']);
  git(work, ['checkout', '-b', 'dev']);
  writeFile(work, 'apps/server/sources/app.ts', 'console.log("server");\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'server']);
  git(work, ['push', '-u', 'origin', 'dev']);

  // Intentionally do not create deploy/production/server on origin.
  const runner = path.join(dir, 'runner');
  git(dir, ['clone', origin, runner]);

  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'compute-deploy-plan.mjs'),
      '--deploy-environment',
      'production',
      '--source-ref',
      'dev',
      '--force-deploy',
      'true',
      '--deploy-ui',
      'false',
      '--deploy-server',
      'true',
      '--deploy-website',
      'false',
      '--deploy-docs',
      'false',
    ],
    {
      cwd: runner,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(out);
  assert.equal(parsed.deploy_server.needed, true);
  assert.equal(parsed.deploy_server.commits_behind, 0);
  assert.equal(parsed.deploy_server.relevant_changes, false);
});
