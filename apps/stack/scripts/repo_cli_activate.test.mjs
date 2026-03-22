import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture as runNode } from './testkit/core/run_node_capture.mjs';

test('repo cli activate configures init with cli-root-dir pointing at this checkout', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const homeDir = mkdtempSync(join(tmpdir(), 'happier-repo-cli-activate-home-'));
  const canonicalHomeDir = mkdtempSync(join(tmpdir(), 'happier-repo-cli-activate-canonical-'));
  try {
    const res = await runNode(
      [
        join(packageRoot, 'scripts', 'repo_cli_activate.mjs'),
        `--home-dir=${homeDir}`,
        `--canonical-home-dir=${canonicalHomeDir}`,
        '--no-runtime', // redundant; ensure we don't accidentally install runtime during the test
        '--no-bootstrap',
      ],
      { cwd: repoRoot, env: process.env }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const homeEnvPath = join(homeDir, '.env');
    const homeEnv = readFileSync(homeEnvPath, 'utf-8');
    const expectedCliRootDir = resolve(join(repoRoot, 'apps', 'stack'));
    assert.match(
      homeEnv,
      new RegExp(`^HAPPIER_STACK_CLI_ROOT_DIR=${expectedCliRootDir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'm'),
      `expected init to persist cli root dir override in ${homeEnvPath}\n${homeEnv}`
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(canonicalHomeDir, { recursive: true, force: true });
  }
});
