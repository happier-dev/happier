import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join, relative, resolve } from 'node:path';

type PrepareCachedDataDirParams = {
  cacheRootDir: string;
  templateKey: string;
  targetDir: string;
  buildTemplateInto: (templateDataDir: string) => Promise<void>;
};

type PrepareCachedDataDirResult = {
  cacheEntryDir: string;
  cacheHit: boolean;
};

const READY_MARKER_FILE = 'ready.json';
const TEMPLATE_DATA_DIR = 'data';

const activeTemplateBuilds = new Map<string, Promise<void>>();

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureCacheEntryReady(params: {
  cacheEntryDir: string;
  buildTemplateInto: (templateDataDir: string) => Promise<void>;
}): Promise<void> {
  const readyMarkerPath = resolve(params.cacheEntryDir, READY_MARKER_FILE);
  if (await pathExists(readyMarkerPath)) {
    return;
  }

  const existingBuild = activeTemplateBuilds.get(params.cacheEntryDir);
  if (existingBuild) {
    await existingBuild;
    return;
  }

  const buildPromise = (async () => {
    await mkdir(params.cacheEntryDir, { recursive: true });
    const tempEntryDir = resolve(params.cacheEntryDir, '..', `${basename(params.cacheEntryDir) || 'template'}-tmp-${process.pid}-${randomUUID()}`);
    const tempDataDir = resolve(tempEntryDir, TEMPLATE_DATA_DIR);

    await rm(tempEntryDir, { recursive: true, force: true });
    await mkdir(tempDataDir, { recursive: true });

    try {
      await params.buildTemplateInto(tempDataDir);
      await writeFile(resolve(tempEntryDir, READY_MARKER_FILE), JSON.stringify({ createdAt: new Date().toISOString() }) + '\n', 'utf8');
      try {
        await rename(tempEntryDir, params.cacheEntryDir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') {
          throw error;
        }
      }

      if (!(await pathExists(readyMarkerPath))) {
        throw new Error(`Server-light template cache entry is missing ready marker: ${params.cacheEntryDir}`);
      }
    } finally {
      await rm(tempEntryDir, { recursive: true, force: true });
    }
  })();

  activeTemplateBuilds.set(params.cacheEntryDir, buildPromise);
  try {
    await buildPromise;
  } finally {
    activeTemplateBuilds.delete(params.cacheEntryDir);
  }
}

export async function prepareCachedDataDir(params: PrepareCachedDataDirParams): Promise<PrepareCachedDataDirResult> {
  const cacheEntryDir = resolve(params.cacheRootDir, params.templateKey);
  const readyMarkerPath = resolve(cacheEntryDir, READY_MARKER_FILE);
  const cacheHit = await pathExists(readyMarkerPath);

  await ensureCacheEntryReady({
    cacheEntryDir,
    buildTemplateInto: params.buildTemplateInto,
  });

  await rm(params.targetDir, { recursive: true, force: true });
  await mkdir(params.targetDir, { recursive: true });
  await cp(resolve(cacheEntryDir, TEMPLATE_DATA_DIR), params.targetDir, { recursive: true, force: true });

  return { cacheEntryDir, cacheHit };
}

async function listRelativeFilePaths(rootDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absPath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      out.push(relative(rootDir, absPath));
    }
  }

  await walk(rootDir);
  return out;
}

export async function createServerLightTemplateCacheKey(params: {
  rootDir: string;
  provider: 'sqlite' | 'pglite';
}): Promise<string> {
  const prismaDir = resolve(params.rootDir, 'apps', 'server', 'prisma');
  const schemaPath = params.provider === 'sqlite'
    ? resolve(prismaDir, 'sqlite', 'schema.prisma')
    : resolve(prismaDir, 'schema.prisma');
  const migrationsDir = resolve(prismaDir, 'migrations');
  const hash = createHash('sha256');

  hash.update(`provider:${params.provider}\n`);
  hash.update(`schema:${await readFile(schemaPath, 'utf8')}\n`);

  for (const relativePath of await listRelativeFilePaths(migrationsDir)) {
    hash.update(`file:${relativePath}\n`);
    hash.update(await readFile(join(migrationsDir, relativePath), 'utf8'));
    hash.update('\n');
  }

  return `${params.provider}-${hash.digest('hex').slice(0, 16)}`;
}
