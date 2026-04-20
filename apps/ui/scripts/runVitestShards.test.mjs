import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveVitestPassthroughArgs,
  resolveVitestRunPassthroughArgs,
  stripTrailingPositionalFileFilters,
} from './runVitestShards.mjs';

test('resolveVitestRunPassthroughArgs strips trailing positional file filters used for vitest list', () => {
  const argv = ['node', './scripts/runVitestShards.mjs', '--config', 'vitest.config.ts', 'sources/voice'];
  assert.deepEqual(resolveVitestPassthroughArgs(argv), ['sources/voice']);
  assert.deepEqual(resolveVitestRunPassthroughArgs(argv), []);
});

test('stripTrailingPositionalFileFilters strips multiple trailing positional filters', () => {
  assert.deepEqual(stripTrailingPositionalFileFilters(['sources/voice', 'sources/voice/output/speakAssistantText.spec.ts']), []);
});

test('stripTrailingPositionalFileFilters preserves flags and their values', () => {
  assert.deepEqual(stripTrailingPositionalFileFilters(['--reporter', 'dot', 'sources/voice']), ['--reporter', 'dot']);
});

test('stripTrailingPositionalFileFilters does not strip known flag values even if they look like paths', () => {
  assert.deepEqual(stripTrailingPositionalFileFilters(['--include', 'sources/voice']), ['--include', 'sources/voice']);
});
