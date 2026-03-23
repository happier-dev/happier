import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createTempFixture } from './temp_fixture.mjs';

export async function ensureMinimalMonorepoLayout(
  rootDir,
  { includeServerPrisma = false, writeGitDirMarker = false } = {},
) {
  const uiDir = join(rootDir, 'apps', 'ui');
  const cliDir = join(rootDir, 'apps', 'cli');
  const serverDir = join(rootDir, 'apps', 'server');

  await mkdir(uiDir, { recursive: true });
  await mkdir(cliDir, { recursive: true });
  await mkdir(serverDir, { recursive: true });
  await writeFile(join(uiDir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(serverDir, 'package.json'), '{}\n', 'utf-8');

  if (writeGitDirMarker) {
    await writeFile(join(rootDir, '.git'), 'gitdir: dummy\n', 'utf-8');
  }

  if (includeServerPrisma) {
    await mkdir(join(serverDir, 'prisma', 'sqlite'), { recursive: true });
    await writeFile(join(serverDir, 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }\n', 'utf-8');
    await writeFile(
      join(serverDir, 'prisma', 'sqlite', 'schema.prisma'),
      'datasource db { provider = "sqlite" }\n',
      'utf-8',
    );
  }

  return { uiDir, cliDir, serverDir };
}

export async function createMinimalMonorepoFixture(
  t,
  { prefix = 'hstack-minimal-monorepo-', includeServerPrisma = false, writeGitDirMarker = false } = {},
) {
  const fixture = await createTempFixture(t, { prefix });
  const dirs = await ensureMinimalMonorepoLayout(fixture.root, {
    includeServerPrisma,
    writeGitDirMarker,
  });
  return {
    ...fixture,
    ...dirs,
    dir: fixture.root,
    monoRoot: fixture.root,
    rootDir: fixture.root,
  };
}
