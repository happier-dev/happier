import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// @happier-dev/release-runtime exports resolve to an untracked dist, so a trusted release script that statically
// imports it fails to load unless its job installed dependencies and built release-runtime first.
function staticallyImportsReleaseRuntime(entry, seen = new Set()) {
  if (seen.has(entry) || !existsSync(entry)) return false;
  seen.add(entry);
  for (const match of readFileSync(entry, 'utf8').matchAll(/^(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/gm)) {
    const specifier = match[1];
    if (specifier.startsWith('@happier-dev/release-runtime')) return true;
    if (specifier.startsWith('.') && staticallyImportsReleaseRuntime(resolve(dirname(entry), specifier), seen)) return true;
  }
  return false;
}

function releaseRuntimeScripts(run) {
  return [...String(run ?? '').matchAll(/\bnode\s+"?[^\s"]*?(scripts\/[\w./-]+\.mjs)/g)]
    .map((match) => match[1])
    .filter((script) => staticallyImportsReleaseRuntime(join(repoRoot, script)));
}

function localActionRuns(uses) {
  const name = /^\.\/(?:\.release-control\/)?\.github\/actions\/([\w-]+)$/.exec(String(uses ?? ''))?.[1];
  if (!name) return [];
  const action = YAML.parse(readFileSync(join(repoRoot, '.github', 'actions', name, 'action.yml'), 'utf8'));
  return (action.runs?.steps ?? []).map((step) => step.run);
}

function providesReleaseRuntime(step) {
  if (!/\.github\/actions\/install-pnpm-dependencies$/.test(String(step.uses ?? ''))) return false;
  if (step.with?.['release-tooling'] === 'true' || step.with?.['prepared-artifact']) return true;
  // A full install runs release-runtime's own postinstall build.
  return !/--ignore-scripts/.test(String(step.with?.args ?? '--frozen-lockfile'));
}

test('every job that runs a trusted release script importing release-runtime installs and builds it first', () => {
  const missing = [];
  for (const file of readdirSync(join(repoRoot, '.github', 'workflows')).filter((name) => name.endsWith('.yml'))) {
    const workflow = YAML.parse(readFileSync(join(repoRoot, '.github', 'workflows', file), 'utf8'));
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      let provided = false;
      for (const step of job.steps ?? []) {
        provided ||= providesReleaseRuntime(step);
        for (const run of [step.run, ...localActionRuns(step.uses)]) {
          for (const script of releaseRuntimeScripts(run)) if (!provided) missing.push(`${file} ${jobName}: ${script}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('release tooling installs skip lifecycle scripts and build release-runtime in one owner', () => {
  const action = YAML.parse(readFileSync(join(repoRoot, '.github', 'actions', 'install-pnpm-dependencies', 'action.yml'), 'utf8'));
  const install = action.runs.steps.find((step) => step.name === 'Install frozen dependencies');
  assert.match(install.env.PNPM_INSTALL_ARGS, /inputs\.release-tooling == 'true' && '--frozen-lockfile --ignore-scripts'/);
  const build = action.runs.steps.find((step) => /release-runtime run build/.test(step.run ?? ''));
  assert.match(build.if, /inputs\.release-tooling == 'true'/);
  for (const file of readdirSync(join(repoRoot, '.github', 'workflows')).filter((name) => name.endsWith('.yml'))) {
    assert.doesNotMatch(readFileSync(join(repoRoot, '.github', 'workflows', file), 'utf8'), /pnpm --filter @happier-dev\/release-runtime run build/,
      `${file} builds release-runtime outside the install owner`);
  }
});
