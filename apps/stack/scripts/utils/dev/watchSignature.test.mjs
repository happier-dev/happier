import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  isDevRuntimeReloadIgnoredPath,
  readDevReloadWatchChangeSignature,
  readDevReloadWatchChangeSignatureAsync,
} from './watchSignature.mjs';

test('runtime reload ignore matching is separator-safe and limited to test-only path conventions', () => {
  for (const path of [
    '/repo/apps/cli/src/testkit/fs/tempDir.ts',
    'C:\\repo\\apps\\cli\\src\\testkit\\fs\\tempDir.ts',
    '/repo/apps/cli/src/agent/tools/trace/testEvents.testkit.ts',
    '/repo/apps/cli/src/vitestSetup.ts',
  ]) {
    assert.equal(isDevRuntimeReloadIgnoredPath(path), true, path);
  }

  for (const path of [
    '/repo/apps/cli/src/testkitRuntime.ts',
    '/repo/apps/cli/src/agent/tools/trace/testEvents.testkitConfig.ts',
    '/repo/apps/cli/src/runtime-testkit.ts',
    '/repo/apps/cli/src/runtime_testkit.ts',
    '/repo/apps/cli/src/vitestSetupRuntime.ts',
    '/repo/apps/cli/src/runtime.ts',
  ]) {
    assert.equal(isDevRuntimeReloadIgnoredPath(path), false, path);
  }
});

test('readDevReloadWatchChangeSignature changes when a watched file changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-watch-signature-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const srcDir = join(root, 'src');
  const watchedFile = join(srcDir, 'index.ts');
  await mkdir(srcDir, { recursive: true });
  await writeFile(watchedFile, 'export const value = 1;\n', 'utf-8');

  const before = readDevReloadWatchChangeSignature([srcDir]);
  await writeFile(watchedFile, 'export const value = 12345;\n', 'utf-8');
  const after = readDevReloadWatchChangeSignature([srcDir]);

  assert.equal(typeof before, 'string');
  assert.equal(typeof after, 'string');
  assert.notEqual(after, before);
});

test('readDevReloadWatchChangeSignature returns null when no path is observable', () => {
  const signature = readDevReloadWatchChangeSignature(['/tmp/hstack-missing-watch-path-for-test']);
  assert.equal(signature, null);
});

test('readDevReloadWatchChangeSignatureAsync returns null when no path is observable', async () => {
  const signature = await readDevReloadWatchChangeSignatureAsync(['/tmp/hstack-missing-watch-path-for-async-test']);
  assert.equal(signature, null);
});

test('readDevReloadWatchChangeSignatureAsync preserves the deterministic change contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-watch-signature-async-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const srcDir = join(root, 'src');
  const watchedFile = join(srcDir, 'index.ts');
  await mkdir(srcDir, { recursive: true });
  await writeFile(watchedFile, 'export const value = 1;\n', 'utf-8');

  const synchronousBefore = readDevReloadWatchChangeSignature([srcDir]);
  const before = await readDevReloadWatchChangeSignatureAsync([srcDir]);
  await writeFile(watchedFile, 'export const value = 12345;\n', 'utf-8');
  const after = await readDevReloadWatchChangeSignatureAsync([srcDir]);

  assert.equal(typeof before, 'string');
  assert.equal(typeof after, 'string');
  assert.equal(before, synchronousBefore, 'async polling must not cause a false startup reload');
  assert.notEqual(after, before);
});

test('sync and async signatures ignore test-only inputs while retaining neighboring runtime files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-watch-signature-runtime-inputs-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const sourceDir = join(root, 'sources');
  const runtimeFile = join(sourceDir, 'runtime.ts');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(runtimeFile, 'export const runtime = 1;\n', 'utf-8');
  const beforeSync = readDevReloadWatchChangeSignature([sourceDir]);
  const beforeAsync = await readDevReloadWatchChangeSignatureAsync([sourceDir]);

  await writeFile(join(sourceDir, 'session.spec.ts'), 'export const spec = 1;\n', 'utf-8');
  await writeFile(join(sourceDir, 'session.testkit.ts'), 'export const fixture = 1;\n', 'utf-8');
  await writeFile(join(sourceDir, 'vitestSetup.ts'), 'export const setup = 1;\n', 'utf-8');
  await mkdir(join(sourceDir, 'tests'), { recursive: true });
  await writeFile(join(sourceDir, 'tests', 'fixture.ts'), 'export const fixture = 2;\n', 'utf-8');

  assert.equal(readDevReloadWatchChangeSignature([sourceDir]), beforeSync);
  assert.equal(await readDevReloadWatchChangeSignatureAsync([sourceDir]), beforeAsync);

  await writeFile(runtimeFile, 'export const runtime = 2;\n', 'utf-8');
  assert.notEqual(readDevReloadWatchChangeSignature([sourceDir]), beforeSync);
  assert.notEqual(await readDevReloadWatchChangeSignatureAsync([sourceDir]), beforeAsync);
});

test('sync and async signatures distinguish same-size edits within one millisecond', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-watch-signature-nanoseconds-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const watchedFile = join(root, 'runtime.ts');
  await writeFile(watchedFile, 'export const value = 1;\n', 'utf-8');
  await utimes(watchedFile, 1, 1.0001);
  const beforeSync = readDevReloadWatchChangeSignature([root]);
  const beforeAsync = await readDevReloadWatchChangeSignatureAsync([root]);

  await writeFile(watchedFile, 'export const value = 2;\n', 'utf-8');
  await utimes(watchedFile, 1, 1.0008);
  const afterSync = readDevReloadWatchChangeSignature([root]);
  const afterAsync = await readDevReloadWatchChangeSignatureAsync([root]);

  assert.equal(beforeSync, beforeAsync);
  assert.equal(afterSync, afterAsync);
  assert.notEqual(afterSync, beforeSync);
});
