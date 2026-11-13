import { execFile, spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { copyFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installRemoteFirstPartyComponent, installRemoteFirstPartyComponentPayload, normalizeRemoteReleaseArch } from './remoteFirstPartyPayloadInstaller.js';
import { buildRemoteSelfDownloadFirstPartyInstallCommand, resolveRemoteSelfDownloadFirstPartyInstallPlan } from '../ssh/remoteSelfDownloadFirstPartyInstallCommand.js';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createCliPayloadFixture as createPayloadRootFixture } from '../testkit/createCliPayloadFixture.js';
import { DEFAULT_COMMAND_CAPTURE_MAX_BYTES } from '../../process/commandCaptureBudget.js';

// Filesystem IO is the system boundary; all payload/archive logic stays real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile), lstat: vi.fn(actual.lstat) };
});

const execFileAsync = promisify(execFile);

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
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('archives a full-size installed payload without requiring a second uncompressed copy', async () => {
    const fixture = await createPayloadRootFixture();
    // The incident's installed payload contains 1,278,760,198 bytes. Model the
    // exhausted scratch filesystem at its copy boundary, retaining real tar IO.
    const payloadBytes = 1_278_760_198;
    const data = await open(join(fixture.payloadRoot, 'runtime-data'), 'w');
    await data.truncate(payloadBytes);
    // Keep the sparse fixture below tar's decompression-ratio security boundary.
    await data.write(randomBytes(2 * 1024 * 1024));
    await data.close();
    vi.mocked(copyFile).mockRejectedValue(Object.assign(new Error('Disk quota exceeded'), { code: 'EDQUOT' }));
    let delivered = false;
    try {
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', fixture.payloadRoot);
      await installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli' }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async ({ localPath }) => {
          const { list } = await import('tar');
          let deliveredSize = 0;
          await list({ file: join(localPath, 'payload-root.tar.gz'), onReadEntry: entry => {
            if (entry.path === 'payload-root/runtime-data') deliveredSize = entry.size;
          } });
          expect(deliveredSize).toBe(payloadBytes);
          delivered = true;
        },
      });
      expect(delivered).toBe(true);
    } finally {
      vi.mocked(copyFile).mockReset();
      await fixture.cleanup();
    }
  }, 120_000);

  it('preserves the typed archive preparation cause without exposing filesystem content', async () => {
    const fixture = await createPayloadRootFixture();
    const archiveFailure = Object.assign(new Error('private filesystem path'), { code: 'EACCES' });
    // Real filesystem boundary: retain the actual payload selection and archive preparation path.
    vi.mocked(lstat).mockRejectedValueOnce(archiveFailure);
    try {
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', fixture.payloadRoot);
      const failure = await installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli' }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'arm64' }),
        runRemoteText: async () => { throw new Error('Archive failure must precede remote commands'); },
        copyLocalDirectoryToRemote: async () => { throw new Error('Archive failure must precede upload'); },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'invalid_payload', cause: archiveFailure });
      if (!(failure instanceof Error)) throw new Error('Expected a typed installation failure');
      expect(failure.cause).toBe(archiveFailure);
      expect(failure.message).not.toContain('private filesystem path');
    } finally {
      vi.mocked(lstat).mockReset();
      await fixture.cleanup();
    }
  });

  it('refuses an unsupported guest architecture with a typed install cause', async () => {
    let mutations = 0;
    await expect(installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli' }, {
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: normalizeRemoteReleaseArch('riscv64') }),
      runRemoteText: async () => { mutations++; return { status: 0, stdout: '', stderr: '' }; },
      copyLocalDirectoryToRemote: async () => { mutations++; },
    })).rejects.toMatchObject({ code: 'guest_architecture_unsupported' });
    expect(mutations).toBe(0);
  });

  it.each([
    { os: 'linux', arch: 'arm64' }, { os: 'linux', arch: 'x64' },
    { os: 'darwin', arch: 'arm64' }, { os: 'darwin', arch: 'x64' },
  ] as const)('delivers matching native $os-$arch payload bytes', async target => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-payload-'));
    try {
      const header = Buffer.alloc(64);
      if (target.os === 'linux') {
        header.write('\x7fELF', 0, 'binary'); header[4] = 2; header[5] = 1;
        header.writeUInt16LE(target.arch === 'arm64' ? 183 : 62, 18);
      } else {
        header.writeUInt32LE(0xfeedfacf, 0);
        header.writeUInt32LE(target.arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
      }
      await writeFile(join(root, 'happier'), header);
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', root);
      let delivered: Buffer | undefined;
      await installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli' }, {
        resolveRemoteReleaseTarget: async () => target,
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async ({ localPath }) => {
          const [archiveName] = await readdir(localPath);
          const extracted = await extractTarFixture({ archivePath: join(localPath, archiveName!) });
          try {
            const [directory] = await readdir(extracted.extractRoot);
            delivered = await readFile(join(extracted.extractRoot, directory!, 'happier'));
          } finally { await extracted.cleanup(); }
        },
      });
      expect(delivered).toEqual(header);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['scp-upload', 'remote-self-download'] as const)('reports a missing ARM release archive before guest mutation over %s', async strategy => {
    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', '');
    vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_TOKEN', 'fixture-token');
    let fetches = 0;
    const release = JSON.stringify({ assets: [
      'checksums-happier-v1.2.3.txt', 'checksums-happier-v1.2.3.txt.minisig', 'happier-v1.2.3-linux-x64.tar.gz',
    ].map(name => ({ name, browser_download_url: `https://releases.example.test/${name}` })) });
    const fetchImpl: typeof fetch = async () => {
      fetches++;
      return new Response(release, { status: 200 });
    };
    // SCP acquisition uses Node HTTP, while self-download accepts a fetch IO
    // boundary. Exercise both real acquisition owners without public traffic.
    const server = createServer((_request, response) => {
      fetches++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(release);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback address');
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', `http://127.0.0.1:${address.port}`);
      let mutations = 0;
      await expect(installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli', strategy }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'arm64' }),
        runRemoteText: async () => { mutations++; return { status: 0, stdout: '', stderr: '' }; },
        copyLocalDirectoryToRemote: async () => { mutations++; },
        resolveSelfDownloadInstallPlan: params => resolveRemoteSelfDownloadFirstPartyInstallPlan({ ...params, fetchImpl }),
      })).rejects.toMatchObject({ code: 'guest_payload_missing', message: expect.stringContaining('linux-arm64') });
      expect(fetches).toBe(1);
      expect(mutations).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it.each(['flat', 'collection'] as const)('refuses an ARM guest with an x64-only %s operator payload before remote mutation', async layout => {
    const root = await mkdtemp(join(tmpdir(), 'happier-guest-architecture-'));
    try {
      const payload = layout === 'flat' ? root : join(root, 'linux-x64');
      await mkdir(payload, { recursive: true });
      const executable = Buffer.alloc(64);
      executable.write('\x7fELF', 0, 'binary');
      executable[4] = 2; executable[5] = 1;
      executable.writeUInt16LE(62, 18); // ELF EM_X86_64.
      await writeFile(join(payload, 'happier'), executable);
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', root);
      const remoteCommands: string[] = [];
      let uploads = 0;
      const failure = await installRemoteFirstPartyComponent({
        componentId: 'happier-cli', strategy: 'remote-self-download', ssh: { target: 'arm-guest.test', auth: 'agent' },
      }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'arm64' }),
        runRemoteText: async ({ remoteCommand }) => { remoteCommands.push(remoteCommand); return { status: 0, stdout: '', stderr: '' }; },
        copyLocalDirectoryToRemote: async () => { uploads++; },
        resolveSelfDownloadInstallPlan: async () => { throw new Error('Explicit payload must never fall back to releases'); },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: layout === 'flat' ? 'guest_architecture_unsupported' : 'guest_payload_missing', message: expect.stringContaining('linux-arm64') });
      expect(remoteCommands).toEqual([]);
      expect(uploads).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('selects only the ARM payload from a multi-target operator root', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'happier-multi-target-home-'));
    const fixture = await createPayloadRootFixture();
    try {
      const collection = join(home, 'payloads');
      await mkdir(collection);
      await cp(fixture.payloadRoot, join(collection, 'linux-arm64'), { recursive: true });
      await mkdir(join(collection, 'linux-x64'));
      await writeFile(join(collection, 'linux-x64', 'happier'), 'wrong target');
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', collection);
      const installed = await installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli' }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'arm64' }),
        runRemoteText: async ({ remoteCommand }) => ({ status: 0, ...await execFileAsync('/bin/sh', ['-c', remoteCommand], { env: { ...process.env, HOME: home } }) }),
        copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => { await cp(localPath, join(home, remotePath, basename(localPath)), { recursive: true }); },
      });
      expect(installed.source).toBe(`local-payload:${join(collection, 'linux-arm64')}`);
      expect(await readFile(join(home, '.happier/cli/current/happier'), 'utf8')).toBe(await readFile(join(fixture.payloadRoot, 'happier'), 'utf8'));
    } finally { await fixture.cleanup(); await rm(home, { recursive: true, force: true }); }
  });

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
      const nativeLsof = (await execFileAsync('/bin/sh', ['-c', 'command -v lsof'])).stdout.trim();
      const tools = join(home, 'tools');
      await mkdir(tools);
      // Keep real open-file evidence while excluding unrelated worker mount warnings;
      // diagnostic refusal is exercised at the shared census owner.
      await writeFile(join(tools, 'lsof'), '#!/bin/sh\nexec "$retention_native_lsof" -w "$@"\n', { mode: 0o755 });
      vi.stubEnv('PATH', `${tools}:${process.env.PATH}`);
      vi.stubEnv('retention_native_lsof', nativeLsof);
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
      await writeFile(join(installRoot, 'current.version'), '1.2.0\n');
      await writeFile(join(installRoot, 'previous.version'), '1.1.0\n');
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
        expect(await realpath(join(installRoot, 'current'))).toBe(join(versions, '1.3.0'));
        expect(await readFile(join(installRoot, 'previous', 'happier'), 'utf8')).toBe('1.2.0');
      }
      expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('outside');
      const remoteHome = join(home, '.happier');
      expect((await readdir(remoteHome)).filter(name => name.startsWith('bootstrap-self-download.'))).toEqual([]);
      expect(await readdir(join(remoteHome, 'bootstrap-staging')).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      })).toEqual([]);
    } finally {
      await runningPayload?.close();
      runningChild?.kill();
      await childExited;
      await fixture.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(['staging', 'transfer', 'cancellation', 'promotion transport'] as const)(
    'cleans only its own staging after a %s failure', async phase => {
      if (process.platform === 'win32') return;
      const home = await mkdtemp(join(tmpdir(), 'happier failed staging-'));
      const fixture = await createPayloadRootFixture();
      const remoteHome = join(home, '.happier');
      const stageParent = join(remoteHome, 'bootstrap-staging', 'happier-cli-1.2.3-123');
      const sibling = join(remoteHome, 'bootstrap-staging', 'another-install', 'keep');
      const controller = new AbortController();
      const failure = new Error(`fixture ${phase} failure`);
      try {
        await mkdir(join(sibling, '..'), { recursive: true });
        await writeFile(sibling, 'keep');
        const installation = installRemoteFirstPartyComponentPayload({
          componentId: 'happier-cli', signal: controller.signal,
        }, {
          now: () => 123,
          resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
          runRemoteText: async ({ remoteCommand, signal }) => {
            signal?.throwIfAborted();
            if (phase === 'promotion transport' && remoteCommand.includes('tar -xf')) throw failure;
            const result = await execFileAsync('/bin/sh', ['-c', remoteCommand], { env: { ...process.env, HOME: home } });
            if (phase === 'staging' && remoteCommand.startsWith('mkdir -p ')) {
              return { status: 1, stdout: '', stderr: 'mkdir: No space left on device' };
            }
            return { status: 0, ...result };
          },
          copyLocalDirectoryToRemote: async ({ localPath, remotePath, signal }) => {
            await cp(localPath, join(home, remotePath, basename(localPath)), { recursive: true });
            if (phase === 'cancellation') { controller.abort(failure); signal?.throwIfAborted(); }
            if (phase === 'transfer') throw failure;
          },
          preparePayload: async () => ({ componentId: 'happier-cli', channel: 'stable', versionId: '1.2.3', payloadRoot: fixture.payloadRoot, source: null, cleanup: async () => {} }),
        });
        if (phase === 'staging') await expect(installation).rejects.toMatchObject({ code: 'remote_storage_full' });
        else await expect(installation).rejects.toBe(failure);
        await expect(lstat(stageParent)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(sibling, 'utf8')).toBe('keep');
      } finally {
        await fixture.cleanup();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32').each([
    { strategy: 'scp-upload', cleanupFails: false },
    { strategy: 'remote-self-download', cleanupFails: false },
    { strategy: 'scp-upload', cleanupFails: true },
    { strategy: 'remote-self-download', cleanupFails: true },
  ] as const)('installs read-only staging over $strategy without failing on cleanup (refused: $cleanupFails)', async ({ strategy, cleanupFails }) => {
    const home = await mkdtemp(join(tmpdir(), 'happier readonly staging-'));
    const fixture = await createPayloadRootFixture();
    let promotionStderr = '';
    try {
      const nested = join(fixture.payloadRoot, 'readonly');
      await mkdir(nested);
      await writeFile(join(nested, 'data'), 'retained payload', { mode: 0o444 });
      await chmod(nested, 0o555);
      await chmod(fixture.payloadRoot, 0o555);
      const archive = join(home, 'payload.tar.gz');
      await execFileAsync('tar', ['-czf', archive, '-C', join(fixture.payloadRoot, '..'), basename(fixture.payloadRoot)]);
      if (cleanupFails) {
        const tools = join(home, 'tools');
        await mkdir(tools);
        const nativeRm = (await execFileAsync('/bin/sh', ['-c', 'command -v rm'])).stdout.trim();
        // OS boundary: simulate a removal refusal after the real install succeeds.
        await writeFile(join(tools, 'rm'), `#!/bin/sh
case "$2" in */bootstrap-staging/happier-cli-1.2.3-123|*/bootstrap-self-download.*) exit 73;; esac
exec "${nativeRm}" "$@"
`, { mode: 0o755 });
        vi.stubEnv('PATH', `${tools}:${process.env.PATH}`);
      }
      const plan = {
        binaryPath: '$HOME/.happier/cli/current/happier', versionId: '1.2.3', source: 'fixture',
        command: buildRemoteSelfDownloadFirstPartyInstallCommand({
          componentId: 'happier-cli', versionId: '1.2.3',
          archive: { name: 'payload.tar.gz', url: pathToFileURL(archive).href },
          expectedSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
        }),
      };
      await installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli', strategy }, {
        now: () => 123,
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async ({ remoteCommand }) => {
          try {
            const result = await execFileAsync('/bin/sh', ['-c', remoteCommand], { env: { ...process.env, HOME: home } });
            if (remoteCommand.includes('tar -xf')) promotionStderr = result.stderr;
            return { status: 0, ...result };
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number') throw error;
            if (remoteCommand.includes('tar -xf')) {
              expect(await readFile(join(home, '.happier', 'cli', 'current', 'readonly', 'data'), 'utf8')).toBe('retained payload');
              if (!cleanupFails) expect(String('stderr' in error ? error.stderr : '')).toContain('Permission denied');
            }
            return { status: error.code, stdout: '', stderr: String('stderr' in error ? error.stderr : '') };
          }
        },
        copyLocalDirectoryToRemote: async ({ localPath, remotePath }) => {
          await cp(localPath, join(home, remotePath, basename(localPath)), { recursive: true });
        },
        resolveSelfDownloadInstallPlan: async () => plan,
        preparePayload: async () => ({ componentId: 'happier-cli', channel: 'stable', versionId: '1.2.3', payloadRoot: fixture.payloadRoot, source: null, cleanup: async () => {} }),
      });
      const current = join(home, '.happier', 'cli', 'current');
      expect(await readFile(join(current, 'readonly', 'data'), 'utf8')).toBe('retained payload');
      expect(await realpath(current)).toBe(join(home, '.happier', 'cli', 'versions', '1.2.3'));
      expect((await lstat(fixture.payloadRoot)).mode & 0o777).toBe(0o555);
      const remoteHome = join(home, '.happier');
      const staging = strategy === 'scp-upload'
        ? await readdir(join(remoteHome, 'bootstrap-staging'))
        : (await readdir(remoteHome)).filter(name => name.startsWith('bootstrap-self-download.'));
      if (cleanupFails) {
        expect(staging).toHaveLength(1);
        expect(promotionStderr).toMatch(/warning.*cleanup/iu);
      } else {
        expect(staging).toEqual([]);
        expect(promotionStderr).toBe('');
      }
    } finally {
      // Restore only these test-owned scratch trees so a RED cannot mask itself during teardown.
      await execFileAsync('chmod', ['-R', 'u+w', fixture.payloadRoot, home]);
      await fixture.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves the transfer failure when remote staging cleanup is unreachable', async () => {
    const fixture = await createPayloadRootFixture();
    const failure = new Error('fixture transfer failure');
    try {
      await expect(installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli' }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async ({ remoteCommand }) => {
          if (remoteCommand.includes('rm -rf ')) throw new Error('fixture cleanup transport unavailable');
          return { status: 0, stdout: '', stderr: '' };
        },
        copyLocalDirectoryToRemote: async () => { throw failure; },
        preparePayload: async () => ({ componentId: 'happier-cli', channel: 'stable', versionId: '1.2.3', payloadRoot: fixture.payloadRoot, source: null, cleanup: async () => {} }),
      })).rejects.toBe(failure);
    } finally { await fixture.cleanup(); }
  });

  it.each([
    { phase: 'promotion', stderr: 'tar: private-path: Cannot write: No space left on device', code: 'remote_storage_full' },
    { phase: 'staging', stderr: 'mkdir: private-path: No space left on device', code: 'remote_storage_full' },
    { phase: 'staging', stderr: 'private-path: ENOSPC', code: 'remote_storage_full' },
    { phase: 'staging', stderr: 'private-path: [Errno 28]', code: 'remote_storage_full' },
    { phase: 'promotion', stderr: 'private-path: errno 28', code: 'remote_storage_full' },
    { phase: 'staging', stderr: 'private-path: [Errno 128] permission denied', code: 'remote_command_failed' },
  ] as const)('classifies $phase failure ($stderr)', async ({ phase, stderr, code }) => {
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
      if (code === 'remote_storage_full') expect(failure).toMatchObject({ message: expect.not.stringContaining('private-path') });
      if (code) expect(failure).toMatchObject({ code });
      else expect(failure).not.toHaveProperty('code');
      expect(uploads).toBe(phase === 'staging' ? 0 : 1);
      expect(promotions).toBe(phase === 'staging' ? 0 : 1);
    } finally { await fixture.cleanup(); }
  });

  it('retains the promotion exit and redacted stderr tail in a typed command failure', async () => {
    const fixture = await createPayloadRootFixture();
    try {
      const failure = await installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli' }, {
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async ({ remoteCommand }) => remoteCommand.includes('tar -xf')
          ? { status: 126, stdout: '', stderr: 'discarded-head-marker' + 'x'.repeat(DEFAULT_COMMAND_CAPTURE_MAX_BYTES)
            + '\nBearer private-token_123+/=; promotion: Permission denied\n' }
          : { status: 0, stdout: 'current=\nprevious=\n', stderr: '' },
        copyLocalDirectoryToRemote: async () => {},
        preparePayload: async () => ({ componentId: 'happier-cli', channel: 'stable', versionId: '1.2.3', payloadRoot: fixture.payloadRoot, source: null, cleanup: async () => {} }),
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'remote_command_failed', message: expect.stringContaining('exit 126') });
      expect(failure).toMatchObject({ message: expect.stringContaining('promotion: Permission denied') });
      expect(failure).toMatchObject({ message: expect.not.stringContaining('private-token_123') });
      expect(failure).toMatchObject({ message: expect.not.stringContaining('discarded-head-marker') });
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
      const phases: string[] = [];
      const installed = await installRemoteFirstPartyComponentPayload({ componentId: 'happier-cli', onPhase: phase => phases.push(phase) }, {
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
      expect(phases).toEqual(['prepare', 'archive', 'transfer', 'promote']);
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
      expect(remoteTextCommands.some((command) => command.includes('tar -xf'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('self __install-payload'))).toBe(true);
      expect(remoteTextCommands.some((command) => command.includes('HAPPIER_FIRST_PARTY_INSTALL_HOME="$HOME"/'))).toBe(true);
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

  it('rejects nonportable CLI version ids before sending a payload', async () => {
    const remoteTextCommands: string[] = [];
    const fixture = await createPayloadRootFixture();

    try {
      await expect(installRemoteFirstPartyComponent(
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
      )).rejects.toMatchObject({ code: 'FIRST_PARTY_VERSION_ID_INVALID' });
      expect(remoteTextCommands).toEqual([]);
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
