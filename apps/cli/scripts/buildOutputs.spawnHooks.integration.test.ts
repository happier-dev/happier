import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { beforeAll, describe, expect, it } from 'vitest';
import { projectPath } from '@/projectPath';
import { ensureBuildArtifactsReadyOnce } from '@/testSetupBuildCoordinator';

function matchesDynamicSpawnHooksImport(text: string): boolean {
  // When daemon spawn hooks are lazily loaded via dynamic import/require, the built output
  // references a chunk like `spawnHooks-<hash>.mjs` at runtime. If the dist folder is
  // rebuilt/cleaned while a daemon is running (common during local dev), those runtime
  // imports can fail and break session spawning.
  //
  // We intentionally assert that `getDaemonSpawnHooks` is not implemented as a lazy
  // dynamic import in the built output.
  const patterns: RegExp[] = [
    /getDaemonSpawnHooks:\s*async\s*\(\)\s*=>\s*\(await\s+import\(\s*['"]\.\/spawnHooks-[^'"]+['"]\s*\)\)/,
    /getDaemonSpawnHooks:\s*async\s*\(\)\s*=>\s*\(await\s+Promise\.resolve\(\)\.then\([^)]*require\(\s*['"]\.\/spawnHooks-[^'"]+['"]\s*\)/,
  ];

  return patterns.some((p) => p.test(text));
}

function matchesDynamicVendorResumeSupportImport(text: string): boolean {
  // The daemon uses vendor-resume support to validate `--resume` and inactive-session resume.
  // When it is implemented as a lazy dynamic import, the built output references a
  // `vendorResumeSupport-<hash>.mjs` chunk at runtime. If the CLI dist folder is rebuilt
  // while a daemon is running, those imports can fail and break resume/spawn flows.
  const patterns: RegExp[] = [
    /getVendorResumeSupport:\s*async\s*\(\)\s*=>\s*\(await\s+import\(\s*['"]\.\/vendorResumeSupport-[^'"]+['"]\s*\)\)\.supportsCodexVendorResume/,
    /getVendorResumeSupport:\s*async\s*\(\)\s*=>\s*\(await\s+Promise\.resolve\(\)\.then\([^)]*require\(\s*['"]\.\/vendorResumeSupport-[^'"]+['"]\s*\)/,
  ];

  return patterns.some((p) => p.test(text));
}

function matchesDynamicConnectedServiceCatalogHookImport(text: string): boolean {
  // These connected-service catalog hooks are used during daemon auth-switch/restart/recovery.
  // If they compile to lazy hashed chunks, a local dev rebuild can remove those chunks while
  // an older daemon is still alive.
  const patterns: RegExp[] = [
    /getConnectedServices?Materializer:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,240}(?:import|require)\(\s*['"]\.\/create[A-Z][A-Za-z]+ConnectedServices?Materializer-[^'"]+['"]\s*\)/,
    /getConnectedServiceRuntimeAuthAdapter:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,240}(?:import|require)\(\s*['"]\.\/create[A-Z][A-Za-z]+ConnectedServiceRuntimeAuthAdapter-[^'"]+['"]\s*\)/,
    /getConnectedServiceStateSharingDescriptor:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,240}(?:import|require)\(\s*['"]\.\/[A-Za-z]+ConnectedServiceStateSharingDescriptor-[^'"]+['"]\s*\)/,
    /resolveConnectedServiceSwitchContinuity:\s*async\s*\([^)]*\)\s*=>[\s\S]{0,260}(?:import|require)\(\s*['"]\.\/resolve[A-Z][A-Za-z]+ConnectedServiceSwitchContinuity-[^'"]+['"]\s*\)/,
  ];

  return patterns.some((p) => p.test(text));
}

