import assert from 'node:assert/strict';
import test from 'node:test';

import { buildManifestRecord } from './manifests.mjs';

test('binary manifest preserves distinct build and publication workflow run identities', () => {
  const record = buildManifestRecord({
    product: 'happier',
    channel: 'preview',
    version: '1.2.3-preview.1',
    os: 'linux',
    arch: 'x64',
    url: 'https://example.test/happier.tar.gz',
    sha256: 'a'.repeat(64),
    commitSha: 'b'.repeat(40),
    buildWorkflowRunId: '123',
    publicationWorkflowRunId: '456',
  });

  assert.deepEqual(record.build, {
    commitSha: 'b'.repeat(40),
    workflowRunId: '123',
  });
  assert.deepEqual(record.publication, {
    workflowRunId: '456',
  });
});
