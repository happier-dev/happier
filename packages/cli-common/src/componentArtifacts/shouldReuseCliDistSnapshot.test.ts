import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { shouldReuseCliDistSnapshot } from './shouldReuseCliDistSnapshot.js';
import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-dist-reuse-'));
  tempDirs.push(dir);
  return dir;
}
async function writeTimedFile(path: string, content: string, timestamp: Date): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
  await utimes(path, timestamp, timestamp);
}

describe('shouldReuseCliDistSnapshot', () => {
  it('reuses QA typecheck diagnostics only in QA mode, including release-forced strict mode', async () => {
    const rootDir = await createTempDir();
    const entrypoint = join(rootDir, 'dist', 'index.mjs');
    await writeTimedFile(entrypoint, 'export const runtime = 42;\n', new Date());
    cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, {
      inputFingerprint: 'a'.repeat(64),
      stalePackages: [{ packageName: '@happier-dev/cli', reason: 'typecheck', diagnosticSummary: 'src/index.ts(1,1): error TS2322: fixture', errorCount: 1, files: ['src/index.ts'] }],
    });
    const params = { distEntrypointPath: entrypoint, requiredInputFingerprint: 'a'.repeat(64) };
    await expect(shouldReuseCliDistSnapshot({ ...params, env: { HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime' } })).resolves.toBe(true);
    await expect(shouldReuseCliDistSnapshot({ ...params, env: {} })).resolves.toBe(false);
    await expect(shouldReuseCliDistSnapshot({ ...params, env: { HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime', npm_lifecycle_event: 'prepack' } })).resolves.toBe(false);
  });
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }));
  });

  it('returns false when the CLI dist entrypoint is missing', async () => {
    const rootDir = await createTempDir();
    const distEntrypointPath = join(rootDir, 'apps', 'cli', 'dist', 'index.mjs');

    await expect(shouldReuseCliDistSnapshot({
      distEntrypointPath,
      requiredInputFingerprint: 'a'.repeat(64),
    })).resolves.toBe(false);
  });

  it('does not reuse a dist without a required input identity even when timestamps look current', async () => {
    const rootDir = await createTempDir();
    const older = new Date('2026-04-13T18:00:00.000Z');
    const newer = new Date('2026-04-13T18:05:00.000Z');
    const distEntrypointPath = join(rootDir, 'apps', 'cli', 'dist', 'index.mjs');
    const cliSourceFile = join(rootDir, 'apps', 'cli', 'src', 'index.ts');
    const workspaceDistFile = join(rootDir, 'packages', 'cli-common', 'dist', 'firstPartyRuntime', 'index.js');

    await writeTimedFile(cliSourceFile, 'export default "src";\n', older);
    await writeTimedFile(workspaceDistFile, 'export default "workspace";\n', older);
    await writeTimedFile(distEntrypointPath, 'export default "cli";\n', newer);
    cliDistBuildManifest.writeCliDistBuildManifest(distEntrypointPath, {
      inputFingerprint: 'a'.repeat(64),
    });

    await expect(shouldReuseCliDistSnapshot({
      distEntrypointPath,
    })).resolves.toBe(false);
  });

  it('reuses only the exact dist closure whose manifest binds the candidate-verified input fingerprint', async () => {
    const rootDir = await createTempDir();
    const older = new Date('2026-04-13T18:00:00.000Z');
    const newer = new Date('2026-04-13T18:05:00.000Z');
    const distEntrypointPath = join(rootDir, 'apps', 'cli', 'dist', 'index.mjs');
    const cliSourceFile = join(rootDir, 'apps', 'cli', 'src', 'index.ts');
    const inputFingerprint = 'a'.repeat(64);

    await writeTimedFile(cliSourceFile, 'export default "src";\n', newer);
    await writeTimedFile(distEntrypointPath, 'export default "cli";\n', older);
    cliDistBuildManifest.writeCliDistBuildManifest(distEntrypointPath, {
      inputFingerprint,
    });

    await expect(shouldReuseCliDistSnapshot({
      distEntrypointPath,
      requiredInputFingerprint: inputFingerprint,
    })).resolves.toBe(true);
    await expect(shouldReuseCliDistSnapshot({
      distEntrypointPath,
      requiredInputFingerprint: 'b'.repeat(64),
    })).resolves.toBe(false);
  });
});
