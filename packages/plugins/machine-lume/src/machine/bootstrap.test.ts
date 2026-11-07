import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createLumeNativeClient } from './nativeClient.js';
import { resolveLumeBootstrap } from './bootstrap.js';

const resource = { keepPasswordLogin: true, storage: 'home', vmName: 'happier-cmvnxb7gn009mmcagisyszwlh' };
const credentials = { materializeBootstrapCredential: async () => ({ kind: 'file' as const, path: '/private/controller-key', dispose: async () => {} }) };
const credentialRef = { kind: 'shared_resource', resourceId: 'controller-private-key' } as const;
const hostKeyBytes = Buffer.from('public-host-key');
const hostKey = `ssh-ed25519 ${hostKeyBytes.toString('base64')}`;
const details = { name: resource.vmName, locationName: 'home', status: 'running', os: 'macos',
  cpuCount: 2, memorySize: 4 * 1024 ** 3, diskSize: { allocated: 1024 ** 3, total: 150 * 1024 ** 3 },
  ipAddress: '192.168.64.7', sshAvailable: true };
const result = (stdout = ''): PluginProcessResult => ({ stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(),
  termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdoutTruncated: false, stderrTruncated: false });
function execBoundary(run: ExecService['run']): ExecService {
  // OS boundary fixture: this carrier uses only tool resolution and captured run.
  return { run, spawn: async () => { throw new Error('Unexpected policy transaction'); }, systemTools: { resolve: async ({ toolId }: { toolId: string }) => ({
    executable: { kind: 'systemTool', id: { pluginId: 'happier.machine.lume', localId: toolId } },
    executablePath: `/usr/bin/${toolId}`,
  }) } } as ExecService;
}

