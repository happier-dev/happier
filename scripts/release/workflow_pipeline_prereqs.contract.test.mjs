import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');
const reviewedCheckoutV4Uses = new Set([
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
]);
const reviewedSetupNodeV4Uses = new Set([
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
]);
const reviewedDownloadArtifactV4Uses = new Set([
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
]);

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

test('workflows running pipeline scripts materialize verified source and set up Node first', async () => {
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

      const hasCheckout = prereqSteps.some(
        (step) => typeof step.uses === 'string'
          && reviewedCheckoutV4Uses.has(step.uses),
      );
      const sourceArtifactDownloadIndex = steps.findIndex(
        (step, idx) => idx < firstPipelineIndex
          && isStepLike(step)
          && typeof step.uses === 'string'
          && reviewedDownloadArtifactV4Uses.has(step.uses),
      );
      const verifiedSourceMaterializationIndex = steps.findIndex((step, idx) => {
        if (idx <= sourceArtifactDownloadIndex || idx >= firstPipelineIndex || !isStepLike(step)) {
          return false;
        }
        const run = typeof step.run === 'string' ? step.run : '';
        return /tar\s+-xzf\s+"\$archive"\s+-C\s+"\$GITHUB_WORKSPACE"/.test(run)
          && run.includes('test -f "$GITHUB_WORKSPACE/scripts/pipeline/run.mjs"');
      });
      const hasVerifiedAuthorityFreeSourceArtifact = sourceArtifactDownloadIndex >= 0
        && verifiedSourceMaterializationIndex > sourceArtifactDownloadIndex
        && isRecord(job.permissions)
        && Object.keys(job.permissions).length === 0;
      const hasSetupNode = prereqSteps.some(
        (step) => typeof step.uses === 'string'
          && reviewedSetupNodeV4Uses.has(step.uses),
      );

      assert.ok(
        hasCheckout || hasVerifiedAuthorityFreeSourceArtifact,
        `${file} job '${jobId}' runs pipeline scripts but neither checks out code nor materializes and verifies an authority-free source artifact before the first pipeline step`,
      );
      assert.ok(
        hasSetupNode,
        `${file} job '${jobId}' runs pipeline scripts but does not run the reviewed actions/setup-node v4 action before the first pipeline step`,
      );
    }
  }
});
