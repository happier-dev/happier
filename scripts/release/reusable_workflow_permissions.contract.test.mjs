import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

const repoRoot = process.cwd();
const workflowDirectory = join(repoRoot, '.github', 'workflows');
const calledWorkflowPath = './.github/workflows/tests.yml';
const permissionRanks = { none: 0, read: 1, write: 2 };
const permissionNames = ['none', 'read', 'write'];

function permissionRank(permissions, scope) {
  if (permissions === 'read-all') return permissionRanks.read;
  if (permissions === 'write-all') return permissionRanks.write;
  if (!permissions || typeof permissions !== 'object') return permissionRanks.none;
  return permissionRanks[permissions[scope] ?? 'none'] ?? permissionRanks.none;
}

test('every local tests.yml caller grants every permission requested by the reusable workflow', async () => {
  const workflowFiles = (await readdir(workflowDirectory))
    .filter((name) => name.endsWith('.yml'));
  const workflows = new Map(await Promise.all(workflowFiles.map(async (name) => [
    name,
    YAML.parse(await readFile(join(workflowDirectory, name), 'utf8')),
  ])));
  const calledWorkflow = workflows.get('tests.yml');
  const requiredScopes = new Map();

  for (const [jobName, job] of Object.entries(calledWorkflow.jobs ?? {})) {
    const permissions = job.permissions ?? calledWorkflow.permissions;
    if (!permissions || typeof permissions !== 'object') continue;
    for (const scope of Object.keys(permissions)) {
      const rank = permissionRank(permissions, scope);
      if (rank > (requiredScopes.get(scope)?.rank ?? permissionRanks.none)) {
        requiredScopes.set(scope, { rank, jobName });
      }
    }
  }

  const callers = [];
  for (const [workflowName, workflow] of workflows) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (job.uses !== calledWorkflowPath) continue;
      callers.push({
        workflowName,
        jobName,
        permissions: job.permissions ?? workflow.permissions,
      });
    }
  }

  assert.ok(callers.length > 0, `no local callers found for ${calledWorkflowPath}`);
  const violations = [];
  for (const caller of callers) {
    for (const [scope, requirement] of requiredScopes) {
      if (permissionRank(caller.permissions, scope) < requirement.rank) {
        violations.push(
          `${caller.workflowName}:${caller.jobName} must grant ${scope}: ${permissionNames[requirement.rank]} because tests.yml:${requirement.jobName} requests it`,
        );
      }
    }
  }
  assert.deepEqual(violations, []);
});
