import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

type FsModule = Readonly<{
  withExclusiveFileLock<TResult>(
    input: Readonly<{
      lockPath: string;
      timeoutMs: number;
    }>,
    effect: () => Promise<TResult>,
  ): Promise<TResult>;
  writeAtomicJsonFile(input: Readonly<{
    path: string;
    value: unknown;
    mode?: number;
    temporaryDirectory?: string | null;
  }>): Promise<void>;
  writeAtomicFile(input: Readonly<{
    path: string;
    contents: string | Uint8Array;
    mode?: number;
    temporaryDirectory?: string | null;
  }>): Promise<void>;
  writeAtomicTextFileIfChanged(input: Readonly<{
    path: string;
    contents: string;
    mode?: number;
    temporaryDirectory?: string | null;
  }>): Promise<boolean>;
}>;

async function loadFs(): Promise<FsModule> {
  const loaded = await import('./fs.js').catch((error: unknown) => error);
  expect(loaded).not.toBeInstanceOf(Error);
  return loaded as FsModule;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function spawnExclusiveLockWorker(input: Readonly<{
  lockPath: string;
  enteredPath: string;
  releasePath?: string;
  timeoutMs: number;
}>): ReturnType<typeof spawn> {
  const source = `
import { stat, writeFile } from 'node:fs/promises';
import { withExclusiveFileLock } from '@happier-dev/plugin-sdk/fs';
await withExclusiveFileLock({
  lockPath: process.env.HAPPIER_TEST_LOCK_PATH,
  timeoutMs: Number(process.env.HAPPIER_TEST_TIMEOUT_MS),
}, async () => {
  await writeFile(process.env.HAPPIER_TEST_ENTERED_PATH, 'entered', 'utf8');
  const releasePath = process.env.HAPPIER_TEST_RELEASE_PATH;
  while (releasePath && !(await stat(releasePath).then(() => true, () => false))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});
`;
  return spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      HAPPIER_TEST_LOCK_PATH: input.lockPath,
      HAPPIER_TEST_ENTERED_PATH: input.enteredPath,
      HAPPIER_TEST_TIMEOUT_MS: String(input.timeoutMs),
      ...(input.releasePath === undefined ? {} : {
        HAPPIER_TEST_RELEASE_PATH: input.releasePath,
      }),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
}

describe('fs helpers', () => {
  it('does not retain the dormant predecessor filesystem service declarations', () => {
    const source = readFileSync(new URL('./fs.ts', import.meta.url), 'utf8');

    for (const predecessorDeclaration of [
      'FsCreateTempDirectoryInputV1',
      'FsEntryV1',
      'FsPathInputV1',
      'FsRuntimeServiceV1',
      'FsScopedPathListDiagnosticCodeV1',
      'FsScopedPathListDiagnosticV1',
      'FsScopedPathListFileInputV1',
      'FsScopedPathListFileResultV1',
      'FsStatV1',
      'FsTempDirectoryV1',
      'FsTempTextFileInputV1',
      'FsWriteTextInputV1',
    ]) {
      expect(source, predecessorDeclaration).not.toContain(predecessorDeclaration);
    }
  });

  it('publishes the canonical fs subpath', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports).toHaveProperty('./fs', {
      types: './dist/fs/index.d.ts',
      default: './dist/fs/index.js',
    });
  });

  it('projects the canonical environment-aware home resolver through the daemon fs subpath', async () => {
    const fs = await import('./fs/index.js') as Readonly<{
      resolveHomeDirFromEnvironment(
        env: NodeJS.ProcessEnv,
        platform?: NodeJS.Platform,
      ): string;
    }>;

    expect(fs.resolveHomeDirFromEnvironment({
      HOME: '/home/alice',
      USERPROFILE: 'C:\\Users\\alice',
    }, 'win32')).toBe('C:\\Users\\alice');
  });

  it('expands either home separator spelling with target-platform separators', async () => {
    const fs = await import('./fs/index.js') as Readonly<{
      expandHomePath(raw: string, homeDir: string, platform: NodeJS.Platform): string;
    }>;

    expect(fs.expandHomePath('~\\tools/bash', '/home/alice', 'linux'))
      .toBe('/home/alice/tools/bash');
    expect(fs.expandHomePath('~/tools\\bash.exe', 'C:\\Users\\alice', 'win32'))
      .toBe('C:\\Users\\alice\\tools\\bash.exe');
  });

  it('projects the canonical cross-platform containment decision through the daemon fs subpath', async () => {
    const fs = await import('./fs/index.js') as Readonly<{
      isCanonicalAbsolutePathInsideRoot(root: string, candidate: string): boolean;
    }>;

    expect(fs.isCanonicalAbsolutePathInsideRoot(
      'C:\\Users\\alice\\plugin',
      'c:/users/alice/plugin\\..build/output.js',
    )).toBe(true);
    expect(fs.isCanonicalAbsolutePathInsideRoot(
      'C:\\Users\\alice\\plugin',
      'C:\\Users\\alice\\plugin-sibling\\output.js',
    )).toBe(false);
  });

  it('keeps exact-owner compatibility controls out of the author-facing fs module', async () => {
    const fs = await loadFs();

    expect(fs).not.toHaveProperty('withJsonOwnerFileLock');
    expect(fs).not.toHaveProperty('reclaimJsonOwnerFileLockSnapshot');
  });

  it('atomically publishes JSON through a temporary sibling file', async () => {
    const fs = await loadFs();
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-fs-'));
    const path = join(root, 'nested', 'auth.json');

    await fs.writeAtomicJsonFile({
      path,
      value: { token: 'new-token' },
      mode: 0o600,
    });

    expect(await readFile(path, 'utf8')).toBe('{\n  "token": "new-token"\n}\n');
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(dirname(path)));
    expect(entries).toEqual(['auth.json']);
  });

  it('atomically preserves arbitrary binary file bytes', async () => {
    const fs = await loadFs();
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-fs-binary-'));
    const path = join(root, 'nested', 'credential.bin');
    const contents = Uint8Array.from([0, 255, 195, 40, 10, 128]);

    await fs.writeAtomicFile({ path, contents, mode: 0o600 });

    expect(await readFile(path)).toEqual(Buffer.from(contents));
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(dirname(path)));
    expect(entries).toEqual(['credential.bin']);
  });

  it('atomically publishes generated text only when its bytes change', async () => {
    const fs = await loadFs();
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-fs-text-'));
    const path = join(root, 'nested', 'extension.js');

    expect(await fs.writeAtomicTextFileIfChanged({
      path,
      contents: 'export default {}\n',
      mode: 0o600,
    })).toBe(true);
    expect(await fs.writeAtomicTextFileIfChanged({
      path,
      contents: 'export default {}\n',
      mode: 0o600,
    })).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('export default {}\n');
  });

  it('excludes a second process and preserves a successor lock during exact-owner release', async () => {
    const fs = await loadFs();
    expect(typeof fs.withExclusiveFileLock).toBe('function');
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-exclusive-lock-'));
    const lockPath = join(root, 'handoff.lock');
    const ownerEnteredPath = join(root, 'owner-entered');
    const ownerReleasePath = join(root, 'owner-release');
    const successorEnteredPath = join(root, 'successor-entered');
    const successorReleasePath = join(root, 'successor-release');
    const probeEnteredPath = join(root, 'probe-entered');
    let owner: ReturnType<typeof spawn> | null = null;
    let successor: ReturnType<typeof spawn> | null = null;
    let probe: ReturnType<typeof spawn> | null = null;
    try {
      owner = spawnExclusiveLockWorker({
        lockPath,
        enteredPath: ownerEnteredPath,
        releasePath: ownerReleasePath,
        timeoutMs: 5_000,
      });
      await waitForFile(ownerEnteredPath);

      successor = spawnExclusiveLockWorker({
        lockPath,
        enteredPath: successorEnteredPath,
        releasePath: successorReleasePath,
        timeoutMs: 5_000,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(await stat(successorEnteredPath).then(() => true, () => false)).toBe(false);

      // Simulate an external successor replacing the canonical path while the first owner is held.
      // Exact-owner release must not unlink the successor's independently acquired lock.
      await unlink(lockPath);
      await waitForFile(successorEnteredPath);
      await writeFile(ownerReleasePath, 'release', 'utf8');
      expect(await waitForChild(owner)).toBe(0);

      probe = spawnExclusiveLockWorker({
        lockPath,
        enteredPath: probeEnteredPath,
        timeoutMs: 150,
      });
      expect(await waitForChild(probe)).not.toBe(0);
      expect(await stat(probeEnteredPath).then(() => true, () => false)).toBe(false);

      await writeFile(successorReleasePath, 'release', 'utf8');
      expect(await waitForChild(successor)).toBe(0);
    } finally {
      owner?.kill('SIGKILL');
      successor?.kill('SIGKILL');
      probe?.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('leaves an existing destination intact when the temp write cannot publish', async () => {
    const fs = await loadFs();
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-fs-fail-'));
    const path = join(root, 'auth.json');
    const blockedTmpDir = join(root, 'not-a-directory');
    await writeFile(path, '{"token":"old"}\n', 'utf8');
    await writeFile(blockedTmpDir, 'file blocks temp dir creation', 'utf8');

    await expect(fs.writeAtomicJsonFile({
      path,
      value: { token: 'new' },
      temporaryDirectory: join(blockedTmpDir, 'child'),
    })).rejects.toThrow();

    expect(await readFile(path, 'utf8')).toBe('{"token":"old"}\n');
  });

  it('creates destination parents before publishing', async () => {
    const fs = await loadFs();
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-fs-parent-'));
    const path = join(root, 'a', 'b', 'payload.json');

    await mkdir(root, { recursive: true });
    await fs.writeAtomicJsonFile({ path, value: { ok: true } });

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ ok: true });
  });

  it('rejects values that cannot be represented as a JSON document', async () => {
    const fs = await loadFs();
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-fs-json-'));
    const path = join(root, 'payload.json');

    await expect(fs.writeAtomicJsonFile({ path, value: undefined })).rejects.toThrow(TypeError);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });
});
