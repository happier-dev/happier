import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createServerLightTemplateCacheKey, prepareCachedDataDir } from './serverLightTemplateCache';

describe('serverLightTemplateCache', () => {
  it('builds the template once and reuses it for later targets', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-server-light-template-cache-'));
    const cacheRootDir = resolve(rootDir, 'cache');
    const targetOne = resolve(rootDir, 'target-one');
    const targetTwo = resolve(rootDir, 'target-two');
    let buildCount = 0;

    const buildTemplateInto = async (templateDataDir: string) => {
      buildCount += 1;
      mkdirSync(templateDataDir, { recursive: true });
      writeFileSync(resolve(templateDataDir, 'seed.txt'), `seed-${buildCount}\n`, 'utf8');
    };

    const first = await prepareCachedDataDir({
      cacheRootDir,
      templateKey: 'sqlite-seed',
      targetDir: targetOne,
      buildTemplateInto,
    });
    const second = await prepareCachedDataDir({
      cacheRootDir,
      templateKey: 'sqlite-seed',
      targetDir: targetTwo,
      buildTemplateInto,
    });

    expect(buildCount).toBe(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(resolve(first.cacheEntryDir)).toBe(resolve(second.cacheEntryDir));
  });

  it('deduplicates concurrent builds for the same cache key', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-server-light-template-cache-'));
    const cacheRootDir = resolve(rootDir, 'cache');
    let buildCount = 0;

    const buildTemplateInto = async (templateDataDir: string) => {
      buildCount += 1;
      mkdirSync(templateDataDir, { recursive: true });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      writeFileSync(resolve(templateDataDir, 'seed.txt'), 'seed\n', 'utf8');
    };

    await Promise.all([
      prepareCachedDataDir({
        cacheRootDir,
        templateKey: 'pglite-seed',
        targetDir: resolve(rootDir, 'target-one'),
        buildTemplateInto,
      }),
      prepareCachedDataDir({
        cacheRootDir,
        templateKey: 'pglite-seed',
        targetDir: resolve(rootDir, 'target-two'),
        buildTemplateInto,
      }),
    ]);

    expect(buildCount).toBe(1);
  });

  it('changes the cache key when migration contents change', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'happier-server-light-template-key-'));
    mkdirSync(resolve(rootDir, 'apps', 'server', 'prisma', 'sqlite'), { recursive: true });
    mkdirSync(resolve(rootDir, 'apps', 'server', 'prisma', 'migrations', '20260101000000_initial'), { recursive: true });
    writeFileSync(resolve(rootDir, 'apps', 'server', 'prisma', 'sqlite', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf8');
    writeFileSync(resolve(rootDir, 'apps', 'server', 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }\n', 'utf8');
    writeFileSync(resolve(rootDir, 'apps', 'server', 'prisma', 'migrations', '20260101000000_initial', 'migration.sql'), 'create table test (id text);\n', 'utf8');

    const before = await createServerLightTemplateCacheKey({ rootDir, provider: 'sqlite' });
    writeFileSync(resolve(rootDir, 'apps', 'server', 'prisma', 'migrations', '20260101000000_initial', 'migration.sql'), 'create table test (id text, name text);\n', 'utf8');
    const after = await createServerLightTemplateCacheKey({ rootDir, provider: 'sqlite' });

    expect(before).not.toBe(after);
  });
});
