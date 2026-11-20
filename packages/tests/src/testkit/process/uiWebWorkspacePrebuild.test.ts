import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { runLoggedCommandMock } = vi.hoisted(() => ({
  runLoggedCommandMock: vi.fn<typeof import('./spawnProcess').runLoggedCommand>().mockResolvedValue(),
}));

vi.mock('./spawnProcess', () => ({
  runLoggedCommand: runLoggedCommandMock,
}));

import { repoRootDir } from '../paths';
import { ensureUiWebWorkspacePrebuild } from './uiWebWorkspacePrebuild';

const testDirs: string[] = [];

afterEach(async () => {
  runLoggedCommandMock.mockReset();
  runLoggedCommandMock.mockResolvedValue();
  await Promise.all(testDirs.splice(0).map((testDir) => rm(testDir, { recursive: true, force: true })));
});

describe('ensureUiWebWorkspacePrebuild', () => {
  it('lets the canonical workspace publisher finish without a subordinate deadline', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-prebuild-test-'));
    testDirs.push(testDir);

    await ensureUiWebWorkspacePrebuild({
      testDir,
      env: process.env,
      workspaceRootDir: resolve(repoRootDir(), 'apps', 'ui'),
      logPrefix: 'test',
      stdoutPath: resolve(testDir, 'ui.web.stdout.log'),
      stderrPath: resolve(testDir, 'ui.web.stderr.log'),
    });

    const invocation = runLoggedCommandMock.mock.calls[0]?.[0];
    // Process launch is the OS boundary. Queue admission belongs to the real
    // publisher, so this adapter must not kill it on a shorter local timer.
    expect(invocation?.timeoutMs).toBe(null);
    const evalSource = invocation?.args[invocation.args.indexOf('--eval') + 1];
    expect(evalSource).toContain('apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs');
    expect(evalSource).toContain('ensureUiWorkspacePackagesBuilt');
    expect(evalSource).not.toContain('ensureWorkspacePackagesBuiltForComponent');
  });

  it('runs the prebuild module in Node with the workspace TypeScript loader', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-uiweb-prebuild-source-'));
    testDirs.push(testDir);
    const modulePath = join(testDir, 'ensureWorkspacePackagesBuilt.mjs');
    await writeFile(modulePath, `
      import { definition } from './definition.js';
      export async function ensureUiWorkspacePackagesBuilt() { return definition; }
    `);
    await writeFile(join(testDir, 'definition.ts'), `
      type DefinitionLifetime = { value: string };
      export const definition: DefinitionLifetime = { value: 'staged-source' };
    `);

    // Substitute a small preflight module at the OS boundary and run the real
    // Node invocation, including the exact source-runtime launch options.
    const { runLoggedCommand } = await vi.importActual<typeof import('./spawnProcess')>('./spawnProcess');
    runLoggedCommandMock.mockImplementationOnce((invocation) => {
      const args = [...invocation.args];
      const evalIndex = args.indexOf('--eval') + 1;
      const originalModule = pathToFileURL(resolve(repoRootDir(), 'apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'));
      args[evalIndex] = args[evalIndex].replace(originalModule.href, pathToFileURL(modulePath).href);
      return runLoggedCommand({ ...invocation, args });
    });

    await ensureUiWebWorkspacePrebuild({
      testDir,
      env: { ...process.env, NODE_OPTIONS: '' },
      workspaceRootDir: resolve(repoRootDir(), 'apps', 'ui'),
      logPrefix: 'test',
      stdoutPath: join(testDir, 'ui.web.stdout.log'),
      stderrPath: join(testDir, 'ui.web.stderr.log'),
    });

    expect(JSON.parse(await readFile(join(testDir, 'ui.web.prebuild.stdout.log'), 'utf8')))
      .toEqual({ value: 'staged-source' });
  });
});
