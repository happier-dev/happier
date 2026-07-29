import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildPackedCandidateBrowserQaInvocation,
  requirePackedCandidateBrowserQaInputs,
} from './run-packed-candidate-browser-qa.mjs';

test('candidate browser QA command fails closed when no manifest is supplied', () => {
  assert.throws(
    () => requirePackedCandidateBrowserQaInputs({
      argv: [],
      env: {},
      cwd: '/workspace/packages/tests',
    }),
    /packed_candidate_browser_qa_manifest_required/u,
  );
});

test('candidate browser QA command resolves an explicit candidate without a shell', () => {
  const inputs = requirePackedCandidateBrowserQaInputs({
    argv: [
      '--candidate',
      '../../.project/tmp/candidate.json',
      '--novel-handoff',
      '../../.project/tmp/packed-novel-connected-account-qa.json',
    ],
    env: {},
    cwd: '/workspace/packages/tests',
  });
  assert.deepEqual(inputs, {
    manifestPath: '/workspace/.project/tmp/candidate.json',
    novelHandoffManifestPath:
      '/workspace/.project/tmp/packed-novel-connected-account-qa.json',
  });

  assert.deepEqual(buildPackedCandidateBrowserQaInvocation({
    testsPackageRoot: '/workspace/packages/tests',
    ...inputs,
    processExecPath: '/runtime/node',
  }), {
    command: '/runtime/node',
    args: [
      '/workspace/packages/tests/scripts/run-playwright-with-heartbeat.mjs',
      '--config',
      'playwright.ui.config.mjs',
      'settings.plugins.details.spec.ts',
    ],
    cwd: '/workspace/packages/tests',
    envPatch: {
      HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST: '/workspace/.project/tmp/candidate.json',
      HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST:
        '/workspace/.project/tmp/packed-novel-connected-account-qa.json',
    },
  });
});

test('candidate browser QA command requires the exact packed novel handoff', () => {
  assert.throws(
    () => requirePackedCandidateBrowserQaInputs({
      argv: ['--candidate', '/candidate/candidate.json'],
      env: {},
      cwd: '/workspace/packages/tests',
    }),
    /packed_candidate_browser_qa_novel_handoff_required/u,
  );
});

test('candidate browser QA command accepts the canonical candidate and novel handoff environment variables', () => {
  assert.deepEqual(requirePackedCandidateBrowserQaInputs({
    argv: [],
    env: {
      HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST: '/candidate/candidate.json',
      HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST:
        '/candidate/packed-novel-connected-account-qa.json',
    },
    cwd: '/workspace/packages/tests',
  }), {
    manifestPath: '/candidate/candidate.json',
    novelHandoffManifestPath:
      '/candidate/packed-novel-connected-account-qa.json',
  });
});

test('packed novel OAuth stays in the real browser and disables secret-bearing Playwright artifacts', () => {
  const specSource = readFileSync(
    new URL(
      '../../suites/ui-e2e/settings.plugins.details.spec.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const configSource = readFileSync(
    new URL('../../playwright.ui.config.mjs', import.meta.url),
    'utf8',
  );

  assert.equal(specSource.includes("waitForEvent('requestfailed'"), true);
  assert.match(specSource, /net::ERR_CONNECTION_REFUSED/u);
  assert.equal(specSource.includes('page.request'), false);
  assert.equal(
    specSource.includes('packedNovelConnectedAccount.isolation.root'),
    true,
  );
  assert.equal(
    specSource.includes('strict: true'),
    true,
  );
  assert.match(
    specSource,
    /rootPath:\s*testDir,\s*sensitiveValues:\s*\[\s*oauthClientSecret,\s*'oauth:oauth-account',?\s*\],\s*strict:\s*true/u,
  );
  assert.match(
    specSource,
    /rootPath:\s*packedNovelConnectedAccount\.isolation\.root,\s*sensitiveValues:\s*\[\s*oauthClientSecret,\s*'oauth:oauth-account',?\s*\],\s*strict:\s*true/u,
  );
  assert.match(configSource, /packedNovelHandoffEnabled/u);
  assert.match(configSource, /trace:\s*packedNovelHandoffEnabled\s*\?\s*'off'/u);
  assert.match(configSource, /screenshot:\s*packedNovelHandoffEnabled\s*\?\s*'off'/u);
  assert.match(configSource, /video:\s*packedNovelHandoffEnabled\s*\?\s*'off'/u);
});
