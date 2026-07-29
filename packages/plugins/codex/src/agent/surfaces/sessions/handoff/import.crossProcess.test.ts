import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

type Bundle = Readonly<{
  agentId: 'codex';
  remoteSessionId: string;
  files: readonly Readonly<{
    relativePath: string;
    contentBase64: string;
  }>[];
}>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../../..');
const workerSourcePath = fileURLToPath(new URL('./__tests__/import.crossProcess.worker.ts', import.meta.url));
let workerBuildRoot: string;
let workerPath: string;
const activeChildren = new Set<ChildProcess>();

beforeAll(async () => {
  workerBuildRoot = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-worker-'));
  workerPath = join(workerBuildRoot, 'worker.mjs');
  await build({
    entryPoints: [workerSourcePath],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'silent',
  });
});

afterAll(async () => {
  await rm(workerBuildRoot, { recursive: true, force: true });
});

afterEach(() => {
  for (const child of activeChildren) {
    child.kill('SIGKILL');
  }
  activeChildren.clear();
});

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

async function waitForExit(child: ChildProcess, timeoutMs = 60_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting ${timeoutMs}ms for child process ${child.pid ?? 'unknown'}`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function spawnImport(input: Readonly<{
  root: string;
  name: string;
  codexHome: string;
  bundle: Bundle;
  mode?: 'barrier-before-import' | 'barrier-before-first-write' | 'pause-after-first-write' | 'mutate-before-postverify' | 'retarget-before-first-write';
  readyPath?: string;
  releasePath?: string;
}>): Promise<Readonly<{
  child: ChildProcess;
  resultPath: string;
}>> {
  const bundlePath = join(input.root, `${input.name}.bundle.json`);
  const resultPath = join(input.root, `${input.name}.result.json`);
  await writeFile(bundlePath, JSON.stringify(input.bundle), 'utf8');
  const workerInput = Buffer.from(JSON.stringify({
    codexHome: input.codexHome,
    bundlePath,
    resultPath,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.readyPath === undefined ? {} : { readyPath: input.readyPath }),
    ...(input.releasePath === undefined ? {} : { releasePath: input.releasePath }),
  }), 'utf8').toString('base64');
  const child = spawn(process.execPath, [workerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HAPPIER_CODEX_HANDOFF_WORKER_INPUT: workerInput,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  activeChildren.add(child);
  child.once('exit', () => {
    activeChildren.delete(child);
  });
  return { child, resultPath };
}

async function readWorkerResult(path: string): Promise<{
  status: string;
  code?: string;
  remoteSessionId?: string;
  codexHome?: string;
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    status: string;
    code?: string;
    remoteSessionId?: string;
    codexHome?: string;
  };
}

function divergentBundle(remoteSessionId: string, side: 'left' | 'right'): Bundle {
  const order = side === 'left' ? [0, 1] : [1, 0];
  return {
    agentId: 'codex',
    remoteSessionId,
    files: order.map((index) => ({
      relativePath: `sessions/2026/07/23/rollout-${index}-${remoteSessionId}.jsonl`,
      contentBase64: Buffer.from(`${side}-${index}\n`, 'utf8').toString('base64'),
    })),
  };
}

describe('codex handoff cross-process import exclusion', () => {
  it('admits exactly one divergent multi-file writer and never leaves a hybrid session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-process-race-'));
    const codexHome = join(root, 'codex-home');
    const releasePath = join(root, 'release');
    const leftReadyPath = join(root, 'left.ready');
    const rightReadyPath = join(root, 'right.ready');
    const remoteSessionId = 'thread_cross_process';
    const leftBundle = divergentBundle(remoteSessionId, 'left');
    const rightBundle = divergentBundle(remoteSessionId, 'right');
    const left = await spawnImport({
      root,
      name: 'left',
      codexHome,
      bundle: leftBundle,
      mode: 'barrier-before-first-write',
      readyPath: leftReadyPath,
      releasePath,
    });
    await waitForPath(leftReadyPath);
    const right = await spawnImport({
      root,
      name: 'right',
      codexHome,
      bundle: rightBundle,
      mode: 'barrier-before-first-write',
      readyPath: rightReadyPath,
      releasePath,
    });

    try {
      await Promise.race([
        waitForPath(rightReadyPath),
        new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 3_000)),
      ]);
      const rightEnteredBeforeOwnerRelease = await pathExists(rightReadyPath);
      await writeFile(releasePath, 'go', 'utf8');
      expect(await Promise.all([waitForExit(left.child), waitForExit(right.child)])).toEqual([0, 0]);

      const results = await Promise.all([left.resultPath, right.resultPath].map(readWorkerResult));
      expect(rightEnteredBeforeOwnerRelease, JSON.stringify(results)).toBe(false);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
        JSON.stringify(results),
      ).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        code: 'target_identity_conflict',
      });

      const persisted = await Promise.all([0, 1].map(async (index) => (
        await readFile(join(
          codexHome,
          `sessions/2026/07/23/rollout-${index}-${remoteSessionId}.jsonl`,
        ), 'utf8')
      )));
      expect(persisted).toSatisfy((contents: readonly string[]) => (
        contents.every((content) => content.startsWith('left-'))
        || contents.every((content) => content.startsWith('right-'))
      ));
    } finally {
      left.child.kill('SIGKILL');
      right.child.kill('SIGKILL');
    }
  }, 120_000);

  it('reclaims a crashed pre-mutation owner and permits an identical replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-process-reclaim-'));
    const codexHome = join(root, 'codex-home');
    const readyPath = join(root, 'owner.ready');
    const releasePath = join(root, 'never-release');
    const bundle = divergentBundle('thread_reclaim', 'left');
    const crashed = await spawnImport({
      root,
      name: 'crashed',
      codexHome,
      bundle,
      mode: 'barrier-before-first-write',
      readyPath,
      releasePath,
    });
    await waitForPath(readyPath);
    crashed.child.kill('SIGKILL');
    await waitForExit(crashed.child);

    const resumed = await spawnImport({
      root,
      name: 'resumed',
      codexHome,
      bundle,
    });
    expect(await waitForExit(resumed.child)).toBe(0);
    expect(await readWorkerResult(resumed.resultPath)).toMatchObject({ status: 'fulfilled' });

    const replayed = await spawnImport({
      root,
      name: 'replayed',
      codexHome,
      bundle,
    });
    expect(await waitForExit(replayed.child)).toBe(0);
    expect(await readWorkerResult(replayed.resultPath)).toMatchObject({ status: 'fulfilled' });
  }, 120_000);

  it('detects a noncooperating mutation during final verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-process-postverify-'));
    const codexHome = join(root, 'codex-home');
    const bundle = divergentBundle('thread_postverify', 'left');
    const worker = await spawnImport({
      root,
      name: 'mutated',
      codexHome,
      bundle,
      mode: 'mutate-before-postverify',
    });
    expect(await waitForExit(worker.child)).toBe(0);
    expect(await readWorkerResult(worker.resultPath)).toMatchObject({
      status: 'rejected',
      code: 'target_identity_conflict',
    });
  }, 90_000);

  it('fails a divergent partial replay before adding the missing file, then completes an identical replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-process-partial-'));
    const codexHome = join(root, 'codex-home');
    const readyPath = join(root, 'partial.ready');
    const remoteSessionId = 'thread_partial';
    const originalBundle = divergentBundle(remoteSessionId, 'left');
    const crashed = await spawnImport({
      root,
      name: 'partial',
      codexHome,
      bundle: originalBundle,
      mode: 'pause-after-first-write',
      readyPath,
    });
    await waitForPath(readyPath);
    crashed.child.kill('SIGKILL');
    await waitForExit(crashed.child);

    const divergent = await spawnImport({
      root,
      name: 'divergent',
      codexHome,
      bundle: divergentBundle(remoteSessionId, 'right'),
    });
    expect(await waitForExit(divergent.child)).toBe(0);
    expect(await readWorkerResult(divergent.resultPath)).toMatchObject({
      status: 'rejected',
      code: 'target_identity_conflict',
    });
    const missingPath = join(
      codexHome,
      `sessions/2026/07/23/rollout-1-${remoteSessionId}.jsonl`,
    );
    await expect(access(missingPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const identical = await spawnImport({
      root,
      name: 'identical',
      codexHome,
      bundle: originalBundle,
    });
    expect(await waitForExit(identical.child)).toBe(0);
    expect(await readWorkerResult(identical.resultPath)).toMatchObject({ status: 'fulfilled' });
    await expect(readFile(missingPath, 'utf8')).resolves.toBe('left-1\n');
  }, 120_000);

  it('serializes lexical aliases of the same physical CODEX_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-process-alias-'));
    const codexHome = join(root, 'codex-home');
    const codexHomeAlias = join(root, 'codex-home-alias');
    await mkdir(codexHome);
    await symlink(codexHome, codexHomeAlias, 'dir');
    const ownerReadyPath = join(root, 'owner.ready');
    const contenderReadyPath = join(root, 'contender.ready');
    const releasePath = join(root, 'release');
    const remoteSessionId = 'thread_alias';
    const owner = await spawnImport({
      root,
      name: 'owner',
      codexHome,
      bundle: divergentBundle(remoteSessionId, 'left'),
      mode: 'barrier-before-first-write',
      readyPath: ownerReadyPath,
      releasePath,
    });
    await waitForPath(ownerReadyPath);
    const contender = await spawnImport({
      root,
      name: 'contender',
      codexHome: codexHomeAlias,
      bundle: divergentBundle(remoteSessionId, 'right'),
      mode: 'barrier-before-first-write',
      readyPath: contenderReadyPath,
      releasePath,
    });

    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 300));
    expect(await pathExists(contenderReadyPath)).toBe(false);
    await writeFile(releasePath, 'go', 'utf8');
    expect(await waitForExit(owner.child)).toBe(0);
    expect(await waitForExit(contender.child)).toBe(0);
    expect(await readWorkerResult(owner.resultPath)).toMatchObject({ status: 'fulfilled' });
    expect(await readWorkerResult(contender.resultPath)).toMatchObject({
      status: 'rejected',
      code: 'target_identity_conflict',
    });
  }, 120_000);

  it('keeps native reads and writes bound to the physical CODEX_HOME captured for the lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-process-retarget-'));
    const physicalHomeA = join(root, 'codex-home-a');
    const physicalHomeB = join(root, 'codex-home-b');
    const codexHomeAlias = join(root, 'codex-home-current');
    await Promise.all([mkdir(physicalHomeA), mkdir(physicalHomeB)]);
    await mkdir(join(physicalHomeB, 'sessions/2026/07/23'), { recursive: true });
    await symlink(physicalHomeA, codexHomeAlias, 'dir');
    const readyPath = join(root, 'owner.ready');
    const releasePath = join(root, 'release');
    const remoteSessionId = 'thread_retarget';
    const bundle = divergentBundle(remoteSessionId, 'left');
    const owner = await spawnImport({
      root,
      name: 'owner',
      codexHome: codexHomeAlias,
      bundle,
      mode: 'retarget-before-first-write',
      readyPath,
      releasePath,
    });

    await waitForPath(readyPath);
    await unlink(codexHomeAlias);
    await symlink(physicalHomeB, codexHomeAlias, 'dir');
    await writeFile(releasePath, 'go', 'utf8');
    expect(await waitForExit(owner.child)).toBe(0);
    expect(await readWorkerResult(owner.resultPath)).toMatchObject({
      status: 'fulfilled',
      remoteSessionId,
      codexHome: codexHomeAlias,
    });

    await expect(readFile(
      join(physicalHomeA, `sessions/2026/07/23/rollout-0-${remoteSessionId}.jsonl`),
      'utf8',
    )).resolves.toBe('left-0\n');
    await expect(access(
      join(physicalHomeB, `sessions/2026/07/23/rollout-0-${remoteSessionId}.jsonl`),
    )).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('allows unrelated physical homes and remote session ids to make progress independently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-handoff-process-independent-'));
    const releasePath = join(root, 'release');
    const cases = [
      {
        name: 'home-a',
        codexHome: join(root, 'codex-home-a'),
        bundle: divergentBundle('thread_same', 'left'),
      },
      {
        name: 'home-b',
        codexHome: join(root, 'codex-home-b'),
        bundle: divergentBundle('thread_same', 'right'),
      },
      {
        name: 'id-a',
        codexHome: join(root, 'codex-home-shared'),
        bundle: divergentBundle('thread_id_a', 'left'),
      },
      {
        name: 'id-b',
        codexHome: join(root, 'codex-home-shared'),
        bundle: divergentBundle('thread_id_b', 'right'),
      },
    ];
    const workers = await Promise.all(cases.map(async (entry) => {
      const readyPath = join(root, `${entry.name}.ready`);
      return {
        readyPath,
        ...(await spawnImport({
          root,
          ...entry,
          mode: 'barrier-before-first-write',
          readyPath,
          releasePath,
        })),
      };
    }));

    await Promise.all(workers.map((worker) => waitForPath(worker.readyPath)));
    await writeFile(releasePath, 'go', 'utf8');
    expect(await Promise.all(workers.map((worker) => waitForExit(worker.child)))).toEqual([0, 0, 0, 0]);
    expect(await Promise.all(workers.map((worker) => readWorkerResult(worker.resultPath))))
      .toEqual([
        { status: 'fulfilled', remoteSessionId: 'thread_same' },
        { status: 'fulfilled', remoteSessionId: 'thread_same' },
        { status: 'fulfilled', remoteSessionId: 'thread_id_a' },
        { status: 'fulfilled', remoteSessionId: 'thread_id_b' },
      ]);
  }, 120_000);
});
