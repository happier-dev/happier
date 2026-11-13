import { expect, it, vi } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import * as processBoundary from '@happier-dev/cli-common/process';
import { withTempDir } from '@/testkit/fs/tempDir';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { createUnixAgentIdentityLaunch } from '@/daemon/agentIsolation/unixAgentIdentityAdapter';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { executeAgentLaunchPayload } from '@/daemon/agentIsolation/agentLaunchShim';
import { prepareAgentAuxiliaryNativeOperation } from './agentAuxiliaryNativeOperation';

it.skipIf(process.platform !== 'linux')('retains member native defaults across independently admitted finite reads and retires every operation runtime', async () => {
  await withTempDir('auxiliary-member-native-', async home => {
    const requester = { serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' };
    const identity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home', requester }), agentUid: 2401, agentGid: 2401 };
    let reads = 0, retirements = 0;
    const native = vi.spyOn(processBoundary, 'execFileWithDeadline').mockImplementation(async (...args) => {
      expect(args[0]).toBe('sudo');
      expect(args[1]).toEqual(['-n', '-u', identity.username, '--', '/managed/happier', 'agent-launch']);
      const frame = await readAgentLaunchFrame(Readable.from([args[2]!.inputBytes!], { objectMode: false }), undefined, true);
      if (!('action' in frame)) throw new Error('Unexpected OS command');
      expect(frame.nativeIdentity).toMatchObject({ home: identity.home, agentUid: identity.agentUid });
      await executeAgentLaunchPayload({ ...frame, runtimeHome: frame.runtimeHome.replace(identity.home, home) }, {
        agentHome: home, input: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() });
      retirements++;
      return { stdout: '', stderr: '' };
    });
    const machine = { managedHappierBinaryPath: '/managed/happier',
      read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1' as const,
        status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' as const }, workspaceRoots: [] }),
      async readMember() { reads++; return { identity, daemonObservation: { daemonIdentity: 'nonRoot' as const,
        daemonUid: 1001, daemonUsername: 'happier', daemonPrimaryGroup: 'happier' } }; },
      async prepareMember() { throw new Error('Existing member must not be re-prepared for a native page'); },
    };
    const sources: string[] = [], runtimes: string[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const operation = await prepareAgentAuxiliaryNativeOperation({ machine, requester, correlationId: `read-${index}`, signal: new AbortController().signal });
        try {
          const snapshot = operation.agentIsolation.read()!;
          expect(snapshot.memberIdentity).toEqual(identity);
          expect(snapshot.localTransport).toEqual({ agentUid: 2401, agentGid: 2401 });
          const selected = snapshot.launch!;
          runtimes.push(selected.runtimeHome);
          const dispatch = createUnixAgentIdentityLaunch({ ...selected, environment: selected.environment ?? {}, executable: process.execPath,
            args: ['-e', 'process.stdout.write(process.env.XDG_DATA_HOME)'], cwd: identity.workspaceRoot,
            memberIdentity: identity });
          const frame = await readAgentLaunchFrame(Readable.from([dispatch.stdinPreamble], { objectMode: false }));
          const output = new PassThrough(); let source = '';
          output.on('data', chunk => { source += String(chunk); });
          // Only OS identity/path mapping is substituted; the native child,
          // material framing, launch shim and retirement use real processes/disk.
          expect(await executeAgentLaunchPayload({ ...frame, cwd: home,
            runtimeHome: frame.runtimeHome.replace(identity.home, home) }, {
              agentHome: home, input: Readable.from([]), stdout: output, stderr: new PassThrough() })).toEqual({ code: 0, signal: null });
          sources.push(source);
        } finally { await operation.dispose(); }
        expect(retirements).toBe(index + 1);
      }
      expect(sources).toEqual([join(identity.home, '.local/share'), join(identity.home, '.local/share')]);
      expect(new Set(runtimes).size).toBe(2);
      expect(reads).toBe(2);
      expect(await readdir(join(home, 'runtime/operations'))).toEqual([]);
    } finally { native.mockRestore(); }
  });
});
