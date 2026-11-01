import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');
const actionsDir = join(repoRoot, '.github', 'actions');
const reviewedSetupNodeUse = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
// Container images that run repository code in CI or release validation follow the same Node major.
const nodeImageFiles = [
  'Dockerfile',
  'scripts/release/release-assets-e2e/Dockerfile',
  'scripts/release/release-assets-e2e/Dockerfile.remote-host',
  'scripts/release/release-assets-e2e/Dockerfile.remote-host-systemd',
  'scripts/release/release-assets-e2e/compose.dockerhub.yml',
  'scripts/release/release-assets-e2e/compose.desktop-setup.yml',
  'dagger/src/index.ts',
];

async function readNodeVersionPin() {
  const raw = await readFile(join(repoRoot, '.node-version'), 'utf8');
  const match = /^(\d+)\.\d+\.\d+\n$/.exec(raw);
  assert.ok(match, '.node-version must hold one exact Node version such as 24.0.0');
  return { version: raw.trim(), major: Number(match[1]) };
}

async function listWorkflowFiles() {
  const workflows = (await readdir(workflowsDir))
    .filter((name) => name.endsWith('.yml'))
    .map((name) => join(workflowsDir, name));
  const actions = [];
  for (const entry of await readdir(actionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of ['action.yml', 'action.yaml']) {
      try {
        await readFile(join(actionsDir, entry.name, name), 'utf8');
        actions.push(join(actionsDir, entry.name, name));
      } catch {}
    }
  }
  return [...workflows, ...actions];
}

function setupNodeBlocks(raw) {
  const lines = raw.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const usesColumn = lines[index].search(/uses:\s*actions\/setup-node@/);
    if (usesColumn < 0) continue;
    const stepIndent = lines[index].trimStart().startsWith('- ') ? lines[index].indexOf('-') : usesColumn - 2;
    const block = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim() === '') continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= stepIndent) break;
      block.push(line.trim());
    }
    blocks.push({ line: index + 1, block });
  }
  return blocks;
}

test('.node-version is the single exact Node 24+ LTS pin', async () => {
  const { major } = await readNodeVersionPin();
  assert.ok(major >= 24 && major % 2 === 0, '.node-version must pin an even (LTS) Node major of 24 or newer');
});

test('every setup-node step reads .node-version instead of repeating a version', async () => {
  const files = await listWorkflowFiles();
  let setupNodeSteps = 0;
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    const label = file.slice(repoRoot.length + 1);
    assert.ok(!/^\s*NODE_VERSION:/m.test(raw), `${label} must not define a NODE_VERSION env; use .node-version`);
    for (const { line, block } of setupNodeBlocks(raw)) {
      setupNodeSteps += 1;
      const literal = block.find((entry) => entry.startsWith('node-version:'));
      assert.equal(literal, undefined, `${label}:${line} must not pin node-version; use node-version-file`);
      const fileEntry = block.find((entry) => entry.startsWith('node-version-file:'));
      assert.ok(fileEntry, `${label}:${line} must set node-version-file`);
      const path = fileEntry.slice('node-version-file:'.length).trim();
      const match = /^(?:([\w.-]+)\/)?\.node-version$/.exec(path);
      assert.ok(match, `${label}:${line} must read the repository .node-version (got ${path})`);
      if (match[1]) {
        assert.ok(new RegExp(`\\bpath:\\s*${match[1].replace(/\./g, '\\.')}\\s*$`, 'm').test(raw), `${label}:${line} reads ${path} but checks nothing out at ${match[1]}`);
      }
    }
  }
  assert.ok(setupNodeSteps > 0, 'expected setup-node steps in the workflows');
});

test('workflows that run pipeline scripts use the reviewed setup-node action', async () => {
  const files = (await readdir(workflowsDir)).filter((name) => name.endsWith('.yml'));
  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    if (!raw.includes('node scripts/pipeline/')) continue;
    assert.ok(raw.includes(reviewedSetupNodeUse), `${file} must include the reviewed actions/setup-node action when running pipeline scripts`);
  }
});

test('CI and release container images use the .node-version major', async () => {
  const { major } = await readNodeVersionPin();
  const root = await readFile(join(repoRoot, 'Dockerfile'), 'utf8');
  assert.ok(new RegExp(`^ARG NODE_VERSION=${major}$`, 'm').test(root), `Dockerfile must default NODE_VERSION to ${major}`);
  for (const file of nodeImageFiles) {
    const raw = await readFile(join(repoRoot, file), 'utf8');
    for (const [, imageMajor] of raw.matchAll(/\bnode:(\d+)\b/g)) {
      assert.equal(Number(imageMajor), major, `${file} must use node:${major} images`);
    }
  }
});
