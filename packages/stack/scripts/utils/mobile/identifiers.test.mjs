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
  assert.equal(sanitizeUrlScheme('HappyStacks-Dev'), 'happystacks-dev');
  assert.equal(sanitizeUrlScheme('123bad'), 'h123bad');
  assert.equal(sanitizeUrlScheme(''), 'happystacks-dev');
});

test('stackSlugForMobileIds derives a stable slug', () => {
  assert.equal(stackSlugForMobileIds('pr272-107-fixes-2026-01-15'), 'pr272-107-fixes-2026-01-15');
  assert.equal(stackSlugForMobileIds('  Weird Name  '), 'weird-name');
});

test('defaultDevClientIdentity is stable and safe', () => {
  const id = defaultDevClientIdentity({ user: 'Leeroy' });
  assert.equal(id.iosAppName, 'Happy Stacks Dev');
  assert.equal(id.scheme, 'happystacks-dev');
  assert.equal(id.iosBundleId, 'com.happystacks.dev.leeroy');
});

test('defaultStackReleaseIdentity is per-stack', () => {
  const id = defaultStackReleaseIdentity({ stackName: 'pr272-107', user: 'Leeroy' });
  assert.equal(id.iosBundleId, 'com.happystacks.stack.leeroy.pr272-107');
  assert.equal(id.scheme, 'happystacks-pr272-107');
  assert.equal(id.iosAppName, 'Happy (pr272-107)');
});

