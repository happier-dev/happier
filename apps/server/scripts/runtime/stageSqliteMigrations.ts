import { cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function stageSqliteMigrations({
  projectDir,
  destRoot,
}: Readonly<{ projectDir: string; destRoot: string }>): Promise<void> {
  const sourceDir = resolve(projectDir, 'prisma', 'sqlite', 'migrations');
  const targetDir = resolve(destRoot, 'prisma', 'sqlite', 'migrations');

  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
}
