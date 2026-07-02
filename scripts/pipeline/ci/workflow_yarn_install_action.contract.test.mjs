import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
  assert.match(
    actionRaw,
    /ONNXRUNTIME_NODE_INSTALL_CUDA:\s*skip/,
    'expected install-yarn-dependencies action to skip optional ONNX Runtime CUDA downloads in CI',
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
