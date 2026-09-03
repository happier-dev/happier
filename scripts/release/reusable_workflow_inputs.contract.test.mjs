import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

const repoRoot = process.cwd();
const workflowDirectory = join(repoRoot, '.github', 'workflows');
const localWorkflowPrefix = './.github/workflows/';

test('local reusable workflow calls pass only declared inputs', async () => {
  const workflowFiles = (await readdir(workflowDirectory)).filter((name) => name.endsWith('.yml'));
  const workflows = new Map(await Promise.all(workflowFiles.map(async (name) => [
    name,
    YAML.parse(await readFile(join(workflowDirectory, name), 'utf8')),
  ])));
  const violations = [];

  for (const [callerName, caller] of workflows) {
    for (const [jobName, job] of Object.entries(caller.jobs ?? {})) {
      if (typeof job.uses !== 'string' || !job.uses.startsWith(localWorkflowPrefix)) continue;

      const calledName = basename(job.uses);
      const called = workflows.get(calledName);
      assert.ok(called, `${callerName}:${jobName} references missing local workflow ${job.uses}`);
      const declaredInputs = called.on?.workflow_call?.inputs ?? {};

      for (const inputName of Object.keys(job.with ?? {})) {
        if (!(inputName in declaredInputs)) {
          violations.push(`${callerName}:${jobName} passes undeclared ${calledName} input ${inputName}`);
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});
