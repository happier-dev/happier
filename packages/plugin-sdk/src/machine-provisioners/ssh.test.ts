import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessResult } from '../exec.js';
import * as ssh from './ssh.js';

describe('public managed SSH evidence carrier', () => {
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
      connection: { address: '192.0.2.1', user: 'root' }, credentialRef })).rejects.toThrow();
  });
});
