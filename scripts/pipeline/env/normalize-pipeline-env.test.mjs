import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePipelineEnvAliases } from './normalize-pipeline-env.mjs';

test('normalizePipelineEnvAliases fills PostHog aliases from EXPO_PUBLIC_POSTHOG_API_KEY', () => {
  const out = normalizePipelineEnvAliases({ EXPO_PUBLIC_POSTHOG_API_KEY: 'phc_test' });
  assert.equal(out.EXPO_PUBLIC_POSTHOG_KEY, 'phc_test');
  assert.equal(out.POSTHOG_API_KEY, 'phc_test');
});

test('normalizePipelineEnvAliases fills PostHog aliases from POSTHOG_API_KEY', () => {
  const out = normalizePipelineEnvAliases({ POSTHOG_API_KEY: 'phc_test' });
  assert.equal(out.EXPO_PUBLIC_POSTHOG_KEY, 'phc_test');
  assert.equal(out.EXPO_PUBLIC_POSTHOG_API_KEY, 'phc_test');
});

test('normalizePipelineEnvAliases fills PostHog host aliases from POSTHOG_HOST', () => {
  const out = normalizePipelineEnvAliases({ POSTHOG_HOST: 'https://eu.i.posthog.com' });
  assert.equal(out.EXPO_PUBLIC_POSTHOG_HOST, 'https://eu.i.posthog.com');
});

test('normalizePipelineEnvAliases fills Sentry aliases from EXPO_PUBLIC_SENTRY_DSN', () => {
  const out = normalizePipelineEnvAliases({ EXPO_PUBLIC_SENTRY_DSN: 'https://dsn.test' });
  assert.equal(out.SENTRY_DSN, 'https://dsn.test');
});

test('normalizePipelineEnvAliases does not overwrite explicitly set conflicting values', () => {
  const out = normalizePipelineEnvAliases({
    POSTHOG_API_KEY: 'phc_server',
    EXPO_PUBLIC_POSTHOG_KEY: 'phc_client',
  });
  assert.equal(out.POSTHOG_API_KEY, 'phc_server');
  assert.equal(out.EXPO_PUBLIC_POSTHOG_KEY, 'phc_client');
});
