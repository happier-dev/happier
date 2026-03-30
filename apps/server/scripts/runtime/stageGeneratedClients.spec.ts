import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { stageGeneratedClients } from './stageGeneratedClients';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('stageGeneratedClients', () => {
  it('copies sqlite and mysql generated clients into the runtime payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-server-generated-stage-'));
    tempDirs.push(root);

    const sourceRoot = join(root, 'source');
    const destRoot = join(root, 'dest');
    await mkdir(join(sourceRoot, 'generated', 'sqlite-client'), { recursive: true });
    await mkdir(join(sourceRoot, 'generated', 'mysql-client'), { recursive: true });
    await writeFile(join(sourceRoot, 'generated', 'sqlite-client', 'index.js'), 'export const sqlite = true;\n', 'utf-8');
    await writeFile(join(sourceRoot, 'generated', 'mysql-client', 'index.js'), 'export const mysql = true;\n', 'utf-8');

    await stageGeneratedClients({ projectDir: sourceRoot, destRoot });

    await expect(readFile(join(destRoot, 'generated', 'sqlite-client', 'index.js'), 'utf-8')).resolves.toContain('sqlite');
    await expect(readFile(join(destRoot, 'generated', 'mysql-client', 'index.js'), 'utf-8')).resolves.toContain('mysql');
  });
});
