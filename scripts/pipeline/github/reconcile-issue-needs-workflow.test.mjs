import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../../..');


test('label bootstrap owns both mutually exclusive issue handoff labels', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/roadmap-bootstrap-labels.yml'), 'utf8');

  assert.match(workflow, /name: 'needs:maintainer'.*Project review or action is required\./);
  assert.match(workflow, /name: 'needs:reporter'.*Waiting for new information or confirmation from an external participant\./);
  assert.match(workflow, /name: 'needs:author'.*Waiting for requested changes or an answer from the pull request author\./);
});

test('handoff workflow can write existing labels on both issues and pull requests', async () => {
  const workflow = YAML.parse(await readFile(resolve(repoRoot, '.github/workflows/issue-needs-handoff.yml'), 'utf8'));
  const permissions = workflow.jobs.reconcile.permissions ?? workflow.permissions;

  assert.equal(permissions.issues, 'write');
  assert.equal(permissions['pull-requests'], 'write');
});
