import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { testState } = vi.hoisted(() => {
  return {
    testState: {
      repoRootDir: '',
    },
  };
});

vi.mock('../paths', () => {
  return {
    repoRootDir: () => testState.repoRootDir,
  };
});

describe('uiWebSourceFingerprint', () => {
  beforeEach(() => {
    vi.resetModules();
    testState.repoRootDir = '';
  });

  afterAll(() => {
    vi.doUnmock('../paths');
    vi.resetModules();
  });

  it('changes when a same-sized source file changes without mtime precision changing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-fingerprint-'));
    testState.repoRootDir = rootDir;

    const uiDir = join(rootDir, 'apps', 'ui');
    const sourcesDir = join(uiDir, 'sources');
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(join(uiDir, 'index.ts'), 'export {};\n', 'utf8');
    await writeFile(join(uiDir, 'metro.config.js'), 'module.exports = {};\n', 'utf8');

    const sourceFile = join(sourcesDir, 'sessionState.ts');
    const sameSizeBefore = 'const value = 1;\n';
    const sameSizeAfter = 'const value = 2;\n';
    expect(sameSizeBefore.length).toBe(sameSizeAfter.length);

    const fixedMtime = new Date('2026-04-05T00:00:00.000Z');
    await writeFile(sourceFile, sameSizeBefore, 'utf8');
    await utimes(sourceFile, fixedMtime, fixedMtime);

    const firstFingerprint = (await import('./uiWebSourceFingerprint')).resolveUiWebSourceFingerprint();

    await writeFile(sourceFile, sameSizeAfter, 'utf8');
    await utimes(sourceFile, fixedMtime, fixedMtime);

    vi.resetModules();
    testState.repoRootDir = rootDir;
    const secondFingerprint = (await import('./uiWebSourceFingerprint')).resolveUiWebSourceFingerprint();

    expect(secondFingerprint).not.toBe(firstFingerprint);

    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  });

  it('recomputes within the same module instance when source contents change', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-fingerprint-live-'));
    testState.repoRootDir = rootDir;

    const uiDir = join(rootDir, 'apps', 'ui');
    const sourcesDir = join(uiDir, 'sources');
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(join(uiDir, 'index.ts'), 'export {};\n', 'utf8');
    await writeFile(join(uiDir, 'metro.config.js'), 'module.exports = {};\n', 'utf8');

    const sourceFile = join(sourcesDir, 'sessionState.ts');
    const before = 'const value = 1;\n';
    const after = 'const value = 2;\n';
    expect(before.length).toBe(after.length);

    await writeFile(sourceFile, before, 'utf8');
    const { resolveUiWebSourceFingerprint } = await import('./uiWebSourceFingerprint');
    const firstFingerprint = resolveUiWebSourceFingerprint();

    await writeFile(sourceFile, after, 'utf8');
    const secondFingerprint = resolveUiWebSourceFingerprint();

    expect(secondFingerprint).not.toBe(firstFingerprint);

    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  });

  it('changes when an imported internal workspace package source changes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-fingerprint-workspace-'));
    testState.repoRootDir = rootDir;

    const uiDir = join(rootDir, 'apps', 'ui');
    const sourcesDir = join(uiDir, 'sources');
    const protocolDir = join(rootDir, 'packages', 'protocol');
    const protocolSrcDir = join(protocolDir, 'src');
    await mkdir(sourcesDir, { recursive: true });
    await mkdir(protocolSrcDir, { recursive: true });
    await writeFile(join(uiDir, 'index.ts'), 'export {};\n', 'utf8');
    await writeFile(join(uiDir, 'metro.config.js'), 'module.exports = {};\n', 'utf8');
    await writeFile(
      join(uiDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/ui',
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
        },
      }),
      'utf8',
    );
    await writeFile(join(protocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol' }), 'utf8');

    const packageSourceFile = join(protocolSrcDir, 'index.ts');
    const sameSizeBefore = 'export const value = 1;\n';
    const sameSizeAfter = 'export const value = 2;\n';
    expect(sameSizeBefore.length).toBe(sameSizeAfter.length);

    const fixedMtime = new Date('2026-04-05T00:00:00.000Z');
    await writeFile(packageSourceFile, sameSizeBefore, 'utf8');
    await utimes(packageSourceFile, fixedMtime, fixedMtime);

    const firstFingerprint = (await import('./uiWebSourceFingerprint')).resolveUiWebSourceFingerprint();

    await writeFile(packageSourceFile, sameSizeAfter, 'utf8');
    await utimes(packageSourceFile, fixedMtime, fixedMtime);

    vi.resetModules();
    testState.repoRootDir = rootDir;
    const secondFingerprint = (await import('./uiWebSourceFingerprint')).resolveUiWebSourceFingerprint();

    expect(secondFingerprint).not.toBe(firstFingerprint);

    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  });

  it('changes when a transitively imported internal workspace package source changes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-fingerprint-transitive-workspace-'));
    testState.repoRootDir = rootDir;

    const uiDir = join(rootDir, 'apps', 'ui');
    const sourcesDir = join(uiDir, 'sources');
    const agentsDir = join(rootDir, 'packages', 'agents');
    const agentsSrcDir = join(agentsDir, 'src');
    const protocolDir = join(rootDir, 'packages', 'protocol');
    const protocolSrcDir = join(protocolDir, 'src');
    await mkdir(sourcesDir, { recursive: true });
    await mkdir(agentsSrcDir, { recursive: true });
    await mkdir(protocolSrcDir, { recursive: true });
    await writeFile(join(uiDir, 'index.ts'), 'export {};\n', 'utf8');
    await writeFile(join(uiDir, 'metro.config.js'), 'module.exports = {};\n', 'utf8');
    await writeFile(
      join(uiDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/ui',
        dependencies: {
          '@happier-dev/agents': '0.0.0',
        },
      }),
      'utf8',
    );
    await writeFile(
      join(agentsDir, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/agents',
        dependencies: {
          '@happier-dev/protocol': '0.0.0',
        },
      }),
      'utf8',
    );
    await writeFile(join(protocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol' }), 'utf8');

    const packageSourceFile = join(protocolSrcDir, 'index.ts');
    const sameSizeBefore = 'export const value = 1;\n';
    const sameSizeAfter = 'export const value = 2;\n';
    expect(sameSizeBefore.length).toBe(sameSizeAfter.length);

    const fixedMtime = new Date('2026-04-05T00:00:00.000Z');
    await writeFile(packageSourceFile, sameSizeBefore, 'utf8');
    await utimes(packageSourceFile, fixedMtime, fixedMtime);

    const firstFingerprint = (await import('./uiWebSourceFingerprint')).resolveUiWebSourceFingerprint();

    await writeFile(packageSourceFile, sameSizeAfter, 'utf8');
    await utimes(packageSourceFile, fixedMtime, fixedMtime);

    vi.resetModules();
    testState.repoRootDir = rootDir;
    const secondFingerprint = (await import('./uiWebSourceFingerprint')).resolveUiWebSourceFingerprint();

    expect(secondFingerprint).not.toBe(firstFingerprint);

    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  });

  it.each([
    'babel.config.js',
    'app.config.js',
    'appVariantConfig.cjs',
    'tsconfig.json',
  ])('changes when a root-level UI config file changes: %s', async (fileName) => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-fingerprint-config-'));
    testState.repoRootDir = rootDir;

    const uiDir = join(rootDir, 'apps', 'ui');
    const sourcesDir = join(uiDir, 'sources');
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(join(uiDir, 'index.ts'), 'export {};\n', 'utf8');
    await writeFile(join(uiDir, 'metro.config.js'), 'module.exports = {};\n', 'utf8');

    const targetFile = join(uiDir, fileName);
    const sameSizeBefore = 'export default 1;\n';
    const sameSizeAfter = 'export default 2;\n';
    expect(sameSizeBefore.length).toBe(sameSizeAfter.length);

    const fixedMtime = new Date('2026-04-05T00:00:00.000Z');
    await writeFile(targetFile, sameSizeBefore, 'utf8');
    await utimes(targetFile, fixedMtime, fixedMtime);

    const firstFingerprint = (await import('./uiWebSourceFingerprint')).resolveUiWebSourceFingerprint();

    await writeFile(targetFile, sameSizeAfter, 'utf8');
    await utimes(targetFile, fixedMtime, fixedMtime);

    vi.resetModules();
    testState.repoRootDir = rootDir;
    const secondFingerprint = (await import('./uiWebSourceFingerprint')).resolveUiWebSourceFingerprint();

    expect(secondFingerprint).not.toBe(firstFingerprint);

    await rm(rootDir, { recursive: true, force: true }).catch(() => {});
  });
});
