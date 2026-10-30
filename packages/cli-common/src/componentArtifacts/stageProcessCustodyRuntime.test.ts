import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stageProcessCustodyRuntime } from './stageProcessCustodyRuntime.js';

const tempDirs: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'process-custody-stage-'));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
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
    const scratch = vi.spyOn(fs, 'mkdtemp');
    const publish = vi.spyOn(fs, 'rename');
    syncBuiltinESMExports();

    const staged = await stageProcessCustodyRuntime({
      repoRoot: root,
      payloadDir: join(root, 'payload'),
      target: { os: 'darwin', arch: 'arm64', exeExt: '', bunTarget: 'fixture' },
      runCommand,
      prebuiltExecutablePath: prebuilt,
    });

    expect(runCommand).not.toHaveBeenCalled();
    await expect(readFile(staged.executablePath, 'utf8')).resolves.toBe('prebuilt-bytes');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.any(String), staged.executablePath);
    expect(scratch).toHaveBeenCalled();
    for (const created of scratch.mock.results) {
      if (created.type !== 'return') continue;
      const directory = String(await created.value);
      const fromRepo = relative(root, directory);
      expect(isAbsolute(fromRepo) || fromRepo === '..' || fromRepo.startsWith(`..${sep}`)).toBe(true);
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each(['linux', 'darwin', 'windows'] as const)('publishes atomically after EXDEV for %s', async (os) => {
    const root = await makeRoot();
    const payloadDir = join(root, 'payload');
    const toolsDir = join(payloadDir, 'tools', 'unpacked');
    const executablePath = join(toolsDir, `happier-process-custody${os === 'windows' ? '.exe' : ''}`);
    const prebuilt = join(root, 'prebuilt');
    const oldExecutable = join(root, 'old-executable');
    await fs.mkdir(toolsDir, { recursive: true });
    await writeFile(prebuilt, 'replacement-bytes');
    await writeFile(executablePath, 'running-bytes');
    // A hard link observes the old inode even after an atomic replacement.
    await fs.link(executablePath, oldExecutable);
    const rename = fs.rename;
    const publish = vi.spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('cross-device publication'), { code: 'EXDEV' }))
      .mockImplementation(rename);
    const copy = vi.spyOn(fs, 'copyFile');
    const scratch = vi.spyOn(fs, 'mkdtemp');
    syncBuiltinESMExports();

    const staged = await stageProcessCustodyRuntime({
      repoRoot: root,
      payloadDir,
      target: { os, arch: 'x64', exeExt: os === 'windows' ? '.exe' : '', bunTarget: 'fixture' },
      runCommand: async () => { throw new Error('prebuilt must not build'); },
      prebuiltExecutablePath: prebuilt,
    });

    expect(staged.executablePath).toBe(executablePath);
    await expect(readFile(executablePath, 'utf8')).resolves.toBe('replacement-bytes');
    await expect(readFile(oldExecutable, 'utf8')).resolves.toBe('running-bytes');
    const [replacement, destination] = publish.mock.calls[1]!;
    expect(destination).toBe(executablePath);
    expect(relative(toolsDir, String(replacement))).toMatch(/^\.tmp\.[^/\\]+$/);
    expect(copy).toHaveBeenCalledWith(publish.mock.calls[0]![0], replacement, fs.constants.COPYFILE_EXCL);
    if (os !== 'windows') expect((await fs.stat(executablePath)).mode & 0o777).toBe(0o755);
    await expect(fs.readdir(toolsDir)).resolves.toEqual([`happier-process-custody${os === 'windows' ? '.exe' : ''}`]);
    for (const created of scratch.mock.results) {
      if (created.type === 'return') await expect(fs.stat(await created.value)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each([false, true])('preserves the old executable and cleans scratch on publication failure (EXDEV=%s)', async (crossDevice) => {
    const root = await makeRoot();
    const toolsDir = join(root, 'payload', 'tools', 'unpacked');
    const executablePath = join(toolsDir, 'happier-process-custody');
    const prebuilt = join(root, 'prebuilt');
    await fs.mkdir(toolsDir, { recursive: true });
    await writeFile(executablePath, 'running-bytes');
    await writeFile(prebuilt, 'replacement-bytes');
    const failure = Object.assign(new Error('publication refused'), { code: 'EACCES' });
    const publish = vi.spyOn(fs, 'rename').mockRejectedValue(failure);
    if (crossDevice) publish.mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
    const copy = vi.spyOn(fs, 'copyFile');
    const scratch = vi.spyOn(fs, 'mkdtemp');
    syncBuiltinESMExports();

    await expect(stageProcessCustodyRuntime({
      repoRoot: root,
      payloadDir: join(root, 'payload'),
      target: { os: 'linux', arch: 'x64', exeExt: '', bunTarget: 'fixture' },
      runCommand: async () => { throw new Error('prebuilt must not build'); },
      prebuiltExecutablePath: prebuilt,
    })).rejects.toBe(failure);

    await expect(readFile(executablePath, 'utf8')).resolves.toBe('running-bytes');
    await expect(fs.readdir(toolsDir)).resolves.toEqual(['happier-process-custody']);
    if (!crossDevice) expect(copy).not.toHaveBeenCalled();
    for (const created of scratch.mock.results) {
      if (created.type === 'return') await expect(fs.stat(await created.value)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
