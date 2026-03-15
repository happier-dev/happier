import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { maybeUploadSentryExpoSourceMaps } from './sentry-upload-sourcemaps.mjs';

test('maybeUploadSentryExpoSourceMaps skips when SENTRY_AUTH_TOKEN is missing', () => {
  const calls = [];
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ui-'));
  const res = maybeUploadSentryExpoSourceMaps({
    dryRun: false,
    uiDir,
    distDir: 'dist',
    env: {},
    run: (cmd, args) => calls.push({ cmd, args }),
  });
  assert.equal(res.status, 'skipped');
  assert.equal(calls.length, 0);
});

test('maybeUploadSentryExpoSourceMaps skips when dist dir is missing', () => {
  const calls = [];
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ui-'));
  const res = maybeUploadSentryExpoSourceMaps({
    dryRun: false,
    uiDir,
    distDir: 'dist',
    env: { SENTRY_AUTH_TOKEN: 'token' },
    run: (cmd, args) => calls.push({ cmd, args }),
  });
  assert.equal(res.status, 'skipped');
  assert.equal(calls.length, 0);
});

test('maybeUploadSentryExpoSourceMaps runs npx sentry-expo-upload-sourcemaps when token and dist exist', () => {
  const calls = [];
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ui-'));
  fs.mkdirSync(path.join(uiDir, 'dist'), { recursive: true });

  const res = maybeUploadSentryExpoSourceMaps({
    dryRun: false,
    uiDir,
    distDir: 'dist',
    env: { SENTRY_AUTH_TOKEN: 'token' },
    run: (cmd, args, extra) => calls.push({ cmd, args, extra }),
  });

  assert.equal(res.status, 'uploaded');
  assert.deepEqual(calls, [
    {
      cmd: 'npx',
      args: ['--yes', 'sentry-expo-upload-sourcemaps', 'dist'],
      extra: { cwd: uiDir, stdio: 'inherit' },
    },
  ]);
});

test('maybeUploadSentryExpoSourceMaps skips on dryRun when token and dist exist', () => {
  const calls = [];
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ui-'));
  fs.mkdirSync(path.join(uiDir, 'dist'), { recursive: true });

  const res = maybeUploadSentryExpoSourceMaps({
    dryRun: true,
    uiDir,
    distDir: 'dist',
    env: { SENTRY_AUTH_TOKEN: 'token' },
    run: (cmd, args, extra) => calls.push({ cmd, args, extra }),
  });

  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'dry run');
  assert.equal(calls.length, 0);
});
