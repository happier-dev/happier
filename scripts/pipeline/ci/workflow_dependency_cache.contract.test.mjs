import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const installActionUse = './.github/actions/install-yarn-dependencies';

function loadInstallActionSteps() {
  const raw = readFileSync(join(repoRoot, '.github', 'actions', 'install-yarn-dependencies', 'action.yml'), 'utf8');
  return YAML.parse(raw).runs.steps;
}

function resolveCacheIdentity(args) {
  const step = loadInstallActionSteps().find((candidate) => candidate.id === 'runtime');
  const directory = mkdtempSync(join(tmpdir(), 'happier-dependency-cache-key-'));
  try {
    const output = join(directory, 'output');
    const result = spawnSync('bash', ['-e', '-c', step.run], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...step.env, INSTALL_ARGS: args, GITHUB_OUTPUT: output, HAPPIER_INSTALL_SCOPE: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split(/=(.*)/s, 2)),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('installs that produce the same dependency tree share one modules cache entry', () => {
  const steps = loadInstallActionSteps();
  const key = steps.find((step) => step.id === 'dependencies').with.key;
  assert.doesNotMatch(key, /inputs\.args/, 'raw install arguments must not split the modules cache');
  assert.match(key, /steps\.runtime\.outputs\.tree/);
  assert.equal(steps.find((step) => step.id === 'runtime').env.INSTALL_ARGS, '${{ inputs.args }}');

  // --frozen-lockfile and --ignore-engines only validate; they never change what is installed.
  const canonical = resolveCacheIdentity('--frozen-lockfile --ignore-engines').tree;
  assert.equal(resolveCacheIdentity('--frozen-lockfile').tree, canonical);
  assert.equal(resolveCacheIdentity('--ignore-engines   --frozen-lockfile').tree, canonical);

  // Flags that change the installed tree keep their own entries.
  const scripted = resolveCacheIdentity('--frozen-lockfile --ignore-engines --ignore-scripts').tree;
  const platform = resolveCacheIdentity('--frozen-lockfile --ignore-engines --ignore-platform').tree;
  assert.notEqual(scripted, canonical);
  assert.notEqual(platform, canonical);
  assert.notEqual(platform, scripted);
  for (const value of [canonical, scripted, platform]) assert.doesNotMatch(value, /[,\s]/);
});

test('jobs restoring the installed-modules cache do not also restore the Yarn download cache', () => {
  // A modules-cache hit verifies offline as "Already up-to-date" without reading Yarn's
  // download cache, so restoring that multi-GB archive in the same job only costs time and
  // repository cache quota that smaller caches (for example the Tauri WebKit build) need.
  const workflowsDir = join(repoRoot, '.github', 'workflows');
  const offenders = [];
  let installJobs = 0;
  for (const file of readdirSync(workflowsDir).filter((entry) => /\.ya?ml$/.test(entry)).sort()) {
    const workflow = YAML.parse(readFileSync(join(workflowsDir, file), 'utf8'));
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      const steps = job?.steps ?? [];
      if (!steps.some((step) => step?.uses === installActionUse)) continue;
      installJobs += 1;
      for (const step of steps) {
        if (String(step?.uses ?? '').startsWith('actions/setup-node@') && step.with?.cache) {
          offenders.push(`${file}#${jobId}: ${step.name ?? 'setup-node'}`);
        }
      }
    }
  }
  assert.ok(installJobs > 0, 'expected workflow jobs that use the shared install action');
  assert.deepEqual(offenders, []);
});
