import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

const repoRoot = process.cwd();
const workflowDirectory = join(repoRoot, '.github', 'workflows');
const permissionRanks = { none: 0, read: 1, write: 2 };
const permissionNames = ['none', 'read', 'write'];

function permissionRank(permissions, scope) {
  if (permissions === 'read-all') return permissionRanks.read;
  if (permissions === 'write-all') return permissionRanks.write;
  if (!permissions || typeof permissions !== 'object') return permissionRanks.none;
  return permissionRanks[permissions[scope] ?? 'none'] ?? permissionRanks.none;
}

test('every local reusable workflow caller grants every transitive permission requested by the called graph', async () => {
  const workflowFiles = (await readdir(workflowDirectory))
    .filter((name) => name.endsWith('.yml'));
  const workflows = new Map(await Promise.all(workflowFiles.map(async (name) => [
    name,
    YAML.parse(await readFile(join(workflowDirectory, name), 'utf8')),
  ])));
  const requiredPermissionsCache = new Map();
  function collectRequiredPermissions(workflowName, ancestors = []) {
    const cached = requiredPermissionsCache.get(workflowName);
    if (cached) return cached;
    assert.ok(!ancestors.includes(workflowName), `reusable workflow cycle: ${[...ancestors, workflowName].join(' -> ')}`);
    const workflow = workflows.get(workflowName);
    assert.ok(workflow, `missing local reusable workflow ${workflowName}`);
    const requiredScopes = new Map();
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const permissions = job.permissions ?? workflow.permissions;
      if (permissions && typeof permissions === 'object') {
        for (const scope of Object.keys(permissions)) {
          const rank = permissionRank(permissions, scope);
          if (rank > (requiredScopes.get(scope)?.rank ?? permissionRanks.none)) {
            requiredScopes.set(scope, { rank, owner: `${workflowName}:${jobName}` });
          }
        }
      }
      if (typeof job.uses === 'string' && job.uses.startsWith('./.github/workflows/')) {
        for (const [scope, requirement] of collectRequiredPermissions(basename(job.uses), [...ancestors, workflowName])) {
          if (requirement.rank > (requiredScopes.get(scope)?.rank ?? permissionRanks.none)) {
            requiredScopes.set(scope, requirement);
          }
        }
      }
    }
    requiredPermissionsCache.set(workflowName, requiredScopes);
    return requiredScopes;
  }

  const violations = [];
  for (const [workflowName, workflow] of workflows) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (typeof job.uses !== 'string' || !job.uses.startsWith('./.github/workflows/')) continue;
      const calledWorkflowName = basename(job.uses);
      for (const [scope, requirement] of collectRequiredPermissions(calledWorkflowName)) {
        if (permissionRank(job.permissions ?? workflow.permissions, scope) < requirement.rank) {
          violations.push(
            `${workflowName}:${jobName} must grant ${scope}: ${permissionNames[requirement.rank]} because ${requirement.owner} requests it`,
          );
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});
