import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAgyNativeCredential, readAgyNativeCredential, serializeAgyNativeCliCredential } from './nativeCredentials';

vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return { ...real, readFile: vi.fn(real.readFile), stat: vi.fn(real.stat) };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const nativeToken = (refreshToken: string) => JSON.stringify({ auth_method: 'consumer', token: { access_token: 'access', refresh_token: refreshToken } });
const missing = () => Object.assign(new Error('missing synthetic file'), { code: 'ENOENT' });
let home: string;
let cgroup = '';
let osrelease = 'Linux';
let docker = false;

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'agy-native-selection-'));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('GEMINI_HOME', '');
  for (const key of ['SSH_TTY', 'SSH_CLIENT', 'SSH_CONNECTION', 'WSL_DISTRO_NAME', 'WSL_INTEROP']) vi.stubEnv(key, '');
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/synthetic/bus');
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
  cgroup = ''; osrelease = 'Linux'; docker = false;
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.readFile).mockImplementation(((file: Parameters<typeof fs.readFile>[0], options?: unknown) => {
    if (String(file) === '/proc/1/cgroup') return Promise.resolve(cgroup);
    if (String(file) === '/proc/sys/kernel/osrelease') return Promise.resolve(osrelease);
    return real.readFile(file, options as Parameters<typeof fs.readFile>[1]);
  }) as typeof fs.readFile);
  vi.mocked(fs.stat).mockImplementation(((file: Parameters<typeof fs.stat>[0], options?: unknown) => {
    if (String(file) === '/.dockerenv') return docker ? real.stat(home) : Promise.reject(missing());
    return real.stat(file, options as Parameters<typeof fs.stat>[1]);
  }) as typeof fs.stat);
  await fs.mkdir(join(home, '.gemini/antigravity-cli/cache'), { recursive: true });
  await fs.writeFile(join(home, '.gemini/antigravity-cli/antigravity-oauth-token'), nativeToken('file-account'));
  vi.mocked(childProcess.spawn).mockImplementation(() => {
    const child = new ChildProcess();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => { child.stdout?.emit('data', nativeToken('keyring-account')); child.emit('close', 0); });
    return child;
  });
});
afterEach(async () => { Object.defineProperty(process, 'platform', platformDescriptor); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.mocked(childProcess.spawn).mockReset(); await fs.rm(home, { recursive: true, force: true }); });

describe('native CLI 1.3.3 storage selection', () => {
  it('uses the native Keyring account when no bypass applies', async () => {
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'keyring-account' });
    expect(childProcess.spawn).toHaveBeenCalledWith('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity'], expect.anything());
  });
  it.each(['SSH_TTY', 'SSH_CLIENT', 'SSH_CONNECTION', 'WSL_DISTRO_NAME', 'WSL_INTEROP'])('uses the native file under %s without adopting a stale Keyring account', async (key) => {
    vi.stubEnv(key, 'synthetic-value');
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'file-account' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
  it.each(['docker', 'containerd', 'kubepods'])('uses the native file for %s cgroups', async (kind) => {
    cgroup = `1:name=systemd:/${kind}/synthetic`;
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'file-account' });
  });
  it('uses the native file when /.dockerenv is present', async () => {
    docker = true;
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'file-account' });
  });
  it('recognizes a WSL kernel without environment hints', async () => {
    osrelease = '5.15.0-Microsoft-standard-WSL2';
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'file-account' });
  });
  it.each(['', 'none:', 'disabled:'])('uses the native file for unavailable D-Bus address %j', async (address) => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', address); vi.stubEnv('XDG_RUNTIME_DIR', join(home, 'runtime'));
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'file-account' });
  });
  it('keeps Keyring selected when the default D-Bus address has a socket', async () => {
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', ''); vi.stubEnv('XDG_RUNTIME_DIR', join(home, 'runtime'));
    const info = await fs.stat(home);
    vi.spyOn(info, 'isSocket').mockReturnValue(true);
    const originalStat = vi.mocked(fs.stat).getMockImplementation()!;
    vi.mocked(fs.stat).mockImplementation(((file: Parameters<typeof fs.stat>[0], options?: unknown) =>
      String(file) === join(home, 'runtime/bus') ? Promise.resolve(info) : originalStat(file, options as Parameters<typeof fs.stat>[1])) as typeof fs.stat);
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'keyring-account' });
  });
  it('tries Keyring when the native detector budget expires', async () => {
    vi.useFakeTimers();
    const originalRead = vi.mocked(fs.readFile).getMockImplementation()!;
    vi.mocked(fs.readFile).mockImplementation(((file: Parameters<typeof fs.readFile>[0], options?: unknown) =>
      String(file).startsWith('/proc/') ? new Promise(() => {}) : originalRead(file, options as Parameters<typeof fs.readFile>[1])) as typeof fs.readFile);
    const originalStat = vi.mocked(fs.stat).getMockImplementation()!;
    vi.mocked(fs.stat).mockImplementation(((file: Parameters<typeof fs.stat>[0], options?: unknown) =>
      String(file) === '/.dockerenv' ? new Promise(() => {}) : originalStat(file, options as Parameters<typeof fs.stat>[1])) as typeof fs.stat);
    const result = readAgyNativeCredential('cli');
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toMatchObject({ refreshToken: 'keyring-account' });
  });
  it('uses file storage when the native five-second Keyring read budget expires', async () => {
    vi.useFakeTimers();
    const kill = vi.fn(() => true);
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = new ChildProcess(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      vi.spyOn(child, 'kill').mockImplementation(() => { kill(); child.emit('close', 0); return true; });
      queueMicrotask(() => child.stdout?.emit('data', nativeToken('timed-out-keyring-account')));
      return child;
    });
    const result = readAgyNativeCredential('cli');
    await vi.waitFor(() => expect(childProcess.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toMatchObject({ refreshToken: 'file-account' });
    expect(kill).toHaveBeenCalled();
  });
  it('preserves cancellation when terminating the Keyring process immediately closes it', async () => {
    const controller = new AbortController();
    const kill = vi.fn(() => true);
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = new ChildProcess(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      vi.spyOn(child, 'kill').mockImplementation(() => { kill(); child.emit('close', 0); return true; });
      queueMicrotask(() => child.stdout?.emit('data', nativeToken('cancelled-keyring-account')));
      return child;
    });
    const result = readAgyNativeCredential('cli', controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(childProcess.spawn).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(kill).toHaveBeenCalled();
  });
  it('uses recent marker modification time without deleting or rewriting the marker', async () => {
    const marker = join(home, '.gemini/antigravity-cli/cache/antigravity-keyring-unavailable');
    await fs.writeFile(marker, 'not a timestamp');
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'file-account' });
    expect(await fs.readFile(marker, 'utf8')).toBe('not a timestamp');
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
  it('uses the native file when Keyring data is malformed JSON', async () => {
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = new ChildProcess(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stdout?.emit('data', '{invalid'); child.emit('close', 0); });
      return child;
    });
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'file-account' });
  });
  it('uses the native file when Keyring JSON cannot decode as either native token object', async () => {
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = new ChildProcess(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stdout?.emit('data', '[]'); child.emit('close', 0); });
      return child;
    });
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'file-account' });
  });
  it('does not adopt the file when Keyring holds a business login', async () => {
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = new ChildProcess(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stdout?.emit('data', JSON.stringify({ auth_method: 'business', token: { refresh_token: 'business' } })); child.emit('close', 0); });
      return child;
    });
    await expect(readAgyNativeCredential('cli')).rejects.toMatchObject({ code: 'credentials_unavailable' });
  });
  it('tries Keyring again for an old marker but leaves the native marker intact', async () => {
    const marker = join(home, '.gemini/antigravity-cli/cache/antigravity-keyring-unavailable');
    await fs.writeFile(marker, 'old'); await fs.utimes(marker, 0, new Date(Date.now() - 3_600_000 - 1000));
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'keyring-account' });
    expect(await fs.readFile(marker, 'utf8')).toBe('old');
  });
});


