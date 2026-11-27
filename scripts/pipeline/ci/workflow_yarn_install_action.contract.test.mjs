import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const installActionPath = path.join(repoRoot, '.github', 'actions', 'install-yarn-dependencies', 'action.yml');

test('GitHub workflows route dependency installs through the shared install-yarn-dependencies action', () => {
  const actionRaw = fs.readFileSync(installActionPath, 'utf8');
  assert.match(
    actionRaw,
    /scripts\/ci\/yarn-install-with-retry\.sh/,
    'expected install-yarn-dependencies action to invoke the shared retrying installer script',
  );

  const workflowFiles = fs
    .readdirSync(workflowsDir)
    .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .sort();

  let sharedActionUseCount = 0;
  for (const file of workflowFiles) {
    const raw = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
    if (raw.includes('./.github/actions/install-yarn-dependencies')) {
      sharedActionUseCount += 1;
    }
    assert.doesNotMatch(
      raw,
      /\byarn install\b/,
      `${file} should use the shared install-yarn-dependencies action instead of raw yarn install`,
    );
    assert.doesNotMatch(
      raw,
      /- name: Install dependencies(?:(?!\n\s*- name:)[\s\S])*?shell:\s*[^\n]+(?:(?!\n\s*- name:)[\s\S])*?uses:\s*\.\/\.github\/actions\/install-yarn-dependencies/,
      `${file} should not keep shell on an install-yarn-dependencies action step`,
    );
  }

  assert.ok(sharedActionUseCount > 0, 'expected at least one workflow to use the shared install-yarn-dependencies action');
});

test('the repository .npmrc is the one owner of the ONNX Runtime CUDA download skip', () => {
  // onnxruntime-node fetches a Linux x64 CUDA archive on install that now returns 404 (releases 2026-11-25.1 and
  // 2026-11-26). Per-path env copies drifted: the Docker images and the EAS Android build each failed in turn.
  for (const cwd of [repoRoot, path.join(repoRoot, 'apps', 'ui')]) {
    const value = execFileSync('yarn', ['config', 'get', 'onnxruntime-node-install-cuda'], { cwd, encoding: 'utf8' }).trim().split('\n').at(-1);
    assert.equal(value, 'skip', `yarn installs from ${path.relative(repoRoot, cwd) || '.'} must read the skip`);
  }
  const copies = [installActionPath, ...fs.readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(workflowsDir, f)), path.join(repoRoot, 'Dockerfile')]
    .filter((file) => fs.readFileSync(file, 'utf8').includes('ONNXRUNTIME_NODE_INSTALL_CUDA'));
  assert.deepEqual(copies.map((f) => path.relative(repoRoot, f)), []);
});
