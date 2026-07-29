import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPackedResourcesBrowserQaInvocation,
  requirePackedResourcesBrowserQaManifestPath,
} from './run-packed-resources-browser-qa.mjs';

test('resource/browser candidate QA fails closed without an exact manifest', () => {
  assert.throws(
    () => requirePackedResourcesBrowserQaManifestPath({
      argv: [],
      env: {},
      cwd: '/workspace/packages/tests',
    }),
    /packed_resources_browser_qa_manifest_required/u,
  );
});

test('resource/browser candidate QA binds only the dedicated candidate spec', () => {
  const manifestPath = requirePackedResourcesBrowserQaManifestPath({
    argv: ['--candidate', '../../.project/tmp/candidate.json'],
    env: {},
    cwd: '/workspace/packages/tests',
  });

  assert.deepEqual(buildPackedResourcesBrowserQaInvocation({
    testsPackageRoot: '/workspace/packages/tests',
    manifestPath,
    processExecPath: '/runtime/node',
  }), {
    command: '/runtime/node',
    args: [
      '/workspace/packages/tests/scripts/run-playwright-with-heartbeat.mjs',
      '--config',
      'playwright.ui.config.mjs',
      'plugins.resourcesBrowser.candidate.spec.ts',
    ],
    cwd: '/workspace/packages/tests',
    envPatch: {
      HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST: '/workspace/.project/tmp/candidate.json',
      HAPPIER_PACKED_RESOURCES_BROWSER_QA: '1',
    },
  });
});

test('resource/browser candidate QA rejects a conflicting manifest environment', () => {
  assert.throws(
    () => requirePackedResourcesBrowserQaManifestPath({
      argv: ['--candidate', '/candidate/a.json'],
      env: {
        HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST: '/candidate/b.json',
      },
      cwd: '/workspace/packages/tests',
    }),
    /packed_resources_browser_qa_manifest_conflict/u,
  );
});
