import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../..');


test('label bootstrap owns both mutually exclusive issue handoff labels', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/roadmap-bootstrap-labels.yml'), 'utf8');

  assert.match(workflow, /name: 'needs:maintainer'.*Project review or action is required\./);
  assert.match(workflow, /name: 'needs:reporter'.*Waiting for new information or confirmation from an external participant\./);
  assert.match(workflow, /name: 'needs:author'.*Waiting for requested changes or an answer from the pull request author\./);
});
