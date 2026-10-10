import { expect, it } from 'vitest';
import { resolveUsageTokenCategories } from './usageTokenCategories.js';

it('projects inclusive counters once without changing vendor total', () => {
  const tokens = { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 5, total: 120 };
  expect(resolveUsageTokenCategories(tokens, { inputIncludesCache: true, outputIncludesReasoning: true })).toEqual({ ...tokens, input: 70, output: 15 });
  expect(tokens.input).toBe(100);
});

it('preserves explicitly disjoint input and refuses unknown overlapping counters', () => {
  const tokens = { input: 70, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 0, total: 120 };
  expect(resolveUsageTokenCategories(tokens, { inputIncludesCache: false })).toEqual(tokens);
  expect(resolveUsageTokenCategories(tokens, null)).toBeNull();
  expect(resolveUsageTokenCategories({ ...tokens, cacheRead: 0 }, null)).toEqual({ ...tokens, cacheRead: 0 });
});

it('refuses impossible inclusive token categories rather than pricing invented extra tokens', () => {
  const tokens = { input: 100, output: 20, cacheRead: 150, cacheWrite: 0, reasoning: 5, total: 120 };
  expect(resolveUsageTokenCategories(tokens, { inputIncludesCache: true, outputIncludesReasoning: true })).toBeNull();
});
