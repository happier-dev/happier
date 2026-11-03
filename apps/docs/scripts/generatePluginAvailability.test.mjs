import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderPluginAvailabilityMarkdown } from './generatePluginAvailability.mjs';

test('projects available, preview and deferred author facts without internal proof ledgers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-plugin-availability-'));
  const matrixPath = join(directory, 'capability-matrix.json');
  try {
    await writeFile(matrixPath, JSON.stringify({
      manifestFamilies: [{
        manifestFamily: 'sample',
        availabilityDisposition: 'available',
        definePluginAuthorKey: 'sample',
        authorEntrypoint: '.',
        realm: 'any',
      }, {
        manifestFamily: 'workflows',
        availabilityDisposition: 'preview',
        definePluginAuthorKey: 'workflows',
        authorEntrypoint: '.',
        realm: 'any',
      }, {
        manifestFamily: 'future',
        availabilityDisposition: 'deferred',
        unblockCondition: 'Implement its host binding.',
      }],
      services: [{
        serviceId: 'sampleService',
        property: 'sampleService',
        availabilityDisposition: 'available',
        publicType: 'SampleService',
        authorEntrypoints: ['./services'],
        lifecycle: 'invocation',
      }],
      hostAccess: [{
        capability: 'sampleAccess',
        availabilityDisposition: 'available',
        authorizationClass: 'reviewed',
      }],
      subpaths: [{
        specifier: './workflows',
        availabilityDisposition: 'preview',
        realm: 'daemon',
      }, {
        specifier: './future',
        availabilityDisposition: 'deferred',
        unblockCondition: 'Implement the entrypoint.',
      }],
    }), 'utf8');

    const markdown = await renderPluginAvailabilityMarkdown({ matrixPath });

    assert.ok(markdown.includes('| `sample` | `available` | `sample` | `.` | any |'));
    assert.ok(markdown.includes('| `workflows` | `preview` | `workflows` | `.` | any |'));
    assert.ok(markdown.includes('| `future` | Implement its host binding. |'));
    assert.ok(markdown.includes('| `context.services.sampleService` | `available` | `SampleService` | `./services` | invocation |'));
    assert.ok(markdown.includes('| `sampleAccess` | `available` | reviewed |'));
    assert.ok(markdown.includes('| `./workflows` | `preview` | daemon |'));
    assert.ok(markdown.includes('| `./future` | Implement the entrypoint. |'));
    assert.doesNotMatch(markdown, /Source API|Source consumer|Loaded-platform proof|Release availability|not-recorded/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
