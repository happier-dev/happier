import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

import * as module from '../dist/index.js';

test('binds the canonical Triage source contract without an obsolete fixture dependency', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.equal(packageJson.dependencies['@happier-dev/triage-protocol'], '0.0.0');
  assert.equal(Object.hasOwn(packageJson.dependencies, '@happier-dev/triage-sources-protocol'), false);
  for (const role of ['listInstances', 'scan', 'get']) {
    assert.match(source, new RegExp(`sources\\.operations\\.${role}\\.bind\\(`, 'u'));
  }
  assert.match(source, /TriageSourcesContributionProtocolV1/u);
  assert.doesNotMatch(source, /triage-sources-protocol/u);
});

test('executes every required role with its protocol-specific closed failure shape', async (t) => {
  const fixture = createTriageSourceV1Fixture();
  const plugin = await createPluginTestkit({ manifest: module.manifest, module });
  t.after(async () => plugin.dispose());

  for (const [actionId, input] of [
    ['list-project-issue-instances', fixture.listInstancesInput],
    ['scan-project-issues', fixture.scanInput],
  ]) {
    const result = await plugin.invokeAction(actionId, input);
    assert.deepEqual({ ...result, failure: { ...result.failure } }, {
      kind: 'failed',
      failure: {
        class: 'unknown',
        code: 'example-not-connected',
        detail: 'This example has no provider connection.',
      },
    });
  }

  const getResult = await plugin.invokeAction('get-project-issue', fixture.getInput);
  assert.deepEqual({
    ...getResult,
    localRef: { ...getResult.localRef },
    failure: { ...getResult.failure },
  }, {
    kind: 'unresolved',
    localRef: { ...fixture.getInput.localRef },
    failure: {
      class: 'unknown',
      code: 'example-not-connected',
      detail: 'This example has no provider connection.',
    },
  });
});
