import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldUseUncommittedPathSlices } from './slice_mode.mjs';

test('shouldUseUncommittedPathSlices enables codex when file count exceeds max', () => {
  const out = shouldUseUncommittedPathSlices({
    reviewer: 'codex',
    changeType: 'uncommitted',
    fileCount: 120,
    maxFiles: 100,
    chunksPreference: null,
  });
  assert.equal(out, true);
});

test('shouldUseUncommittedPathSlices disables claude when under max and no explicit chunk flag', () => {
  const out = shouldUseUncommittedPathSlices({
    reviewer: 'claude',
    changeType: 'uncommitted',
    fileCount: 20,
    maxFiles: 100,
    chunksPreference: null,
  });
  assert.equal(out, false);
});

test('shouldUseUncommittedPathSlices honors explicit chunk override', () => {
  const out = shouldUseUncommittedPathSlices({
    reviewer: 'claude',
    changeType: 'uncommitted',
    fileCount: 20,
    maxFiles: 100,
    chunksPreference: true,
  });
  assert.equal(out, true);
});

test('shouldUseUncommittedPathSlices returns false for unsupported reviewers', () => {
  const out = shouldUseUncommittedPathSlices({
    reviewer: 'augment',
    changeType: 'uncommitted',
    fileCount: 120,
    maxFiles: 100,
    chunksPreference: true,
  });
  assert.equal(out, false);
});

test('shouldUseUncommittedPathSlices returns false for non-uncommitted change types', () => {
  const out = shouldUseUncommittedPathSlices({
    reviewer: 'codex',
    changeType: 'committed',
    fileCount: 120,
    maxFiles: 100,
    chunksPreference: true,
  });
  assert.equal(out, false);
});

test('shouldUseUncommittedPathSlices returns false when maxFiles is missing and no override is set', () => {
  const out = shouldUseUncommittedPathSlices({
    reviewer: 'codex',
    changeType: 'uncommitted',
    fileCount: 1,
    chunksPreference: null,
  });
  assert.equal(out, false);
});
