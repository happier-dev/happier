import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedAugmentHomeFromRealHome, seedCodeRabbitHomeFromRealHome, seedCodexHomeFromRealHome } from './tool_home_seed.mjs';

test('seedCodeRabbitHomeFromRealHome copies coderabbit state into isolated home when missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happy-stacks-coderabbit-seed-'));
  const realHome = join(root, 'real');
  const isolatedHome = join(root, 'isolated');

  try {
    await mkdir(join(realHome, '.coderabbit'), { recursive: true });
    await mkdir(join(realHome, '.config', 'coderabbit'), { recursive: true });
    await writeFile(join(realHome, '.coderabbit', 'auth.json'), 'secret-ish\n', 'utf-8');
    await writeFile(join(realHome, '.config', 'coderabbit', 'config.toml'), 'cfg\n', 'utf-8');

    await mkdir(isolatedHome, { recursive: true });

    await seedCodeRabbitHomeFromRealHome({ realHomeDir: realHome, isolatedHomeDir: isolatedHome });

    assert.equal(await readFile(join(isolatedHome, '.coderabbit', 'auth.json'), 'utf-8'), 'secret-ish\n');
    assert.equal(await readFile(join(isolatedHome, '.config', 'coderabbit', 'config.toml'), 'utf-8'), 'cfg\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('seedCodeRabbitHomeFromRealHome does not overwrite existing isolated state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happy-stacks-coderabbit-seed-'));
  const realHome = join(root, 'real');
  const isolatedHome = join(root, 'isolated');

  try {
    await mkdir(join(realHome, '.coderabbit'), { recursive: true });
    await writeFile(join(realHome, '.coderabbit', 'auth.json'), 'from-real\n', 'utf-8');

    await mkdir(join(isolatedHome, '.coderabbit'), { recursive: true });
    await writeFile(join(isolatedHome, '.coderabbit', 'auth.json'), 'already\n', 'utf-8');

    await seedCodeRabbitHomeFromRealHome({ realHomeDir: realHome, isolatedHomeDir: isolatedHome });

    assert.equal(await readFile(join(isolatedHome, '.coderabbit', 'auth.json'), 'utf-8'), 'already\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('seedCodeRabbitHomeFromRealHome refreshes auth.json when the real home has a newer one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happy-stacks-coderabbit-seed-'));
  const realHome = join(root, 'real');
  const isolatedHome = join(root, 'isolated');

  try {
    await mkdir(join(realHome, '.coderabbit'), { recursive: true });
    await mkdir(join(isolatedHome, '.coderabbit'), { recursive: true });

    await writeFile(join(isolatedHome, '.coderabbit', 'auth.json'), 'old\n', 'utf-8');
    // Ensure a later mtime for the real auth.
    await new Promise((r) => setTimeout(r, 15));
    await writeFile(join(realHome, '.coderabbit', 'auth.json'), 'new\n', 'utf-8');

    await seedCodeRabbitHomeFromRealHome({ realHomeDir: realHome, isolatedHomeDir: isolatedHome });

    assert.equal(await readFile(join(isolatedHome, '.coderabbit', 'auth.json'), 'utf-8'), 'new\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('seedCodexHomeFromRealHome refreshes auth/config when the real home has newer ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happy-stacks-codex-seed-'));
  const realHome = join(root, 'real');
  const isolatedHome = join(root, 'isolated');

  try {
    await mkdir(join(realHome, '.codex'), { recursive: true });
    await mkdir(isolatedHome, { recursive: true });

    await writeFile(join(isolatedHome, 'auth.json'), 'old-auth\n', 'utf-8');
    await writeFile(join(isolatedHome, 'config.toml'), 'old-cfg\n', 'utf-8');

    await new Promise((r) => setTimeout(r, 15));
    await writeFile(join(realHome, '.codex', 'auth.json'), 'new-auth\n', 'utf-8');
    await writeFile(join(realHome, '.codex', 'config.toml'), 'new-cfg\n', 'utf-8');

    await seedCodexHomeFromRealHome({ realHomeDir: realHome, isolatedHomeDir: isolatedHome });

    assert.equal(await readFile(join(isolatedHome, 'auth.json'), 'utf-8'), 'new-auth\n');
    assert.equal(await readFile(join(isolatedHome, 'config.toml'), 'utf-8'), 'new-cfg\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('seedAugmentHomeFromRealHome copies session.json into isolated cache dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happy-stacks-augment-seed-'));
  const realHome = join(root, 'real');
  const isolatedHome = join(root, 'isolated');

  try {
    await mkdir(join(realHome, '.augment'), { recursive: true });
    await writeFile(join(realHome, '.augment', 'session.json'), '{"ok":true}\n', 'utf-8');
    await mkdir(isolatedHome, { recursive: true });

    await seedAugmentHomeFromRealHome({ realHomeDir: realHome, isolatedHomeDir: isolatedHome });

    assert.equal(await readFile(join(isolatedHome, 'session.json'), 'utf-8'), '{"ok":true}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
