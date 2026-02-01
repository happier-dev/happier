import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultDevClientIdentity,
  defaultStackReleaseIdentity,
  sanitizeBundleIdSegment,
  sanitizeUrlScheme,
  stackSlugForMobileIds,
} from './identifiers.mjs';

test('sanitizeBundleIdSegment produces a safe segment', () => {
  assert.equal(sanitizeBundleIdSegment('  PR272-107  '), 'pr272-107');
  assert.equal(sanitizeBundleIdSegment('---'), 'app');
  assert.equal(sanitizeBundleIdSegment('123'), 's123');
});

test('sanitizeUrlScheme produces a safe scheme', () => {
  assert.equal(sanitizeUrlScheme('Happier-Dev'), 'happier-dev');
  assert.equal(sanitizeUrlScheme('123bad'), 'h123bad');
  assert.equal(sanitizeUrlScheme(''), 'happier-dev');
});

test('stackSlugForMobileIds derives a stable slug', () => {
  assert.equal(stackSlugForMobileIds('pr272-107-fixes-2026-01-15'), 'pr272-107-fixes-2026-01-15');
  assert.equal(stackSlugForMobileIds('  Weird Name  '), 'weird-name');
});

test('defaultDevClientIdentity is stable and safe', () => {
  const id = defaultDevClientIdentity({ user: 'Leeroy' });
  assert.equal(id.iosAppName, 'Happier Dev');
  assert.equal(id.scheme, 'happier-dev');
  assert.equal(id.iosBundleId, 'dev.happier.stack.dev.leeroy');
});

test('defaultStackReleaseIdentity is per-stack', () => {
  const id = defaultStackReleaseIdentity({ stackName: 'pr272-107', user: 'Leeroy' });
  assert.equal(id.iosBundleId, 'dev.happier.stack.stack.leeroy.pr272-107');
  assert.equal(id.scheme, 'happier-pr272-107');
  assert.equal(id.iosAppName, 'Happier (pr272-107)');
});
