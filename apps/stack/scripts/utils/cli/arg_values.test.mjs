import test from 'node:test';
import assert from 'node:assert/strict';

import { getFlagValue } from './arg_values.mjs';

test('getFlagValue prefers kv values over argv', () => {
  const argv = ['build', '--platform', 'android'];
  const kv = new Map([['--platform', 'ios']]);
  assert.equal(getFlagValue({ argv, kv, flag: '--platform' }), 'ios');
});

test('getFlagValue reads space-separated flag values', () => {
  const argv = ['build', '--platform', 'android'];
  const kv = new Map();
  assert.equal(getFlagValue({ argv, kv, flag: '--platform' }), 'android');
});

test('getFlagValue ignores space-separated values when the next token is another flag', () => {
  const argv = ['build', '--platform', '--profile', 'production'];
  const kv = new Map();
  assert.equal(getFlagValue({ argv, kv, flag: '--platform' }), undefined);
});

test('getFlagValue uses the last occurrence in argv', () => {
  const argv = ['build', '--platform', 'ios', '--platform', 'android'];
  const kv = new Map();
  assert.equal(getFlagValue({ argv, kv, flag: '--platform' }), 'android');
});

