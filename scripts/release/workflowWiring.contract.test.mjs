import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import YAML from 'yaml';
import { SELECTOR_JOBS, jobsForSelectedInputs } from './ciSummaryCollector.mjs';
import { TEST_LANE_DEFINITIONS } from '../testing/lib/testLaneMap.ts';
import { matchesWorkspaceScriptTarget, resolveRootScriptWorkspaceTargets, scanPnpmInvocations } from '../testing/lib/rootScriptWorkspaceTargets.ts';

const workflow = YAML.parse(await readFile(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8'));
const { scripts } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

// These are the existing lane owner's two alternate CI entry points and the
// explicitly local-only desktop lane, not additional CI requirements.
const alternateCommands = {
  'test:agents': 'pnpm --filter @happier-dev/tests run providers:run',
  'test:db-contract:docker': 'pnpm --dir apps/server run test:server:db-contract',
};
const localOnly = new Set(['test:e2e:desktop:native']);

function wiringViolations(document, rootScripts) {
  const jobs = document.jobs ?? {};
  const issues = [];
  const requiredJobs = new Set([
    ...jobsForSelectedInputs({ inputs: {} }),
    ...Object.values(SELECTOR_JOBS).flat(),
  ]);
  const observedJobs = new Set(Array.isArray(jobs.ci_summary?.needs) ? jobs.ci_summary.needs : [jobs.ci_summary?.needs]);
  for (const id of requiredJobs) {
    if (!jobs[id]) issues.push(`Missing collector job ${id}`);
    if (!observedJobs.has(id)) issues.push(`Collector cannot observe job ${id}`);
  }

  // Comments, step labels, env data and unrelated YAML strings cannot provide
  // execution evidence. The actual run bodies alone feed the canonical scanner.
  const commands = Object.values(jobs).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? '')).join('\n');
  const scan = scanPnpmInvocations(commands);
  const targets = [
    ...scan.workspaceTargets,
    ...scan.rootScriptRefs.flatMap((name) => resolveRootScriptWorkspaceTargets(rootScripts, name)),
  ];
  const finiteRuns = scan.rootScriptRefs.includes('check:public-sdk:finite');
  const finiteBody = rootScripts['check:public-sdk:finite:local'] ?? '';
  const finiteTests = /\bturbo\s+run\s+(?:[^-]*\s)?test:finite(?:\s|$)/.test(finiteBody);
  const finiteWorkspaces = new Set([...finiteBody.matchAll(/--filter=([^\s]+)/g)].map((match) => match[1]));
  for (const lane of TEST_LANE_DEFINITIONS) {
    if (!lane.rootScriptName || localOnly.has(lane.id)) continue;
    if (scan.rootScriptRefs.includes(lane.rootScriptName)) continue;
    const alternate = alternateCommands[lane.id];
    if (alternate && commands.includes(alternate)) continue;
    const expected = resolveRootScriptWorkspaceTargets(rootScripts, lane.rootScriptName);
    const covered = expected.length > 0 && expected.every((target) => targets.some((candidate) => (
      matchesWorkspaceScriptTarget(target, candidate)
      && (candidate.scriptName === target.scriptName
        || (lane.id === 'test' && /^test(?::unit)?$/.test(candidate.scriptName)))
    )) || (lane.id === 'test' && finiteRuns && finiteTests && finiteWorkspaces.has(target.packageName)));
    if (!covered) issues.push(`Missing root test lane ${lane.id}`);
  }
  return issues.sort();
}

test('CI wires every collector job and root test lane through executable steps', () => {
  assert.deepEqual(wiringViolations(workflow, scripts), []);
});

test('wiring rejects a dropped required job or root lane, even when its command remains in a label', () => {
  const missingJob = structuredClone(workflow);
  delete missingJob.jobs.cli;
  assert.ok(wiringViolations(missingJob, scripts).includes('Missing collector job cli'));
  const unobserved = structuredClone(workflow);
  unobserved.jobs.ci_summary.needs = unobserved.jobs.ci_summary.needs.filter((id) => id !== 'cli');
  assert.ok(wiringViolations(unobserved, scripts).includes('Collector cannot observe job cli'));
  const missingLane = structuredClone(workflow);
  for (const job of Object.values(missingLane.jobs)) {
    for (const step of job.steps ?? []) {
      if (String(step.run ?? '').includes('pnpm run test:plugin-workspaces')) {
        step.name = step.run;
        delete step.run;
      }
    }
  }
  assert.ok(wiringViolations(missingLane, scripts).includes('Missing root test lane test:plugin-workspaces'));
  const missingSdkTest = { ...scripts, 'check:public-sdk:finite:local': scripts['check:public-sdk:finite:local'].replace('test:finite', '') };
  assert.ok(wiringViolations(workflow, missingSdkTest).includes('Missing root test lane test'));
});

test('wiring survives step renames and YAML formatting round trips', () => {
  const renamed = structuredClone(workflow);
  for (const job of Object.values(renamed.jobs)) for (const [index, step] of (job.steps ?? []).entries()) step.name = `renamed ${index}`;
  assert.deepEqual(wiringViolations(renamed, scripts), wiringViolations(workflow, scripts));
  assert.deepEqual(wiringViolations(YAML.parse(YAML.stringify(workflow)), scripts), wiringViolations(workflow, scripts));
});
