import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createLumeNativeClient } from './nativeClient.js';
import { resolveLumeBootstrap } from './bootstrap.js';

const resource = { storage: 'home', vmName: 'happier-ac2c7f10-2a41-4af1-88ac-d64eeb18bdc7' };
const credentialRef = { kind: 'shared_resource', resourceId: 'controller-private-key' } as const;
const hostKeyBytes = Buffer.from('public-host-key');
const hostKey = `ssh-ed25519 ${hostKeyBytes.toString('base64')}`;
const details = { name: resource.vmName, locationName: 'home', status: 'running', os: 'macos',
  cpuCount: 2, memorySize: 4 * 1024 ** 3, diskSize: { allocated: 1024 ** 3, total: 150 * 1024 ** 3 },
  ipAddress: '192.168.64.7', sshAvailable: true };
const result = (stdout = ''): PluginProcessResult => ({ stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(),
  termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdoutTruncated: false, stderrTruncated: false });

describe('Lume ordinary SSH carrier', () => {
  it('uses the explicitly prepared Linux account at the native carrier and preserves exact storage/name', async () => {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      requests.push(request);
      return request.executable.id.localId === 'ssh-keyscan' ? result(`192.168.64.7 ${hostKey}\n`) : result();
    } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json({ ...details, os: 'linux' }) });
    const carrier = await resolveLumeBootstrap({ native, exec, resource: { ...resource,
      privateCarrier: { kind: 'lume-default-password', guestOs: 'linux', user: 'linux-owner' } }, credentialRef,
      bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
      executable: { kind: 'managedDependency', id: { pluginId: 'happier.machine.lume', localId: 'lume-cli' } },
      scanner: { kind: 'systemTool', id: { pluginId: 'happier.machine.lume', localId: 'ssh-keyscan' } } });
    expect(carrier).toMatchObject({ kind: 'ssh', user: 'linux-owner', credentialRef });
    expect(requests.at(-1)?.args).toEqual(['ssh', resource.vmName, '--storage', resource.storage, '--user', 'linux-owner', '--timeout', '0', expect.stringContaining('authorized_keys')]);
    expect(requests.at(-1)?.args).not.toContain('--password');
  });

  it('refuses an unqualified Linux guest or selected guest OS mismatch before any key scan or guest write', async () => {
    let effects = 0;
    const exec: Pick<ExecService, 'run'> = { run: async () => { effects++; return result(); } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json({ ...details, os: 'linux' }) });
    const input = { native, exec, resource, credentialRef, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
      executable: { kind: 'managedDependency', id: { pluginId: 'happier.machine.lume', localId: 'lume-cli' } } as const,
      scanner: { kind: 'systemTool', id: { pluginId: 'happier.machine.lume', localId: 'ssh-keyscan' } } as const };
    await expect(resolveLumeBootstrap(input)).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(resolveLumeBootstrap({ ...input, resource: { ...resource,
      privateCarrier: { kind: 'lume-default-password', guestOs: 'macos', user: 'explicit-owner' } } }))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(effects).toBe(0);
  });

  it('passes only the public key to native argv and returns observed evidence plus the host-held private reference', async () => {
    const requests: Parameters<ExecService['run']>[0][] = [];
    const exec: Pick<ExecService, 'run'> = { run: async request => {
      requests.push(request);
      return request.executable.id.localId === 'ssh-keyscan' ? result(`192.168.64.7 ${hostKey}\n`) : result();
    } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json(details) });
    const carrier = await resolveLumeBootstrap({ native, exec, resource, credentialRef,
      bootstrapPublicKey: 'ssh-ed25519 cHVibGljLXJl c53-public',
      executable: { kind: 'managedDependency', id: { pluginId: 'happier.machine.lume', localId: 'lume-cli' } },
      scanner: { kind: 'systemTool', id: { pluginId: 'happier.machine.lume', localId: 'ssh-keyscan' } } });
    expect(carrier).toEqual({ kind: 'ssh', address: details.ipAddress, user: 'lume', port: 22, credentialRef,
      hostKeyEvidence: { hostKey, fingerprint: `SHA256:${createHash('sha256').update(hostKeyBytes).digest('base64').replace(/=+$/u, '')}` } });
    const install = requests.find(request => request.args?.[0] === 'ssh');
    expect(install?.args).toContain(resource.vmName);
    expect(install?.args).toContain(resource.storage);
    expect(install?.args?.at(-1)).toContain('authorized_keys');
    expect(JSON.stringify(requests)).not.toContain(credentialRef.resourceId);
    expect(requests.every(request => request.stdin === undefined)).toBe(true);
  });

  it('does not mutate when host public material or exact ready native connection is missing', async () => {
    let effects = 0;
    const exec: Pick<ExecService, 'run'> = { run: async () => { effects++; return result(); } };
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json({ ...details, locationName: 'neighbor' }) });
    const input = { native, exec, resource, credentialRef,
      executable: { kind: 'managedDependency', id: { pluginId: 'happier.machine.lume', localId: 'lume-cli' } } as const,
      scanner: { kind: 'systemTool', id: { pluginId: 'happier.machine.lume', localId: 'ssh-keyscan' } } as const };
    await expect(resolveLumeBootstrap(input)).rejects.toMatchObject({ code: 'credential_unavailable' });
    await expect(resolveLumeBootstrap({ ...input, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj' }))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(effects).toBe(0);
  });
});
