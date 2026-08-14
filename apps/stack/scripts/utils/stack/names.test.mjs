import test from 'node:test';
import assert from 'node:assert/strict';

import { assertCanonicalManagedStackName, normalizeStackNameOrNull } from './names.mjs';

test('normalizeStackNameOrNull normalizes to a DNS-safe label', () => {
  assert.equal(normalizeStackNameOrNull('My Stack'), 'my-stack');
});

test('normalizeStackNameOrNull returns null when the name sanitizes to empty', () => {
  assert.equal(normalizeStackNameOrNull('----'), null);
});

test('normalizeStackNameOrNull returns null when the name exceeds maxLen', () => {
  const long = 'a'.repeat(64);
  assert.equal(normalizeStackNameOrNull(long), null);
});

test('normalizeStackNameOrNull accepts a 63-character DNS-safe label', () => {
  const max = 'a'.repeat(63);
  assert.equal(normalizeStackNameOrNull(max), max);
});

test('normalizeStackNameOrNull collapses punctuation runs into single separators', () => {
  assert.equal(normalizeStackNameOrNull('My__Stack...Name'), 'my-stack-name');
});

test('assertCanonicalManagedStackName accepts only an already-canonical managed stack name', () => {
  assert.equal(assertCanonicalManagedStackName('repo-happier-dev', 'producer'), 'repo-happier-dev');
  assert.throws(
    () => assertCanonicalManagedStackName('../outside', 'producer'),
    /invalid producer stack name/i,
  );
  assert.throws(
    () => assertCanonicalManagedStackName('My Stack', 'producer'),
    /invalid producer stack name/i,
  );
});
