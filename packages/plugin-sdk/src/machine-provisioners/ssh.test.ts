import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessResult } from '../exec.js';
import * as ssh from './ssh.js';
import { parse } from 'yaml';
import { MachineProvisionerBootstrapCarrierV1Schema } from '../machineProvisioners.js';

describe('public managed SSH evidence carrier', () => {
  it('leaves retained native SSH first trust to the host when no daemon exec is available', async () => {
    const credentialRef = { kind: 'shared_resource' as const, resourceId: 'retained-key' };
    const carrier = await ssh.resolveMachineProvisionerSshBootstrap({
      connection: { address: '192.0.2.1', user: 'root', port: 2222 }, credentialRef,
    });
    expect(carrier).toEqual({ kind: 'ssh', address: '192.0.2.1', user: 'root', port: 2222, credentialRef });
    expect(MachineProvisionerBootstrapCarrierV1Schema.parse(carrier)).toEqual(carrier);
    await expect(ssh.resolveMachineProvisionerSshBootstrap({ connection: { address: '192.0.2.1', user: 'root' } }))
      .rejects.toMatchObject({ code: 'credential_unavailable' });
  });
  it('creates a key-only bootstrap principal without granting authority to the dedicated daemon user', () => {
    const build = (ssh as unknown as Record<string, unknown>).buildMachineProvisionerCloudInit;
    expect(build).toBeTypeOf('function');
    const config = parse((build as (key: string) => string)('ssh-ed25519 public-key'));
    expect(config).toEqual({
      users: [{ name: 'happier-bootstrap', shell: '/bin/bash', lock_passwd: true,
        sudo: 'ALL=(ALL) NOPASSWD:ALL', ssh_authorized_keys: ['ssh-ed25519 public-key'] }],
      ssh_pwauth: false,
    });
    expect((ssh as unknown as Record<string, unknown>).MACHINE_PROVISIONER_CLOUD_SSH_USER).toBe(config.users[0].name);
    expect(config.users.some((user: { name: string }) => user.name === 'happier')).toBe(false);
  });
  it('uses the canonical known-host parser and preserves retained credential custody', async () => {
    const fn = (ssh as unknown as Record<string, unknown>).resolveMachineProvisionerSshBootstrap;
    expect(typeof fn).toBe('function');
    const resolve = fn as (input: unknown) => Promise<unknown>;
    const result: PluginProcessResult = { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
      stdout: new TextEncoder().encode('192.0.2.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest\n'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
    const exec = { systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'ssh-keyscan' } }) }, run: async () => result } as unknown as ExecService;
    const credentialRef = { kind: 'shared_resource', resourceId: 'retained-key' };
    expect(await resolve({ exec, connection: { address: '192.0.2.1', user: 'root' }, credentialRef })).toMatchObject({
      kind: 'ssh', credentialRef, hostKeyEvidence: { hostKey: '192.0.2.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest', fingerprint: expect.stringMatching(/^SHA256:/) },
    });
    await expect(resolve({ exec: { ...exec, run: async () => ({ ...result, stdoutTruncated: true }) },
      connection: { address: '192.0.2.1', user: 'root' }, credentialRef })).rejects.toMatchObject({
        name: 'PluginError', code: 'native_ssh_host_key_unavailable',
      });
  });
});
