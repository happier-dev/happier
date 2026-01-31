import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUrlNoTrailingSlash } from './url.mjs';

test('normalizeUrlNoTrailingSlash removes trailing slash from origins', () => {
  assert.equal(normalizeUrlNoTrailingSlash('https://example.com/'), 'https://example.com');
  assert.equal(normalizeUrlNoTrailingSlash('http://localhost:3005/'), 'http://localhost:3005');
});

test('normalizeUrlNoTrailingSlash removes trailing slash from path-only base URLs', () => {
  assert.equal(normalizeUrlNoTrailingSlash('https://example.com/api/'), 'https://example.com/api');
  assert.equal(normalizeUrlNoTrailingSlash('https://example.com/api///'), 'https://example.com/api');
});

test('normalizeUrlNoTrailingSlash preserves query/hash URLs', () => {
  assert.equal(normalizeUrlNoTrailingSlash('https://example.com/?q=1'), 'https://example.com/?q=1');
  assert.equal(normalizeUrlNoTrailingSlash('https://example.com/api/?q=1'), 'https://example.com/api/?q=1');
});