describe('Lume ordinary SSH carrier', () => {
  it('retains the native macOS capacity cause through bootstrap retry without starting SSH', async () => {
    let effects = 0;
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async input => {
      const stopped = { ...details, os: 'macOS', status: 'stopped', ipAddress: null, sshAvailable: null };
      return Response.json(new URL(String(input)).pathname === '/lume/vms'
        ? [stopped, ...[1, 2].map(index => ({ ...details, os: 'macOS', name: `other-${index}` }))] : stopped);
    } });
    await expect(resolveLumeBootstrap({ credentials, native, exec: execBoundary(async () => { effects++; return result(); }),
      resource, credentialRef, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' }))
      .rejects.toMatchObject({ name: 'PluginError', code: 'native_resource_unavailable',
        details: { nativeCause: { localCause: 'native_macos_vm_limit_reached' } } });
    expect(effects).toBe(0);
  });

  it.each(['stopped', 'error', 'deleting', 'unknown', 'provisioning'])(
    'waits only on positive native startup facts (%s)', async status => {
      let reads = 0;
      let effects = 0;
      const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async input => {
        reads++;
        return Response.json(new URL(String(input)).pathname === '/lume/vms' ? [{ ...details, status }] : { ...details, status });
      } });
      await expect(resolveLumeBootstrap({ credentials, native, exec: execBoundary(async () => { effects++; return result(); }),
        resource, credentialRef, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' }))
        .rejects.toMatchObject({ name: 'PluginError', code: status === 'provisioning' ? 'native_not_ready' : 'native_resource_unavailable' });
      expect(reads).toBe(status === 'stopped' ? 2 : 1);
      expect(effects).toBe(0);
    });

  it.each(['empty', 'failed', 'cancelled'] as const)('settles unusable host-key evidence before guest mutation (%s)', async outcome => {
    const abort = new AbortController();
    let scans = 0;
    let writes = 0;
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      if (request.executable.id.localId !== 'ssh-keyscan') { writes++; return result(); }
      scans++;
      if (outcome === 'cancelled') { abort.abort(); throw abort.signal.reason; }
      if (outcome === 'failed') throw new Error('private native scan failure');
      return result();
    } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json(details) });
    const work = resolveLumeBootstrap({ credentials, native, exec: execBoundary(exec.run), resource, credentialRef, signal: abort.signal,
      bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' });
    await expect(work).rejects.toMatchObject(outcome === 'cancelled' ? { name: 'AbortError' }
      : { name: 'PluginError', code: 'native_ssh_host_key_unavailable' });
    expect(scans).toBe(1);
    expect(writes).toBe(0);
  });

  it('uses the explicitly prepared Linux account at the native carrier and preserves exact storage/name', async () => {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      requests.push(request);
      return request.executable.id.localId === 'ssh-keyscan' ? result(`192.168.64.7 ${hostKey}\n`)
        : request.args?.at(-1) === 'true' ? { ...result(), termination: { observed: { kind: 'exit', exitCode: requests.filter(r => r.args?.at(-1) === 'true').length === 1 ? 255 : 0 }, requestedBy: { kind: 'none' } } } : result();
    } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json({ ...details, os: 'linux' }) });
    const carrier = await resolveLumeBootstrap({ credentials, native, exec: execBoundary(exec.run), resource: { ...resource, keepPasswordLogin: false,
      privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'linux-owner' } }, credentialRef,
      bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' });
    expect(carrier).toMatchObject({ kind: 'ssh', user: 'linux-owner', credentialRef });
    expect(requests.at(-1)?.args).toContain('linux-owner@192.168.64.7');
    expect(requests.at(-1)?.args).not.toContain('--password');
  });

  it('never lets a login starting with a dash reach ssh option parsing', async () => {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      requests.push(request);
      return request.executable.id.localId === 'ssh-keyscan' ? result(`192.168.64.7 ${hostKey}\n`)
        : request.args?.at(-1) === 'true' ? { ...result(), termination: { observed: { kind: 'exit', exitCode: requests.filter(r => r.args?.at(-1) === 'true').length === 1 ? 255 : 0 }, requestedBy: { kind: 'none' } } } : result();
    } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json({ ...details, os: 'linux' }) });
    const target = '-oProxyCommand=touch@192.168.64.7';
    await resolveLumeBootstrap({ credentials, native, exec: execBoundary(exec.run), resource: { ...resource,
      privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: '-oProxyCommand=touch' } }, credentialRef,
      bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' }).catch(() => undefined);
    const args = requests.find(request => request.args.includes(target))?.args ?? [];
    expect(args[args.indexOf(target) - 1]).toBe('--');
  });

  it('refuses an unqualified Linux guest or selected guest OS mismatch before any key scan or guest write', async () => {
    let effects = 0;
    const exec: Pick<ExecService, 'run'> = { run: async () => { effects++; return result(); } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json({ ...details, os: 'linux' }) });
    const input = { credentials, native, exec: execBoundary(exec.run), resource, credentialRef, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' };
    await expect(resolveLumeBootstrap(input)).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(resolveLumeBootstrap({ credentials, ...input, resource: { ...resource,
      privateCarrier: { kind: 'lume-default-password', guestOs: 'macos', user: 'explicit-owner' } } }))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(effects).toBe(0);
  });

  it('passes only the public key to native argv and returns observed evidence plus the host-held private reference', async () => {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      requests.push(request);
      return request.executable.id.localId === 'ssh-keyscan' ? result(`192.168.64.7 ${hostKey}\n`) : request.args?.at(-1) === 'true' && requests.filter(r => r.args?.at(-1) === 'true').length === 1 ? { ...result(), termination: { observed: { kind: 'exit', exitCode: 255 }, requestedBy: { kind: 'none' } } } : result();
    } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json(details) });
    const carrier = await resolveLumeBootstrap({ credentials, native, exec: execBoundary(exec.run), resource, credentialRef,
      bootstrapPublicKey: 'ssh-ed25519 cHVibGljLXJl c53-public' });
    expect(carrier).toEqual({ kind: 'ssh', address: details.ipAddress, user: 'lume', port: 22, credentialRef,
      hostKeyEvidence: { hostKey: `${details.ipAddress} ${hostKey}`, fingerprint: `SHA256:${createHash('sha256').update(hostKeyBytes).digest('base64').replace(/=+$/u, '')}` } });
    const install = requests.find(request => request.args?.at(-1)?.includes('authorized_keys'));
    expect(install?.args).toContain(`lume@${details.ipAddress}`);
    expect(install?.args?.at(-1)).toContain('authorized_keys');
    expect(requests.some(request => request.executable.id.localId === 'lume-cli')).toBe(false);
    expect(JSON.stringify(requests.map(request => request.args))).not.toContain(credentialRef.resourceId);
  });

  it('authenticates the image default login through a private askpass helper that is gone afterwards', async () => {
    let seen: { askpass: string; mode: number; dirMode: number; knownHosts: string; script: string } | undefined;
    let argv: readonly string[] = [];
    let env: Readonly<Record<string, string>> = {};
    let proofs = 0;
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      if (request.executable.id.localId === 'ssh-keyscan') return result(`192.168.64.7 ${hostKey}\n`);
      if (request.args?.at(-1) === 'true') return { ...result(), termination: { observed: { kind: 'exit', exitCode: ++proofs === 1 ? 255 : 0 }, requestedBy: { kind: 'none' } } };
      argv = request.args ?? []; env = request.env ?? {};
      const askpass = env.SSH_ASKPASS!;
      const known = argv.find(arg => arg.startsWith('UserKnownHostsFile='))!;
      seen = { askpass, mode: statSync(askpass).mode & 0o777, dirMode: statSync(dirname(askpass)).mode & 0o777,
        knownHosts: readFileSync(known.slice('UserKnownHostsFile='.length), 'utf8'), script: readFileSync(askpass, 'utf8') };
      return result();
    } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json(details) });
    await resolveLumeBootstrap({ credentials, native, exec: execBoundary(exec.run), resource, credentialRef, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' });
    expect(env).toMatchObject({ SSH_ASKPASS_REQUIRE: 'force', HAPPIER_LUME_GUEST_PASSWORD: 'lume' });
    expect(argv).not.toContain('lume');
    expect(argv.some(arg => arg.includes('HAPPIER_LUME_GUEST_PASSWORD'))).toBe(false);
    expect(argv).toContain('StrictHostKeyChecking=yes');
    expect(seen).toMatchObject({ mode: 0o700, dirMode: 0o700, knownHosts: `${details.ipAddress} ${hostKey}\n` });
    expect(seen?.script).not.toContain('lume');
    expect(existsSync(dirname(env.SSH_ASKPASS!))).toBe(false);
  });

  it('ignores a stopped native run-state probe because the serve API is the only run-state owner', async () => {
    const exec: Pick<ExecService, 'run'> = { run: async request => request.executable.id.localId === 'ssh-keyscan' ? result(`192.168.64.7 ${hostKey}\n`) : result() };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json(details) });
    await expect(resolveLumeBootstrap({ credentials, native, exec: execBoundary(exec.run), resource, credentialRef, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' }))
      .resolves.toMatchObject({ kind: 'ssh', address: details.ipAddress });
  });

  it('does not mutate when host public material or exact ready native connection is missing', async () => {
    let effects = 0;
    const exec: Pick<ExecService, 'run'> = { run: async () => { effects++; return result(); } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json({ ...details, locationName: 'neighbor' }) });
    const input = { credentials, native, exec: execBoundary(exec.run), resource, credentialRef };
    await expect(resolveLumeBootstrap(input)).rejects.toMatchObject({ code: 'credential_unavailable' });
    await expect(resolveLumeBootstrap({ credentials, ...input, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' }))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(effects).toBe(0);
  });
});

describe('macOS password policy (owner opt-in ruling 2026-11-06)', () => {
  it.each([
    { outcome: 'commit', prior: true }, { outcome: 'key-failed', prior: true },
    { outcome: 'configuration-failed', prior: true }, { outcome: 'ineffective-policy', prior: true },
    { outcome: 'key-failed', prior: false },
  ])('runs the emitted remote shell and preserves policy on $outcome (prior=$prior)', async ({ outcome, prior }) => {
    const directory = await mkdtemp(join(tmpdir(), 'lume-policy-shell-'));
    const policy = join(directory, 'sshd_config.d', '000-happier-key-only.conf');
    const before = '# Prior local configuration\n';
    let proofs = 0;
    let remoteResult: PluginProcessResult | undefined;
    const exec = execBoundary(async request => {
      if (request.executable.id.localId === 'ssh-keyscan') return result(`192.168.64.7 ${hostKey}\n`);
      if (request.args?.at(-1) === 'true' && ++proofs === 2 && outcome === 'key-failed') {
        return { ...result(), termination: { observed: { kind: 'exit', exitCode: 255 }, requestedBy: { kind: 'none' } } };
      }
      return result();
    });
    // Genuine process/privilege/sshd boundaries: run the emitted shell unchanged
    // except for absolute guest paths and native executables, inside OS temp.
    exec.spawn = async request => {
      const command = request.args?.at(-1)?.replaceAll('/etc/ssh/sshd_config.d', join(directory, 'sshd_config.d'))
        .replaceAll('/usr/sbin/sshd', join(directory, 'sshd')).replaceAll('sudo ', `${join(directory, 'sudo')} `);
      if (!command) throw new Error('Missing remote command');
      const child = spawn('/bin/sh', ['-c', command], { env: { ...process.env, SSH_CONNECTION: '192.0.2.10 50000 192.168.64.7 22' } });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      const listeners = new Set<Parameters<PluginProcessHandle['onOutput']>[0]>();
      child.stdout.on('data', (data: Buffer) => { stdout.push(data); for (const listener of listeners) listener({ sequence: 0, stream: 'stdout', data }); });
      child.stderr.on('data', (data: Buffer) => { stderr.push(data); });
      const ended = new Promise<PluginProcessResult>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => { remoteResult = { ...result(), stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
          termination: { observed: { kind: 'exit', exitCode: code ?? 1 }, requestedBy: { kind: 'none' } } }; resolve(remoteResult); });
      });
      return { write: bytes => new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve())),
        closeStdin: async () => { child.stdin.end(); }, async waitForExit() { return (await this.wait()).termination; },
        wait: () => ended,
        onOutput(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
        async dispose() { child.stdin.end(); await ended; }, [Symbol.dispose]() {} };
    };
    try {
      await mkdir(dirname(policy));
      if (prior) await writeFile(policy, before);
      // Password is read from stdin and discarded; neither boundary writes it.
      await writeFile(join(directory, 'sudo'), `#!/bin/sh\nif [ "$1" = -n ]; then exit 1; fi\nshift 3\nIFS= read -r credential || exit 1\nunset credential SSH_CONNECTION\nexec "$@"\n`, { mode: 0o700 });
      await writeFile(join(directory, 'sshd'), `#!/bin/sh\n[ "$1" = -t ] && exit ${outcome === 'configuration-failed' ? 1 : 0}\n${outcome === 'ineffective-policy'
        ? "printf 'passwordauthentication yes\\nkbdinteractiveauthentication yes\\n'"
        : `tr '[:upper:]' '[:lower:]' < '${policy}'`}\n`, { mode: 0o700 });
      const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json(details) });
      const work = resolveLumeBootstrap({ native, exec, credentials, resource: { storage: resource.storage, vmName: resource.vmName }, credentialRef,
        bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' });
      if (outcome === 'commit') {
        await expect(work).resolves.toMatchObject({ kind: 'ssh' });
        expect(await readFile(policy, 'utf8')).toBe('PasswordAuthentication no\nKbdInteractiveAuthentication no\n');
      } else {
        await expect(work).rejects.toMatchObject({ code: outcome === 'key-failed' ? 'native_ssh_post_policy_key_failed' : 'native_ssh_password_policy_failed' });
        if (prior) expect(await readFile(policy, 'utf8')).toBe(before);
        else expect(existsSync(policy)).toBe(false);
      }
      expect(new TextDecoder().decode(remoteResult?.stdout)).not.toContain('lume');
      expect(new TextDecoder().decode(remoteResult?.stderr)).not.toContain('lume');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  function boundary(mode: 'sudo-n' | 'sudo-password' | 'write-failed' | 'post-key-failed' | 'pre-key-failed') {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const writes: string[] = [];
    let disposed = false;
    let leaseDisposed = false;
    let proofCount = 0;
    let listener: Parameters<PluginProcessHandle['onOutput']>[0] | undefined;
    let settle: (value: PluginProcessResult) => void = () => {};
    const ended = new Promise<PluginProcessResult>(resolve => { settle = resolve; });
    const fail = () => ({ ...result(), termination: { observed: { kind: 'exit' as const, exitCode: 1 }, requestedBy: { kind: 'none' as const } } });
    const emit = (text: string) => listener?.({ sequence: 0, stream: 'stdout', data: new TextEncoder().encode(text) });
    const exec = execBoundary(async request => {
      requests.push(request);
      if (request.executable.id.localId === 'ssh-keyscan') return result(`192.168.64.7 ${hostKey}\n`);
      if (request.args?.at(-1) === 'true') {
        proofCount++;
        if (mode === 'pre-key-failed' || mode === 'post-key-failed' && proofCount === 2) return fail();
      }
      return result();
    });
    exec.spawn = async request => {
      requests.push(request);
      return {
        async write(bytes) {
          const text = new TextDecoder().decode(bytes); writes.push(text);
          if (text === 'BEGIN\n') {
            if (mode === 'write-failed') settle(fail());
            else if (mode === 'sudo-password') { emit('PASS'); emit('WORD\n'); }
            else { emit('REA'); emit('DY\n'); }
          }
          if (text === 'lume\n') emit('READY\n');
          if (text === 'COMMIT\n') settle(result());
        },
        async closeStdin() { settle(fail()); },
        async waitForExit() { return (await this.wait()).termination; },
        wait: () => ended,
        onOutput(callback) {
          listener = callback;
          return { dispose() {} };
        },
        async dispose() { disposed = true; settle(fail()); },
        [Symbol.dispose]() {},
      };
    };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json(details) });
    const work = (keepPasswordLogin?: boolean) => resolveLumeBootstrap({ native, exec,
      resource: { storage: resource.storage, vmName: resource.vmName,
        privateCarrier: { kind: 'lume-default-password', guestOs: 'macos', user: 'guest-admin' },
        ...(keepPasswordLogin === undefined ? {} : { keepPasswordLogin }) },
      credentialRef, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj', credentials: {
        materializeBootstrapCredential: async () => ({ kind: 'file' as const, path: '/private/controller-key', dispose: async () => { leaseDisposed = true; } }),
      } });
    return { work, requests, writes, state: () => ({ disposed, leaseDisposed }) };
  }

  it.each(['sudo-n', 'sudo-password'] as const)('hardens after fresh key auth using %s and commits only after a second fresh key proof', async mode => {
    const runtime = boundary(mode);
    await expect(runtime.work()).resolves.toMatchObject({ kind: 'ssh' });
    const proof = runtime.requests.filter(request => request.args?.at(-1) === 'true');
    expect(proof).toHaveLength(2);
    for (const request of proof) {
      expect(request.args).toEqual(expect.arrayContaining(['BatchMode=yes', 'IdentitiesOnly=yes', 'ControlPath=none', '/private/controller-key']));
      expect(request.env ?? {}).not.toHaveProperty('HAPPIER_LUME_GUEST_PASSWORD');
    }
    const policy = runtime.requests.find(request => request.args?.at(-1)?.includes('sshd_config.d'));
    expect(policy?.args?.at(-1)).toContain('sudo -n');
    expect(policy?.args?.at(-1)).toContain("sudo -S -p ''");
    expect(policy?.args?.at(-1)).toContain('PasswordAuthentication no');
    expect(policy?.args?.at(-1)).toContain('KbdInteractiveAuthentication no');
    expect(policy?.args?.at(-1)).toContain('trap');
    expect(runtime.writes).toEqual(mode === 'sudo-password' ? ['BEGIN\n', 'lume\n', 'COMMIT\n'] : ['BEGIN\n', 'COMMIT\n']);
    expect(runtime.requests.some(request => request.env?.HAPPIER_LUME_GUEST_PASSWORD)).toBe(false);
    // A distinct prepared login avoids confusing the published password with
    // the default username. Exclude only the generated private directory name.
    expect(JSON.stringify(runtime.requests.map(request => request.args?.filter(arg => !arg.startsWith('UserKnownHostsFile=')))))
      .not.toContain('lume');
    expect(runtime.state()).toEqual({ disposed: true, leaseDisposed: true });
  });

  it('Retry uses the retained key without password installation, and explicit opt-in skips hardening', async () => {
    const runtime = boundary('sudo-n');
    await runtime.work(true);
    expect(runtime.requests.filter(request => request.executable.id.localId === 'ssh')).toHaveLength(1);
    expect(runtime.requests.some(request => request.env?.SSH_ASKPASS)).toBe(false);
    expect(runtime.writes).toEqual([]);
    expect(runtime.state().leaseDisposed).toBe(true);
  });

  it.each(['write-failed', 'post-key-failed', 'pre-key-failed'] as const)('settles %s with a typed cause and never commits the policy', async mode => {
    const runtime = boundary(mode);
    await expect(runtime.work(false)).rejects.toMatchObject({ name: 'PluginError', code: mode === 'pre-key-failed'
      ? 'native_ssh_key_authentication_failed' : mode === 'post-key-failed' ? 'native_ssh_post_policy_key_failed' : 'native_ssh_password_policy_failed' });
    expect(runtime.writes).not.toContain('COMMIT\n');
    if (mode === 'pre-key-failed') expect(runtime.requests.some(request => request.args?.at(-1)?.includes('sshd_config.d'))).toBe(false);
    expect(runtime.state().leaseDisposed).toBe(true);
  });
});
