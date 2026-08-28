import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFile, stat } from 'node:fs/promises';

type WorkerInput = Readonly<{
  codexHome: string;
  bundlePath: string;
  resultPath: string;
  mode?: 'barrier-before-import' | 'barrier-before-first-write' | 'pause-after-first-write' | 'mutate-before-postverify' | 'retarget-before-first-write';
  readyPath?: string;
  releasePath?: string;
}>;

const input = JSON.parse(
  Buffer.from(process.env.HAPPIER_CODEX_HANDOFF_WORKER_INPUT ?? '', 'base64').toString('utf8'),
) as WorkerInput;
const require = createRequire(import.meta.url);
const mutableFs = require('node:fs/promises') as typeof import('node:fs/promises');
const originalWriteFile = mutableFs.writeFile.bind(mutableFs);
const originalOpen = mutableFs.open.bind(mutableFs);
const bundle = JSON.parse(await readFile(input.bundlePath, 'utf8')) as unknown;
const targetPathSuffixes = (
  (bundle as { files?: readonly { relativePath?: unknown }[] }).files
    ?.flatMap((file) => typeof file.relativePath === 'string'
      ? [file.relativePath.replaceAll('\\', '/')]
      : []) ?? []
);

function isBundleTargetPath(path: unknown): boolean {
  const normalizedPath = String(path).replaceAll('\\', '/');
  return targetPathSuffixes.some((suffix) => normalizedPath.endsWith(`/${suffix}`));
}

if (input.mode === 'barrier-before-import' && input.readyPath && input.releasePath) {
  await originalWriteFile(input.readyPath, String(process.pid), 'utf8');
  while (!(await stat(input.releasePath).then(() => true, () => false))) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

if (input.mode !== undefined && input.mode !== 'barrier-before-import') {
  let exclusiveTargetOpenCount = 0;
  let mutated = false;
  mutableFs.open = (async (...args: Parameters<typeof mutableFs.open>) => {
    const [path, flags] = args;
    const isTarget = isBundleTargetPath(path);
    const isExclusiveTargetOpen = isTarget && flags === 'wx';
    if (isExclusiveTargetOpen) {
      exclusiveTargetOpenCount += 1;
    }
    if (
      isExclusiveTargetOpen
      && exclusiveTargetOpenCount === 1
      && (input.mode === 'barrier-before-first-write' || input.mode === 'retarget-before-first-write')
      && input.readyPath
      && input.releasePath
    ) {
      await originalWriteFile(input.readyPath, String(process.pid), 'utf8');
      while (!(await stat(input.releasePath).then(() => true, () => false))) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    if (
      isExclusiveTargetOpen
      && exclusiveTargetOpenCount === 2
      && input.mode === 'pause-after-first-write'
      && input.readyPath
    ) {
      await originalWriteFile(input.readyPath, String(process.pid), 'utf8');
      await new Promise<void>(() => {});
    }
    if (isTarget && flags === 'r' && input.mode === 'mutate-before-postverify' && !mutated) {
      mutated = true;
      await originalWriteFile(path, 'noncooperating-mutation\n');
    }
    return await originalOpen(...args);
  }) as typeof mutableFs.open;
  syncBuiltinESMExports();
}

let result: unknown;
try {
  const { importCodexSessionBundle } = await import('../import.js');
  const imported = await importCodexSessionBundle({
    bundle,
    targetPath: '/repo-target',
    env: { CODEX_HOME: input.codexHome },
  });
  result = {
    status: 'fulfilled',
    remoteSessionId: imported.remoteSessionId,
    ...(input.mode === 'retarget-before-first-write'
      ? { codexHome: imported.resume.environmentVariables.CODEX_HOME }
      : {}),
  };
} catch (error) {
  result = {
    status: 'rejected',
    code: (error as { code?: unknown } | null)?.code ?? null,
    message: error instanceof Error ? error.message : String(error),
  };
}

await originalWriteFile(input.resultPath, JSON.stringify(result), 'utf8');
process.exit(0);
