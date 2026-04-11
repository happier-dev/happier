import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTestflightDistributionEnvVarPrefix,
  resolveTestflightDistributionConfig,
} from './testflight-distribution-config.mjs';

test('buildTestflightDistributionEnvVarPrefix maps release environments to public TestFlight env vars', () => {
  assert.equal(buildTestflightDistributionEnvVarPrefix('dev'), 'APP_STORE_CONNECT_PUBLICDEV');
  assert.equal(buildTestflightDistributionEnvVarPrefix('publicdev'), 'APP_STORE_CONNECT_PUBLICDEV');
  assert.equal(buildTestflightDistributionEnvVarPrefix('preview'), 'APP_STORE_CONNECT_PREVIEW');
  assert.equal(buildTestflightDistributionEnvVarPrefix('production'), 'APP_STORE_CONNECT_PRODUCTION');
});

test('resolveTestflightDistributionConfig reads the configured group and processing toggles', () => {
  const config = resolveTestflightDistributionConfig({
    environment: 'dev',
    env: {
      APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS: 'alpha, beta',
      APP_STORE_CONNECT_PUBLICDEV_SUBMIT_BETA_REVIEW: 'false',
      APP_STORE_CONNECT_PUBLICDEV_WAIT_PROCESSING: 'false',
      APP_STORE_CONNECT_PUBLICDEV_PROCESSING_TIMEOUT_SECONDS: '120',
    },
  });

  assert.equal(config.enabled, true);
  assert.equal(config.externalGroups, 'alpha, beta');
  assert.equal(config.submitBetaReview, 'false');
  assert.equal(config.waitProcessing, false);
  assert.equal(config.processingTimeoutSeconds, 120);
  assert.equal(config.envVarNames.externalGroups, 'APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS');
});

test('resolveTestflightDistributionConfig stays disabled without external TestFlight groups', () => {
  const config = resolveTestflightDistributionConfig({
    environment: 'preview',
    env: {},
  });

  assert.equal(config.enabled, false);
  assert.equal(config.externalGroups, '');
  assert.equal(config.submitBetaReview, 'auto');
  assert.equal(config.waitProcessing, true);
  assert.equal(config.processingTimeoutSeconds, 3600);
});
