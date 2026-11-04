import { execFile, spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installRemoteFirstPartyComponent, installRemoteFirstPartyComponentPayload } from './remoteFirstPartyPayloadInstaller.js';
import { buildRemoteSelfDownloadFirstPartyInstallCommand } from '../ssh/remoteSelfDownloadFirstPartyInstallCommand.js';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

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
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([
    { strategy: 'scp-upload', promotionFails: false },
    { strategy: 'remote-self-download', promotionFails: false },
    { strategy: 'scp-upload', promotionFails: true },
    { strategy: 'remote-self-download', promotionFails: true },
  ] as const)('applies retention around $strategy promotion (failure: $promotionFails)', async ({ strategy, promotionFails }) => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'happier-retention-'));
    const fixture = await createPayloadRootFixture();
    const installRoot = join(home, '.happier', 'cli');
    const versions = join(installRoot, 'versions');
    let runningPayload: Awaited<ReturnType<typeof open>> | undefined;
    let runningChild: ReturnType<typeof spawn> | undefined;
    let childExited: Promise<void> | undefined;
    try {
      for (const id of ['0.6.0', '0.7.0', '0.8.0', '0.9.0', '1.0.0', '1.1.0', '1.2.0', 'local-stable-1792190545251']) {
        await mkdir(join(versions, id), { recursive: true });
        await writeFile(join(versions, id, 'happier'), id);
      }
      // A process still uses this old payload after both activation pointers moved on.
      runningPayload = await open(join(versions, '0.9.0', 'happier'), 'r');
      const script = join(versions, '0.8.0', 'entry.mjs');
      await writeFile(script, 'process.send("ready"); setInterval(() => {}, 1000);');
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      runningChild = child;
      childExited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
      await new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); });
      expect(child.pid).toBeGreaterThan(0);
      await symlink('versions/1.2.0', join(installRoot, 'current'));
      await symlink(join(versions, '1.1.0'), join(installRoot, 'previous'));
      const outside = join(home, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'keep'), 'outside');
      await symlink(outside, join(versions, 'unrelated-link'));
      if (promotionFails) await rm(join(fixture.payloadRoot, 'happier'));
      const archive = join(home, 'payload.tar.gz');
      // Self-download archives have one payload-root directory.
      await execFileAsync('tar', ['-czf', archive, '-C', join(fixture.payloadRoot, '..'), basename(fixture.payloadRoot)]);
      const plan = {
        binaryPath: '$HOME/.happier/cli/current/happier', versionId: '1.3.0', source: 'fixture',
        command: buildRemoteSelfDownloadFirstPartyInstallCommand({
          componentId: 'happier-cli', versionId: '1.3.0',
          archive: { name: 'payload.tar.gz', url: pathToFileURL(archive).href },
          expectedSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
        }),
      };
      const installation = installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli', strategy }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async ({ remoteCommand }) => {
          if (remoteCommand.includes('tar -xf')) {
            expect(await readFile(script, 'utf8')).toContain('process.send');
            expect(await readFile(join(versions, '0.9.0', 'happier'), 'utf8')).toBe('0.9.0');
            await expect(lstat(join(versions, '1.0.0'))).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(lstat(join(versions, 'local-stable-1792190545251'))).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await readFile(join(versions, '1.2.0', 'happier'), 'utf8')).toBe('1.2.0');
            expect(await readFile(join(versions, '1.1.0', 'happier'), 'utf8')).toBe('1.1.0');
          }
          return execFileAsync('/bin/sh', ['-c', remoteCommand], { env: { ...process.env, HOME: home } }).then(
            (result) => ({ status: 0, ...result }),
            (error: unknown) => {
              if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error;
              return { status: error.code, stdout: '', stderr: '' };
            },
          );
        },
        copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
          await cp(localPath, join(home, remotePath, basename(localPath)), { recursive: true });
        },
        resolveSelfDownloadInstallPlan: async () => plan,
        preparePayload: async () => ({ componentId: 'happier-cli', channel: 'stable', versionId: '1.3.0', payloadRoot: fixture.payloadRoot, source: null, cleanup: async () => {} }),
      });
      if (promotionFails) {
        await expect(installation).rejects.toThrow(/install failed|promotion failed/u);
        expect((await readdir(versions)).sort()).toEqual(['0.8.0', '0.9.0', '1.1.0', '1.2.0', 'unrelated-link']);
        expect(await readFile(join(installRoot, 'current', 'happier'), 'utf8')).toBe('1.2.0');
        expect(await readFile(join(installRoot, 'previous', 'happier'), 'utf8')).toBe('1.1.0');
      } else {
        await installation;
        expect((await readdir(versions)).sort()).toEqual(['0.8.0', '0.9.0', '1.2.0', '1.3.0', 'unrelated-link']);
        expect(await readlink(join(installRoot, 'current'))).toBe(join(versions, '1.3.0'));
        expect(await readFile(join(installRoot, 'previous', 'happier'), 'utf8')).toBe('1.2.0');
      }
      expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('outside');
    } finally {
      await runningPayload?.close();
      runningChild?.kill();
      await childExited;
      await fixture.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    { phase: 'promotion', stderr: 'tar: private-path: Cannot write: No space left on device', code: 'remote_storage_full' },
    { phase: 'staging', stderr: 'mkdir: private-path: No space left on device', code: 'remote_storage_full' },
    { phase: 'staging', stderr: 'private-path: ENOSPC', code: 'remote_storage_full' },
    { phase: 'staging', stderr: 'private-path: [Errno 28]', code: 'remote_storage_full' },
    { phase: 'promotion', stderr: 'private-path: errno 28', code: 'remote_storage_full' },
    { phase: 'staging', stderr: 'private-path: [Errno 128] permission denied', code: null },
  ] as const)('classifies $phase failure ($stderr) without disclosing remote stderr', async ({ phase, stderr, code }) => {
    const fixture = await createPayloadRootFixture();
    let uploads = 0;
    let promotions = 0;
    try {
      const failure = await installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli' }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async ({ remoteCommand }) => {
          if (remoteCommand.includes('tar -xf')) promotions++;
          return (phase === 'promotion' ? remoteCommand.includes('tar -xf') : remoteCommand.startsWith('mkdir -p '))
            ? { status: 2, stdout: '', stderr }
            : { status: 0, stdout: 'current=\nprevious=\n', stderr: '' };
        },
        copyLocalDirectoryToRemote: async () => { uploads++; },
        preparePayload: async () => ({ componentId: 'happier-cli', channel: 'stable', versionId: '1.2.3', payloadRoot: fixture.payloadRoot, source: null, cleanup: async () => {} }),
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message: expect.not.stringContaining('private-path') });
      if (code) expect(failure).toMatchObject({ code });
      else expect(failure).not.toHaveProperty('code');
      expect(uploads).toBe(phase === 'staging' ? 0 : 1);
      expect(promotions).toBe(phase === 'staging' ? 0 : 1);
    } finally { await fixture.cleanup(); }
  });

  it('uses the CLI operator payload even when remote self-download was requested', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'happier-source-payload-home-'));
    const fixture = await createPayloadRootFixture();
    try {
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', fixture.payloadRoot);
      const installed = await installRemoteFirstPartyComponent({
        componentId: 'happier-cli', strategy: 'remote-self-download', ssh: { target: 'guest.test', auth: 'agent' },
      }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async ({ remoteCommand }) => {
          const result = await execFileAsync('/bin/sh', ['-c', remoteCommand], { env: { ...process.env, HOME: home } });
          return { status: 0, stdout: result.stdout, stderr: result.stderr };
        },
        copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
          const [archiveName] = await readdir(localPath);
          const archive = await readFile(join(localPath, archiveName!));
          expect(archive.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
          await cp(localPath, join(home, remotePath, basename(localPath)), { recursive: true });
        },
        // A network boundary must not be used for an explicit local payload.
        resolveSelfDownloadInstallPlan: async () => { throw new Error('Release lookup must not run'); },
      });
      expect(installed.source).toBe(`local-payload:${fixture.payloadRoot}`);
      expect(await readFile(join(home, '.happier/cli/current/happier'), 'utf8')).toBe(await readFile(join(fixture.payloadRoot, 'happier'), 'utf8'));
    } finally {
      await fixture.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

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

    expect(observedSignals.length).toBeGreaterThan(0);
    expect(observedSignals.every((signal) => signal === controller.signal)).toBe(true);
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
            const archivePath = join(localPath, 'payload-root.tar.gz');
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
            const extracted = await extractTarFixture({ archivePath: join(localPath, 'payload-root.tar.gz') });
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
    expect(remoteTextCommands).toContain('verified self-download install command');
    expect(copiedRemotePaths).toEqual([]);
  });
});
