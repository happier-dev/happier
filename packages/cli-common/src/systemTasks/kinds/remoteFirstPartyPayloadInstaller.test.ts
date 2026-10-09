import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { installRemoteFirstPartyComponent, installRemoteFirstPartyComponentPayload } from './remoteFirstPartyPayloadInstaller.js';

const execFileAsync = promisify(execFile);

async function createPayloadRootFixture(): Promise<Readonly<{
  payloadRoot: string;
  cleanup: () => Promise<void>;
}>> {
  const rootDir = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-fixture-'));
  const payloadRoot = join(rootDir, 'payload-root');
  await mkdir(payloadRoot, { recursive: true });
  await writeFile(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  return {
    payloadRoot,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function extractTarFixture(params: Readonly<{ archivePath: string }>): Promise<Readonly<{
  extractRoot: string;
  cleanup: () => Promise<void>;
}>> {
  const extractRoot = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-extract-'));
  try {
    await execFileAsync('tar', ['-xf', params.archivePath, '-C', extractRoot]);
    return {
      extractRoot,
      cleanup: async () => {
        await rm(extractRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(extractRoot, { recursive: true, force: true });
    throw error;
  }
}

describe('installRemoteFirstPartyComponent', () => {
  it('installs the same binary payload through native file and exec IO without an SSH identity', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'happier-native-home with spaces-'));
    const fixture = await createPayloadRootFixture();
    try {
      const installed = await installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli' }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async ({ remoteCommand }) => {
          const result = await execFileAsync('/bin/sh', ['-c', remoteCommand], { env: { ...process.env, HOME: home } });
          return { status: 0, stdout: result.stdout, stderr: result.stderr };
        },
        copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
          await cp(localPath, join(home, remotePath, basename(localPath)), { recursive: true });
        },
        preparePayload: async () => ({ componentId: 'happier-cli', channel: 'stable', versionId: '1.2.3', payloadRoot: fixture.payloadRoot, source: null, cleanup: async () => {} }),
      });
      expect(installed.binaryPath).toBe('$HOME/.happier/cli/current/happier');
      await expect(execFileAsync(join(home, '.happier', 'cli', 'current', 'happier'), [])).resolves.toMatchObject({ stdout: '' });
    } finally {
      await fixture.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('installs and promotes an uploaded payload in a remote HOME containing spaces', async () => {
    if (process.platform === 'win32') return; // The remote installer runs on POSIX targets.
    const root = await mkdtemp(join(tmpdir(), 'happier-remote-home-'));
    const home = join(root, 'home with spaces');
    const fixture = await createPayloadRootFixture();
    try {
      await mkdir(home);
      const installed = await installRemoteFirstPartyComponent({
        componentId: 'happier-cli', ssh: { target: 'dev@example.test', auth: 'agent' },
      }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async ({ remoteCommand }) => {
          const result = await execFileAsync('/bin/sh', ['-c', remoteCommand], { cwd: root, env: { ...process.env, HOME: home } });
          return { status: 0, stdout: result.stdout, stderr: result.stderr };
        },
        // SCP is the network boundary; preserve its directory-copy semantics locally.
        copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
          await cp(localPath, join(home, remotePath, basename(localPath)), { recursive: true });
        },
        preparePayload: async () => ({
          componentId: 'happier-cli', channel: 'stable', versionId: '1.2.3',
          payloadRoot: fixture.payloadRoot, source: null, cleanup: async () => undefined,
        }),
      });
      expect(installed.binaryPath).toBe('$HOME/.happier/cli/current/happier');
      const binary = join(home, '.happier', 'cli', 'current', 'happier');
      await expect(execFileAsync(binary, [])).resolves.toMatchObject({ stdout: '', stderr: '' });
      expect(await readFile(binary, 'utf8')).toContain('exit 0');
    } finally {
      await fixture.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forwards cancellation to each remote process boundary', async () => {
    const controller = new AbortController();
    const observedSignals: Array<AbortSignal | undefined> = [];

    await installRemoteFirstPartyComponent(
      {
        componentId: 'happier-cli',
        channel: 'preview',
        ssh: { target: 'dev@example.test', auth: 'agent' },
        strategy: 'remote-self-download',
        signal: controller.signal,
      },
      {
        resolveRemoteReleaseTarget: async ({ signal }) => {
          observedSignals.push(signal);
          return { os: 'linux', arch: 'x64' };
        },
        runRemoteText: async ({ signal }) => {
          observedSignals.push(signal);
          return { status: 0, stdout: '', stderr: '' };
        },
        copyLocalDirectoryToRemote: async () => undefined,
        resolveSelfDownloadInstallPlan: async () => ({
          binaryPath: '$HOME/.happier/happier',
          command: 'install',
          source: 'https://example.test/happier.tar.gz',
          versionId: 'preview-1',
        }),
      },
    );

    expect(observedSignals).toEqual([controller.signal, controller.signal]);
  });

  it('uses an scp-safe remote path for staging while keeping $HOME-based paths in remote shell commands', async () => {
    const remoteTextCommands: string[] = [];
    const copiedRemotePaths: string[] = [];
    const fixture = await createPayloadRootFixture();

    try {
      await installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async ({ remoteCommand }) => {
            remoteTextCommands.push(remoteCommand);
            return { status: 0, stdout: '', stderr: '' };
          },
          copyLocalDirectoryToRemote: async ({ remotePath }) => {
            copiedRemotePaths.push(remotePath);
          },
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'preview-1',
            payloadRoot: fixture.payloadRoot,
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      );

      expect(copiedRemotePaths).toEqual([
        '.happier/bootstrap-staging/happier-cli-preview-1-123',
      ]);
      expect(remoteTextCommands.some((command) => command.includes('mkdir -p "$HOME"/'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('/versions/'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('tar -xf'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('ln -sfn'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('chmod +x'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('bash $HOME/.happier'))).toBe(false);
      expect(remoteTextCommands.some((command) => command.includes('pipefail'))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects remoteHomeDir values that are unsafe to embed in shell commands', async () => {
    await expect(
      installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
          remoteHomeDir: '$HOME/.happier; rm -rf /',
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'preview-1',
            payloadRoot: '/tmp/payload-root',
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      ),
    ).rejects.toThrow(/remote home dir/i);
  });

  it('shell-escapes versionId values when embedding them in the remote install command', async () => {
    const remoteTextCommands: string[] = [];
    const fixture = await createPayloadRootFixture();

    try {
      await installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async ({ remoteCommand }) => {
            remoteTextCommands.push(remoteCommand);
            return { status: 0, stdout: '', stderr: '' };
          },
          copyLocalDirectoryToRemote: async () => undefined,
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: "preview-1'break-quote",
            payloadRoot: fixture.payloadRoot,
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      );

      const combined = remoteTextCommands.join('\n');
      expect(combined).toContain('preview-1-break-quote');
      expect(combined).not.toContain("preview-1'break-quote");
    } finally {
      await fixture.cleanup();
    }
  });

  it('materializes symlinked payload entries before copying them over scp', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-payload-'));
    const capturedLocalPaths: string[] = [];

    try {
      const externalTargetPath = join(rootDir, 'external-tool.js');
      const missingTargetPath = join(rootDir, 'missing-tool.js');
      const payloadRoot = join(rootDir, 'payload-root');
      const symlinkPath = join(payloadRoot, 'node_modules', '.bin', 'tool');
      const brokenSymlinkPath = join(payloadRoot, 'node_modules', '.bin', 'tool-broken');

      await writeFile(externalTargetPath, 'console.log("tool")\n', 'utf8');
      await mkdir(join(payloadRoot, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await symlink(externalTargetPath, symlinkPath);
      await symlink(missingTargetPath, brokenSymlinkPath);

      await installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async ({ localPath }) => {
            capturedLocalPaths.push(localPath);
            const stageEntries = await lstat(localPath);
            expect(stageEntries.isDirectory()).toBe(true);
            const archivePath = join(localPath, 'payload-root.tar');
            const extracted = await extractTarFixture({ archivePath });
            try {
              const copiedSymlinkPath = join(extracted.extractRoot, 'payload-root', 'node_modules', '.bin', 'tool');
              const copiedBrokenSymlinkPath = join(extracted.extractRoot, 'payload-root', 'node_modules', '.bin', 'tool-broken');
              expect((await lstat(copiedSymlinkPath)).isSymbolicLink()).toBe(false);
              expect(await readFile(copiedSymlinkPath, 'utf8')).toBe('console.log("tool")\n');
              await expect(lstat(copiedBrokenSymlinkPath)).rejects.toThrow();
            } finally {
              await extracted.cleanup();
            }
          },
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'preview-1',
            payloadRoot,
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      );

      expect(capturedLocalPaths).toHaveLength(1);
      expect(capturedLocalPaths[0]).not.toBe(payloadRoot);
      await expect(lstat(capturedLocalPaths[0]!)).rejects.toThrow();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('drops dangling payload symlinks before copying them over scp', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-remote-first-party-dangling-'));
    const capturedLocalPaths: string[] = [];

    try {
      const payloadRoot = join(rootDir, 'payload-root');
      const symlinkPath = join(payloadRoot, 'node_modules', '.bin', 'tool');

      await mkdir(join(payloadRoot, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(payloadRoot, 'happier'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      await symlink('../missing-tool.js', symlinkPath);

      await installRemoteFirstPartyComponent(
        {
          componentId: 'happier-cli',
          channel: 'preview',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
        {
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
          copyLocalDirectoryToRemote: async ({ localPath }) => {
            capturedLocalPaths.push(localPath);
            const extracted = await extractTarFixture({ archivePath: join(localPath, 'payload-root.tar') });
            try {
              await expect(lstat(join(extracted.extractRoot, 'payload-root', 'node_modules', '.bin', 'tool'))).rejects.toThrow();
            } finally {
              await extracted.cleanup();
            }
          },
          preparePayload: async () => ({
            componentId: 'happier-cli',
            channel: 'preview',
            versionId: 'preview-1',
            payloadRoot,
            source: 'https://example.test/payload.tar.gz',
            cleanup: async () => undefined,
          }),
          now: () => 123,
        },
      );

      expect(capturedLocalPaths).toHaveLength(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('can install through the shared remote self-download strategy without staging a local payload', async () => {
    const remoteTextCommands: string[] = [];
    const copiedRemotePaths: string[] = [];

    const result = await installRemoteFirstPartyComponent(
      {
        componentId: 'happier-cli',
        channel: 'preview',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        strategy: 'remote-self-download',
      },
      {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async ({ remoteCommand }) => {
          remoteTextCommands.push(remoteCommand);
          return { status: 0, stdout: '', stderr: '' };
        },
        copyLocalDirectoryToRemote: async ({ remotePath }) => {
          copiedRemotePaths.push(remotePath);
        },
        resolveSelfDownloadInstallPlan: async ({ componentId, channel, os, arch }) => ({
          binaryPath: `$HOME/.happier/${componentId}/${channel}/${os}/${arch}/happier`,
          command: 'verified self-download install command',
          source: 'https://example.test/happier.tar.gz',
          versionId: 'preview-1',
        }),
      },
    );

    expect(result).toEqual({
      binaryPath: '$HOME/.happier/happier-cli/preview/linux/x64/happier',
      versionId: 'preview-1',
      source: 'https://example.test/happier.tar.gz',
    });
    expect(remoteTextCommands).toEqual(['verified self-download install command']);
    expect(copiedRemotePaths).toEqual([]);
  });
});
