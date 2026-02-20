import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} step
 * @returns {step is { uses?: string; run?: string }}
 */
function isStepLike(step) {
  if (!isRecord(step)) return false;
  return typeof step.uses === 'string' || typeof step.run === 'string';
}

/**
 * @param {unknown} workflow
 * @returns {Record<string, any>}
 */
function parseWorkflow(workflow) {
  if (!isRecord(workflow)) return {};
  return workflow;
}

test('workflows running pipeline scripts check out code and set up Node first', async () => {
  const files = (await readdir(workflowsDir)).filter((name) => name.endsWith('.yml'));

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    if (!raw.includes('node scripts/pipeline/')) continue;

    /** @type {any} */
    const parsed = YAML.parse(raw, { prettyErrors: true });
    const workflow = parseWorkflow(parsed);
    const jobs = workflow.jobs;
    if (!isRecord(jobs)) continue;

    for (const [jobId, job] of Object.entries(jobs)) {
      if (!isRecord(job)) continue;
      const steps = job.steps;
      if (!Array.isArray(steps)) continue;

      const pipelineStepIndexes = steps
        .map((step, idx) => {
          if (!isStepLike(step)) return -1;
          const run = typeof step.run === 'string' ? step.run : '';
          return run.includes('node scripts/pipeline/') ? idx : -1;
        })
        .filter((idx) => idx >= 0);

      if (pipelineStepIndexes.length === 0) continue;

      const firstPipelineIndex = Math.min(...pipelineStepIndexes);
      const prereqSteps = steps.slice(0, firstPipelineIndex).filter(isStepLike);

      const hasCheckout = prereqSteps.some((step) => typeof step.uses === 'string' && step.uses.includes('actions/checkout@v4'));
      const hasSetupNode = prereqSteps.some((step) => typeof step.uses === 'string' && step.uses.includes('actions/setup-node@v4'));

      assert.ok(
        hasCheckout,
        `${file} job '${jobId}' runs pipeline scripts but does not run actions/checkout@v4 before the first pipeline step`,
      );
      assert.ok(
        hasSetupNode,
        `${file} job '${jobId}' runs pipeline scripts but does not run actions/setup-node@v4 before the first pipeline step`,
      );
    }
  }
});

