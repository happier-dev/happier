import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { runLoggedCommandMock } = vi.hoisted(() => ({
  runLoggedCommandMock: vi.fn(async (_params?: { args?: string[]; timeoutMs?: number | null }) => {}),
}));

vi.mock('./spawnProcess', () => ({
  runLoggedCommand: runLoggedCommandMock,
}));

import { repoRootDir } from '../paths';
import { ensureUiWebWorkspacePrebuild } from './uiWebWorkspacePrebuild';

const testDirs: string[] = [];

afterEach(async () => {
  runLoggedCommandMock.mockClear();
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
    const evalSource = invocation?.args?.[2];
    expect(evalSource).toContain('apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs');
    expect(evalSource).toContain('ensureUiWorkspacePackagesBuilt');
    expect(evalSource).not.toContain('ensureWorkspacePackagesBuiltForComponent');
  });
});
