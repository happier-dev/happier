import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveOptionalDockerBuildArgs } from './resolve-build-args.mjs';

test('resolveOptionalDockerBuildArgs omits SENTRY_AUTH_TOKEN when unset', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({}), []);
});

test('resolveOptionalDockerBuildArgs includes SENTRY_AUTH_TOKEN when set', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({ SENTRY_AUTH_TOKEN: 'token' }), [
    '--build-arg',
    'SENTRY_AUTH_TOKEN=token',
  ]);
});

test('resolveOptionalDockerBuildArgs includes SENTRY_URL when set', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({ SENTRY_URL: 'https://sentry.example' }), [
    '--build-arg',
    'SENTRY_URL=https://sentry.example',
  ]);
});

test('resolveOptionalDockerBuildArgs includes SENTRY_AUTH_TOKEN and SENTRY_URL when set', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({ SENTRY_AUTH_TOKEN: 'token', SENTRY_URL: 'https://sentry.example' }), [
    '--build-arg',
    'SENTRY_AUTH_TOKEN=token',
    '--build-arg',
    'SENTRY_URL=https://sentry.example',
  ]);
});

test('resolveOptionalDockerBuildArgs includes SENTRY_DSN when set', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({ SENTRY_DSN: 'https://dsn.example' }), [
    '--build-arg',
    'SENTRY_DSN=https://dsn.example',
  ]);
});

test('resolveOptionalDockerBuildArgs includes SENTRY_RELEASE when set', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({ SENTRY_RELEASE: 'sha123' }), [
    '--build-arg',
    'SENTRY_RELEASE=sha123',
  ]);
});

test('resolveOptionalDockerBuildArgs uses defaultSentryRelease when unset', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({}, { defaultSentryRelease: 'sha456' }), [
    '--build-arg',
    'SENTRY_RELEASE=sha456',
  ]);
});

test('resolveOptionalDockerBuildArgs includes SENTRY_SERVER_CENTRAL_DSN when set', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({ SENTRY_SERVER_CENTRAL_DSN: 'https://server-dsn.example' }), [
    '--build-arg',
    'SENTRY_SERVER_CENTRAL_DSN=https://server-dsn.example',
  ]);
});

test('resolveOptionalDockerBuildArgs includes POSTHOG_API_KEY and POSTHOG_HOST when set', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({ POSTHOG_API_KEY: 'phc_x', POSTHOG_HOST: 'https://eu.i.posthog.com' }), [
    '--build-arg',
    'POSTHOG_API_KEY=phc_x',
    '--build-arg',
    'POSTHOG_HOST=https://eu.i.posthog.com',
  ]);
});

test('resolveOptionalDockerBuildArgs includes EXPO_PUBLIC_HAPPIER_SERVER_URL when set', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({ EXPO_PUBLIC_HAPPIER_SERVER_URL: 'https://api.happier.dev' }), [
    '--build-arg',
    'EXPO_PUBLIC_HAPPIER_SERVER_URL=https://api.happier.dev',
  ]);
});

test('resolveOptionalDockerBuildArgs maps legacy server-url aliases to EXPO_PUBLIC_HAPPIER_SERVER_URL', () => {
  assert.deepEqual(resolveOptionalDockerBuildArgs({
    EXPO_PUBLIC_HAPPY_SERVER_URL: 'https://legacy-happy.example.test',
    EXPO_PUBLIC_SERVER_URL: 'https://legacy-generic.example.test',
  }), [
    '--build-arg',
    'EXPO_PUBLIC_HAPPIER_SERVER_URL=https://legacy-happy.example.test',
  ]);
});
