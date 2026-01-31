import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertCliPrereqs } from './prereqs.mjs';

test('assertCliPrereqs({pnpm:true}) accepts yarn when pnpm is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hs-prereqs-yarn-'));
  const oldPath = process.env.PATH;
  try {
    const yarnBin = join(root, 'yarn');
    await writeFile(yarnBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(yarnBin, 0o755);
    process.env.PATH = `/bin:${root}`;

    await assertCliPrereqs({ pnpm: true });
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('assertCliPrereqs({pnpm:true}) throws when neither pnpm nor yarn is available', async () => {
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = '/bin';
    await assert.rejects(() => assertCliPrereqs({ pnpm: true }), /pnpm|yarn/i);
  } finally {
    process.env.PATH = oldPath;
  }
});