describe('platform authority', () => {
  it.each(['linux', 'darwin', 'win32'])('reads the explicitly selected CLI file on %s even when a different Keyring account exists', async (platform) => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    await expect(readAgyNativeCredential('cli-file')).resolves.toMatchObject({ refreshToken: 'file-account' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
  it('does not apply the Linux D-Bus bypass to macOS', async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', '');
    await expect(readAgyNativeCredential('cli')).resolves.toMatchObject({ refreshToken: 'keyring-account' });
    expect(childProcess.spawn).toHaveBeenCalledWith('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], expect.anything());
  });
  it('refuses an unproven Windows native CLI storage contract instead of adopting a stale file', async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    await expect(readAgyNativeCredential('cli')).rejects.toMatchObject({ code: 'credentials_unavailable' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});


describe('CLI token envelope codec', () => {
  it('reads back what connected-account materialization writes', () => {
    const now = Date.parse('2026-11-26T00:00:00.000Z');
    const written = serializeAgyNativeCliCredential({ accessToken: 'access', refreshToken: 'refresh', expiresAt: now + 3_600_000, email: 'a@example.test' }, now);
    expect(written).toMatchObject({ auth_method: 'consumer', id_token_email: 'a@example.test', token: { token_type: 'Bearer', expires_in: 3600 } });
    expect(parseAgyNativeCredential(JSON.parse(JSON.stringify(written)))).toEqual({ accessToken: 'access', refreshToken: 'refresh', expiresAt: now + 3_600_000 });
  });
  it('writes an unknown expiry as already expired so the CLI refreshes first', () => {
    const written = serializeAgyNativeCliCredential({ accessToken: null, refreshToken: 'refresh', expiresAt: null, email: null });
    expect(parseAgyNativeCredential(written)).toEqual({ accessToken: null, refreshToken: 'refresh', expiresAt: 0 });
  });
  it('rejects business and retired-server token shapes', () => {
    expect(parseAgyNativeCredential({ auth_method: 'business', token: { refresh_token: 'refresh' } })).toBeNull();
    expect(parseAgyNativeCredential({ client_id: 'client', refresh_token: 'refresh' })).toBeNull();
  });
});

describe('machine login profile', () => {
  it('reads the CLI file from the GEMINI_HOME profile that machine-login sessions use', async () => {
    vi.stubEnv('GEMINI_HOME', join(home, 'profile'));
    await fs.mkdir(join(home, 'profile/antigravity-cli'), { recursive: true });
    await fs.writeFile(join(home, 'profile/antigravity-cli/antigravity-oauth-token'), nativeToken('profile-account'));
    await expect(readAgyNativeCredential('cli-file')).resolves.toMatchObject({ refreshToken: 'profile-account' });
  });
});
