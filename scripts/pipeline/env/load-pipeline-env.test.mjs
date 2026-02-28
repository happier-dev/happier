import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadPipelineEnv } from './load-pipeline-env.mjs';

test('loadPipelineEnv normalizes alias env vars from process.env', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'happier-load-pipeline-env-test-'));

  const previous = {
    expoPublicPosthogApiKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
    expoPublicPosthogKey: process.env.EXPO_PUBLIC_POSTHOG_KEY,
    posthogApiKey: process.env.POSTHOG_API_KEY,
    expoPublicSentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    sentryDsn: process.env.SENTRY_DSN,
  };

  try {
    delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
    delete process.env.POSTHOG_API_KEY;
    delete process.env.SENTRY_DSN;

    process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_test';
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://dsn.test';

    const { env, sources } = loadPipelineEnv({ repoRoot, deployEnvironment: 'production' });

    assert.deepEqual(sources, []);
    assert.equal(env.EXPO_PUBLIC_POSTHOG_KEY, 'phc_test');
    assert.equal(env.POSTHOG_API_KEY, 'phc_test');
    assert.equal(env.SENTRY_DSN, 'https://dsn.test');
  } finally {
    if (previous.expoPublicPosthogApiKey === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
    else process.env.EXPO_PUBLIC_POSTHOG_API_KEY = previous.expoPublicPosthogApiKey;

    if (previous.expoPublicPosthogKey === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_KEY;
    else process.env.EXPO_PUBLIC_POSTHOG_KEY = previous.expoPublicPosthogKey;

    if (previous.posthogApiKey === undefined) delete process.env.POSTHOG_API_KEY;
    else process.env.POSTHOG_API_KEY = previous.posthogApiKey;

    if (previous.expoPublicSentryDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    else process.env.EXPO_PUBLIC_SENTRY_DSN = previous.expoPublicSentryDsn;

    if (previous.sentryDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = previous.sentryDsn;
  }
});
