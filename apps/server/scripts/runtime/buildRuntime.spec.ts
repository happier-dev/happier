import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { buildServerRuntime, bundleServerRuntimeEntrypoints } from './buildRuntime';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('buildServerRuntime', () => {
  it('stamps public guest CLI selection into both published runtime entrypoints', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-server-runtime-identity-'));
    tempDirs.push(projectDir);
    await mkdir(join(projectDir, 'sources'));
    await writeFile(join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(projectDir, 'tsconfig.json'), '{}');
    await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(projectDir, 'node_modules'), 'junction');
    for (const name of ['main.ts', 'main.light.ts']) {
      await writeFile(join(projectDir, 'sources', name), 'export const source = typeof __HAPPIER_GUEST_CLI_SOURCE__ === "undefined" ? null : __HAPPIER_GUEST_CLI_SOURCE__; export const channel = typeof __HAPPIER_GUEST_CLI_CHANNEL__ === "undefined" ? null : __HAPPIER_GUEST_CLI_CHANNEL__; ');
    }
    for (const releaseChannel of ['stable', 'preview', 'publicdev'] as const) {
      const outDir = join(projectDir, releaseChannel);
      await bundleServerRuntimeEntrypoints({ projectDir, outDir, releaseChannel });
      for (const name of ['main.js', 'main.light.js']) {
        expect((await import(/* @vite-ignore */ pathToFileURL(join(outDir, name)).href)).source).toBe('public-release');
        expect((await import(/* @vite-ignore */ pathToFileURL(join(outDir, name)).href)).channel).toBe(releaseChannel);
      }
    }
  });
  it('emits full and light runtime entrypoints', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'happier-server-runtime-build-'));
    tempDirs.push(outDir);

    const result = await buildServerRuntime({ outDir });

    expect(result.entrypoints.full).toBe(join(outDir, 'main.js'));
    expect(result.entrypoints.light).toBe(join(outDir, 'main.light.js'));

    await expect(access(result.entrypoints.full, constants.R_OK)).resolves.toBeUndefined();
    await expect(access(result.entrypoints.light, constants.R_OK)).resolves.toBeUndefined();
    for (const face of ['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf',
      'NotoSansCJKsc-Regular.otf', 'NotoSansArabic-Regular.ttf', 'NotoEmoji[wght].ttf']) {
      const bytes = await readFile(join(outDir, 'assets/public-profile', face));
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
    for (const license of ['LICENSE-Inter.txt', 'LICENSE-NotoSansCJK.txt', 'LICENSE-NotoSansArabic.txt', 'LICENSE-NotoEmoji.txt']) {
      expect(await readFile(join(outDir, 'assets/public-profile', license), 'utf8')).toContain('SIL OPEN FONT LICENSE');
    }

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

  it('bundles the private privacy-kit workspace into the self-contained runtime', async () => {
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