function findDescriptorOnlyPluginApiRegistration(text: string): string[] {
  const patterns: Readonly<Record<string, RegExp>> = {
    registerResource: /methodName:\s*["']registerResource["']/,
    registerUiDescriptor: /\bregisterUiDescriptor\b/,
    registerExecutionRunProfile: /\bregisterExecutionRunProfile\b/,
  };

  return Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

async function listDistFiles(distDir: string): Promise<string[]> {
  const entrypointRelativePaths = await resolveDistEntrypointRelativePaths(projectPath());

  // Retry briefly to avoid flaky ENOENT/empty-dir failures when dist is being rebuilt.
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const reachableFiles = await walkReachableDistFiles(distDir, entrypointRelativePaths);
      if (reachableFiles.length > 0) return reachableFiles;
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  return walkReachableDistFiles(distDir, entrypointRelativePaths);
}

async function resolveDistEntrypointRelativePaths(packageRoot: string): Promise<string[]> {
  const packageJson = JSON.parse(await fs.readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    main?: string;
    module?: string;
    exports?: unknown;
  };

  const entrypoints = new Set<string>();
  const pushIfDistFile = (value: unknown) => {
    if (typeof value !== 'string') return;
    if (!value.startsWith('./dist/')) return;
    if (!/\.(?:mjs|cjs)$/.test(value)) return;
    entrypoints.add(value.slice('./dist/'.length));
  };

  const visitExportValue = (value: unknown) => {
    if (typeof value === 'string') {
      pushIfDistFile(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      visitExportValue(nestedValue);
    }
  };

  pushIfDistFile(packageJson.main);
  pushIfDistFile(packageJson.module);
  visitExportValue(packageJson.exports);

  return Array.from(entrypoints);
}

async function walkReachableDistFiles(distDir: string, entrypointRelativePaths: readonly string[]): Promise<string[]> {
  const queue = entrypointRelativePaths.map((entrypoint) => resolve(distDir, entrypoint));
  const seen = new Set<string>();
  const reachableFiles: string[] = [];

  while (queue.length > 0) {
    const nextPath = queue.shift();
    if (!nextPath || seen.has(nextPath)) continue;
    seen.add(nextPath);
    if (!isWithinDirectory(nextPath, distDir)) continue;
    if (!existsSync(nextPath)) continue;
    if (!/\.(?:mjs|cjs)$/.test(nextPath)) continue;

    reachableFiles.push(nextPath);

    const text = await fs.readFile(nextPath, 'utf8');
    for (const specifier of collectRelativeImportSpecifiers(text)) {
      const resolvedImport = resolveRelativeImport(nextPath, specifier);
      if (resolvedImport) queue.push(resolvedImport);
    }
  }

  return reachableFiles;
}

function isWithinDirectory(candidatePath: string, directoryPath: string): boolean {
  const relativePath = relative(directoryPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function collectRelativeImportSpecifiers(text: string): string[] {
  const matches = text.matchAll(
    /(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?["'](\.{1,2}\/[^"'`]+)["']|import\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)|require\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)/g,
  );

  const specifiers = new Set<string>();
  for (const match of matches) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.add(specifier);
  }
  return Array.from(specifiers);
}

function resolveRelativeImport(fromFilePath: string, specifier: string): string | null {
  const basePath = resolve(dirname(fromFilePath), specifier);
  const candidates = [
    basePath,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    join(basePath, 'index.mjs'),
    join(basePath, 'index.cjs'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function resolveDistBuildLockPath(): string {
  const hash = createHash('sha256').update(projectPath()).digest('hex').slice(0, 12);
  return join(tmpdir(), `happier-cli-vitest-build-lock-${hash}`);
}

async function ensureCliDistReady(distDir: string): Promise<void> {
  const distEntrypoint = join(distDir, 'index.mjs');
  if (existsSync(distEntrypoint)) return;

  await ensureBuildArtifactsReadyOnce({
    lockPath: resolveDistBuildLockPath(),
    markerPaths: [distEntrypoint],
    lockLabel: 'CLI dist build',
    runBuild: () => {
      const pmExecPath = typeof process.env.npm_execpath === 'string' ? process.env.npm_execpath.trim() : '';
      const pmExecPathIsJs = pmExecPath.endsWith('.js') || pmExecPath.endsWith('.cjs') || pmExecPath.endsWith('.mjs');
      const command = pmExecPath
        ? pmExecPathIsJs
          ? process.execPath
          : pmExecPath
        : process.platform === 'win32'
          ? 'npm.cmd'
          : 'npm';
      const args = pmExecPathIsJs ? [pmExecPath, 'run', 'build'] : ['run', 'build'];

      const buildResult = spawnSync(command, args, {
          cwd: projectPath(),
          stdio: 'pipe',
          encoding: 'utf8',
        });

      if (buildResult.error) {
        throw new Error(`Failed to rebuild CLI dist for build-output verification: ${buildResult.error.message}`);
      }

      if ((buildResult.status ?? 1) !== 0) {
        const exitCode = typeof buildResult.status === 'number' ? buildResult.status : 'unknown';
        const stdout = typeof buildResult.stdout === 'string' ? buildResult.stdout.trim() : '';
        const stderr = typeof buildResult.stderr === 'string' ? buildResult.stderr.trim() : '';
        const details = [stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : '']
          .filter(Boolean)
          .join('\n\n');

        throw new Error(
          `Failed to rebuild CLI dist for build-output verification (exit ${exitCode})${details ? `\n\n${details}` : ''}`,
        );
      }
    },
  });
}

describe('CLI build output', () => {
  const distDir = join(projectPath(), 'dist');
  let distFiles: string[] = [];

  it('walks only the reachable dist entrypoint closure', async () => {
    const tempRoot = await fs.mkdtemp(join(tmpdir(), 'happier-cli-dist-closure-'));
    const tempDistDir = join(tempRoot, 'dist');
    const runtimeDir = join(tempDistDir, 'runtime');

    try {
      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.writeFile(join(tempDistDir, 'index.mjs'), 'export * from "./runtime/entry.mjs";\n', 'utf8');
      await fs.writeFile(join(runtimeDir, 'entry.mjs'), 'export const ready = true;\n', 'utf8');
      await fs.writeFile(
        join(tempDistDir, 'catalog-orphan.mjs'),
        'export const getDaemonSpawnHooks = async () => (await import("./spawnHooks-bad.mjs"));\n',
        'utf8',
      );

      const files = (
        await walkReachableDistFiles(tempDistDir, ['index.mjs'])
      ).map((file) => file.slice(tempDistDir.length + 1)).sort();

      expect(files).toEqual(['index.mjs', 'runtime/entry.mjs']);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  beforeAll(async () => {
    await ensureCliDistReady(distDir);
    distFiles = await listDistFiles(distDir);
  }, 180_000);

  it('does not lazy-load daemon spawn hooks via dynamic import (prevents runtime chunk-missing failures)', async () => {
    expect(distFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of distFiles) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicSpawnHooksImport(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 60_000);

  it('does not lazy-load vendor resume support via dynamic import (prevents runtime chunk-missing failures)', async () => {
    expect(distFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of distFiles) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicVendorResumeSupportImport(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 60_000);

  it('does not lazy-load connected-service daemon recovery hooks via dynamic import chunks', async () => {
    expect(distFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of distFiles) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicConnectedServiceCatalogHookImport(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 60_000);

  it('includes Claude unified hook assets and bundled plugin package in the CLI release files', async () => {
    const packageJson = JSON.parse(await fs.readFile(join(projectPath(), 'package.json'), 'utf8')) as {
      bundledDependencies?: unknown;
      dependencies?: Record<string, string>;
      files?: unknown;
    };
    const releaseFiles = Array.isArray(packageJson.files) ? packageJson.files.map((entry) => String(entry)) : [];
    const bundledDependencies = Array.isArray(packageJson.bundledDependencies)
      ? packageJson.bundledDependencies.map((entry) => String(entry))
      : [];

    expect(releaseFiles).toContain('scripts/**/*.cjs');
    expect(existsSync(join(projectPath(), 'scripts', 'session_hook_forwarder.cjs'))).toBe(true);
    expect(existsSync(join(projectPath(), 'scripts', 'permission_hook_forwarder.cjs'))).toBe(true);
    expect(bundledDependencies).toContain('@happier-dev/plugins-claude');
    expect(packageJson.dependencies?.['@happier-dev/plugins-claude']).toBe('0.0.0');
  });

  it('does not expose descriptor-only plugin API registration methods in packaged dist', async () => {
    expect(distFiles.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of distFiles) {
      const text = await fs.readFile(file, 'utf8');
      const retiredNames = findDescriptorOnlyPluginApiRegistration(text);
      if (retiredNames.length > 0) {
        offenders.push(`${relative(distDir, file)}:${retiredNames.join(',')}`);
      }
    }

    expect(offenders).toEqual([]);
  }, 60_000);
});
