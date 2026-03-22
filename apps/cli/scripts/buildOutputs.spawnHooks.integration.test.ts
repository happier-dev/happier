import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
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

async function listDistFiles(distDir: string): Promise<string[]> {
  // Focus the scan on the primary built bundles that contain the AGENT catalog wiring.
  // This avoids reading hundreds of unrelated dist chunks, keeping the test fast and stable.
  const isPrimaryBundle = (name: string) => /^(api|index)(?:-[^.]+)?\.(?:mjs|cjs)$/.test(name);
  const isAnyBundle = (name: string) => /\.(?:mjs|cjs)$/.test(name);

  // Retry briefly to avoid flaky ENOENT/empty-dir failures when dist is being rebuilt.
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const entries = await fs.readdir(distDir);
      const primaryFiles = entries.filter(isPrimaryBundle).map((entry) => join(distDir, entry));
      if (primaryFiles.length > 0) return primaryFiles;

      const fallbackFiles = entries.filter(isAnyBundle).map((entry) => join(distDir, entry));
      if (fallbackFiles.length > 0) return fallbackFiles;
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const entries = await fs.readdir(distDir);
  const primaryFiles = entries.filter(isPrimaryBundle).map((entry) => join(distDir, entry));
  if (primaryFiles.length > 0) return primaryFiles;
  return entries.filter(isAnyBundle).map((entry) => join(distDir, entry));
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
  it('does not lazy-load daemon spawn hooks via dynamic import (prevents runtime chunk-missing failures)', async () => {
    // Some tests may change `process.cwd()`; resolve relative to the CLI project root instead.
    const distDir = join(projectPath(), 'dist');
    await ensureCliDistReady(distDir);

    const files = await listDistFiles(distDir);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicSpawnHooksImport(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 60_000);

  it('does not lazy-load vendor resume support via dynamic import (prevents runtime chunk-missing failures)', async () => {
    // Some tests may change `process.cwd()`; resolve relative to the CLI project root instead.
    const distDir = join(projectPath(), 'dist');
    await ensureCliDistReady(distDir);

    const files = await listDistFiles(distDir);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      if (matchesDynamicVendorResumeSupportImport(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 60_000);
});
