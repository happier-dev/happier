import test from 'node:test';
import assert from 'node:assert/strict';
import { planCommitChunks } from './chunks.mjs';

test('planCommitChunks greedily selects the largest end commit within maxFiles', async () => {
  const commits = ['c1', 'c2', 'c3', 'c4'];

  const counts = new Map([
    ['BASE->c1', 1],
    ['BASE->c2', 3],
    ['BASE->c3', 4],
    ['BASE->c4', 7],
    ['c2->c3', 2],
    ['c2->c4', 5],
    ['c3->c4', 2],
  ]);

  const chunks = await planCommitChunks({
    baseCommit: 'BASE',
    commits,
    maxFiles: 3,
    countFilesBetween: async ({ base, head }) => counts.get(`${base}->${head}`),
  });

  assert.deepEqual(chunks, [
    { base: 'BASE', head: 'c2', fileCount: 3, overLimit: false },
    { base: 'c2', head: 'c3', fileCount: 2, overLimit: false },
    { base: 'c3', head: 'c4', fileCount: 2, overLimit: false },
  ]);
});

test('planCommitChunks marks overLimit when a single step exceeds maxFiles', async () => {
  const commits = ['c1', 'c2'];

  const counts = new Map([
    ['BASE->c1', 10],
    ['c1->c2', 2],
  ]);

  const chunks = await planCommitChunks({
    baseCommit: 'BASE',
    commits,
    maxFiles: 3,
    countFilesBetween: async ({ base, head }) => counts.get(`${base}->${head}`),
  });

  assert.deepEqual(chunks, [
    { base: 'BASE', head: 'c1', fileCount: 10, overLimit: true },
    { base: 'c1', head: 'c2', fileCount: 2, overLimit: false },
  ]);
});
