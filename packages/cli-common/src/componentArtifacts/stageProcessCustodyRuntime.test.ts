import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stageProcessCustodyRuntime } from './stageProcessCustodyRuntime.js';

const tempDirs: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'process-custody-stage-'));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('stageProcessCustodyRuntime', () => {
  it('builds the required target from the canonical Go module when no prebuilt is supplied', async () => {
    const root = await makeRoot();
    const payloadDir = join(root, 'payload');
    const runCommand = vi.fn(async (_command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
      const outputIndex = args.indexOf('-o');
      expect(outputIndex).toBeGreaterThanOrEqual(0);
      await writeFile(args[outputIndex + 1]!, 'workspace-build', 'utf8');
      expect(options?.cwd).toBe(join(root, 'apps', 'cli', 'native', 'processcustody'));
      expect(options?.env).toMatchObject({ CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64' });
    });

    const staged = await stageProcessCustodyRuntime({
      repoRoot: root,
      payloadDir,
      target: { os: 'windows', arch: 'x64', exeExt: '.exe', bunTarget: 'fixture' },
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledWith(
      'go',
      ['build', '-trimpath', '-buildvcs=false', '-o', staged.executablePath, '.'],
      expect.any(Object),
    );
    await expect(readFile(staged.executablePath, 'utf8')).resolves.toBe('workspace-build');
  });

  it('copies an exact prebuilt without invoking a second producer', async () => {
    const root = await makeRoot();
    const prebuilt = join(root, 'prebuilt');
    await writeFile(prebuilt, 'prebuilt-bytes', 'utf8');
    const runCommand = vi.fn();

    const staged = await stageProcessCustodyRuntime({
      repoRoot: root,
      payloadDir: join(root, 'payload'),
      target: { os: 'darwin', arch: 'arm64', exeExt: '', bunTarget: 'fixture' },
      runCommand,
      prebuiltExecutablePath: prebuilt,
    });

    expect(runCommand).not.toHaveBeenCalled();
    await expect(readFile(staged.executablePath, 'utf8')).resolves.toBe('prebuilt-bytes');
  });
});
