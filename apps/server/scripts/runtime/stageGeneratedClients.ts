import { cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function stageGeneratedClients({
  projectDir,
  destRoot,
}: Readonly<{ projectDir: string; destRoot: string }>): Promise<void> {
  const sourceRoot = resolve(projectDir, 'generated');
  const targetRoot = resolve(destRoot, 'generated');

  await mkdir(targetRoot, { recursive: true });
  await cp(join(sourceRoot, 'sqlite-client'), join(targetRoot, 'sqlite-client'), { recursive: true });
  await cp(join(sourceRoot, 'mysql-client'), join(targetRoot, 'mysql-client'), { recursive: true });
}
