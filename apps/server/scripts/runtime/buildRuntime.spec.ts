import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { buildServerRuntime } from './buildRuntime';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('buildServerRuntime', () => {
  it('emits full and light runtime entrypoints', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'happier-server-runtime-build-'));
    tempDirs.push(outDir);

    const result = await buildServerRuntime({ outDir });

    expect(result.entrypoints.full).toBe(join(outDir, 'main.js'));
    expect(result.entrypoints.light).toBe(join(outDir, 'main.light.js'));

    await expect(access(result.entrypoints.full, constants.R_OK)).resolves.toBeUndefined();
    await expect(access(result.entrypoints.light, constants.R_OK)).resolves.toBeUndefined();

    const full = await readFile(result.entrypoints.full, 'utf-8');
    const light = await readFile(result.entrypoints.light, 'utf-8');

    expect(full).toContain('HAPPIER_SERVER_FLAVOR');
    expect(light).toContain('HAPPIER_SERVER_FLAVOR');
  });

  it('leaves pino runtime loading to installed node_modules instead of bundling dynamic require shims', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'happier-server-runtime-build-pino-'));
    tempDirs.push(outDir);

    await buildServerRuntime({ outDir });

    const bundleFiles = (await readdir(outDir)).filter((entry) => entry.endsWith('.js'));
    const bundleText = (
      await Promise.all(bundleFiles.map(async (entry) => await readFile(join(outDir, entry), 'utf-8')))
    ).join('\n');

    expect(bundleText).not.toContain('Dynamic require of "node:os"');
    expect(bundleText).not.toContain('../../node_modules/pino/');
  });

  it('keeps @prisma/client external without bundling Prisma runtime shims or leaving named ESM imports', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'happier-server-runtime-build-prisma-'));
    tempDirs.push(outDir);

    await buildServerRuntime({ outDir });

    const bundleFiles = (await readdir(outDir)).filter((entry) => entry.endsWith('.js'));
    const bundleText = (
      await Promise.all(bundleFiles.map(async (entry) => await readFile(join(outDir, entry), 'utf-8')))
    ).join('\n');

    expect(bundleText).not.toContain('../../node_modules/@prisma/client/runtime/library.js');
    expect(bundleText).not.toContain('from "@prisma/client"');
    expect(bundleText).not.toMatch(/import\s*\{[^}]+\}\s*from\s*"@prisma\/client"/);
  });

  it('bundles privacy-kit so runtime ASN schema registration does not depend on vendored module graph layout', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'happier-server-runtime-build-privacy-kit-'));
    tempDirs.push(outDir);

    await buildServerRuntime({ outDir });

    const bundleFiles = (await readdir(outDir)).filter((entry) => entry.endsWith('.js'));
    const bundleText = (
      await Promise.all(bundleFiles.map(async (entry) => await readFile(join(outDir, entry), 'utf-8')))
    ).join('\n');

    expect(bundleText).not.toContain('from "privacy-kit"');
    expect(bundleText).not.toContain('Dynamic require of "node:crypto"');
    expect(bundleText).not.toContain('Dynamic require of "reflect-metadata"');
    expect(bundleText).not.toContain('../../node_modules/@cloudflare/voprf-ts/');
    expect(bundleText).not.toContain('../../node_modules/@peculiar/x509/');
  });
});
