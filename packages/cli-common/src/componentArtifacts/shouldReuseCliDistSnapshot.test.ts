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
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }));
  });

  it('returns false when a bundled workspace dist is newer than the cli dist entrypoint', async () => {
    const rootDir = await createTempDir();
    const older = new Date('2026-04-13T18:00:00.000Z');
    const newer = new Date('2026-04-13T18:05:00.000Z');
    const distEntrypointPath = join(rootDir, 'apps', 'cli', 'dist', 'index.mjs');
    const workspaceDistFile = join(rootDir, 'packages', 'cli-common', 'dist', 'firstPartyRuntime', 'index.js');

    await writeTimedFile(distEntrypointPath, 'export default "cli";\n', older);
    await writeTimedFile(workspaceDistFile, 'export default "workspace";\n', newer);

    await expect(shouldReuseCliDistSnapshot({
      distEntrypointPath,
      inputPaths: [join(rootDir, 'packages', 'cli-common', 'dist')],
    })).resolves.toBe(false);
  });

  it('keeps legacy mtime-only reuse for non-candidate callers even when the dist manifest identifies another source closure', async () => {
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
      inputPaths: [
        join(rootDir, 'apps', 'cli', 'src'),
        join(rootDir, 'packages', 'cli-common', 'dist'),
      ],
    })).resolves.toBe(true);
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
      inputPaths: [join(rootDir, 'apps', 'cli', 'src')],
      requiredInputFingerprint: inputFingerprint,
    })).resolves.toBe(true);
    await expect(shouldReuseCliDistSnapshot({
      distEntrypointPath,
      inputPaths: [join(rootDir, 'apps', 'cli', 'src')],
      requiredInputFingerprint: 'b'.repeat(64),
    })).resolves.toBe(false);
  });
});
