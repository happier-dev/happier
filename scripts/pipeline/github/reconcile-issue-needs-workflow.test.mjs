import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../..');

test('issue handoff workflow delegates opened, reopened, and comment events to the canonical reconciler', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/issue-needs-handoff.yml'), 'utf8');

  assert.match(workflow, /issues:\s*\n\s+types:\s*\[opened, reopened\]/);
  assert.match(workflow, /issue_comment:\s*\n\s+types:\s*\[created\]/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read\s*\n\s+issues:\s*write/);
  assert.match(workflow, /node scripts\/pipeline\/github\/reconcile-issue-needs\.mjs/);
  assert.match(workflow, /--event-name "\$GITHUB_EVENT_NAME"/);
  assert.match(workflow, /--event-path "\$GITHUB_EVENT_PATH"/);
});

test('label bootstrap owns both mutually exclusive issue handoff labels', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/roadmap-bootstrap-labels.yml'), 'utf8');

  assert.match(workflow, /name: 'needs:maintainer'.*Project review or action is required\./);
  assert.match(workflow, /name: 'needs:reporter'.*Waiting for new information or confirmation from an external participant\./);
  assert.match(workflow, /name: 'needs:author'.*Waiting for requested changes or an answer from the pull request author\./);
});

test('PR lifecycle handoff runs trusted default-branch policy without executing contributor code', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/issue-needs-handoff.yml'), 'utf8');
  assert.match(workflow, /pull_request_target:\s*\n\s+types: \[opened, reopened, ready_for_review, synchronize, closed\]/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /group: .*github\.event\.issue\.number \|\| github\.event\.pull_request\.number/);
  assert.doesNotMatch(workflow, /pull_request\.head|pull_request\.merge|checkout.*--/);
  assert.doesNotMatch(workflow, /pull_request_review:|pull_request_review_comment:/);
});
