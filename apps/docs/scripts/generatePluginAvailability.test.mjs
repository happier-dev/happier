import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderPluginAvailabilityMarkdown } from './generatePluginAvailability.mjs';

test('keeps source, loaded-platform, and release evidence distinct from product availability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-plugin-availability-'));
  const matrixPath = join(directory, 'capability-matrix.json');
  try {
    await writeFile(matrixPath, JSON.stringify({
      manifestFamilies: [{
        manifestFamily: 'sample',
        availabilityDisposition: 'available',
        sourceApiAvailability: 'present',
        sourceConsumer: 'packages/plugins/sample/src/manifest.ts',
        loadedPlatformProof: 'not-recorded',
        releaseAvailability: 'not-published',
      }],
      services: [],
      hostAccess: [],
      subpaths: [],
    }), 'utf8');

    const markdown = await renderPluginAvailabilityMarkdown({ matrixPath });

    assert.match(markdown, /Product availability is distinct from source API availability/u);
    assert.match(markdown, /\| Name \| Availability \| Source API \|/u);
    assert.match(markdown, /\| `sample` \| `available` \| `present` \|/u);
    assert.match(markdown, /Source consumer/u);
    assert.match(markdown, /Loaded-platform proof/u);
    assert.match(markdown, /Release availability/u);
    assert.match(markdown, /packages\/plugins\/sample\/src\/manifest\.ts/u);
    assert.match(markdown, /not-recorded/u);
    assert.match(markdown, /not-published/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
