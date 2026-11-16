import { expect, it } from 'vitest';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { authorizeWorkspaceEffectLaunch } from './workspaceEffectProcess';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { resolveLocalExecutableOnPath } from '@/workspaces/source/localWorkspaceSource';

it.skipIf(process.platform !== 'linux')('gives the native member workspace child a usable Git search path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-member-scm-path-'));
  const identity = { kind: 'isolated' as const, separationRequired: true, requester: {
    serverId: 'home', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
  const member = { ...deriveAgentIsolationMemberIdentity({ ...identity, homeServerIdentityId: 'home' }),
    home: root, workspaceRoot: root, agentUid: 65534, agentGid: 65534 };
  const launch = await authorizeWorkspaceEffectLaunch({
    agentIsolation: { requesterIdentity: identity, read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1',
      status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [root],
      memberIdentity: member, localTransport: { agentUid: 65534, agentGid: 65534 },
      launch: { managedHappierBinaryPath: process.execPath, runtimeHome: join(root, 'runtime'),
        environment: {}, selectedEnvironmentKeys: [], selectedMaterials: [] } }) },
    requesterIdentity: identity, signal: new AbortController().signal, assertCurrent() {},
    managedHappierBinaryPath: process.execPath, workspaceRoot: root,
  });
  try {
    const frame = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble!], { objectMode: false }));
    const git = resolveLocalExecutableOnPath('git', frame.environment);
    expect(git).not.toBeNull();
    // CI without sudo still exercises the real launch frame and executable resolver.
    if (process.platform !== 'linux' || process.env.HAPPIER_RUN_REAL_UID_INTEGRATION !== '1') return;
    // The test-home owner deliberately removes sudo from the test process PATH.
    const sudo = resolveLocalExecutableOnPath('sudo', frame.environment);
    expect(sudo).not.toBeNull();
    await chmod(root, 0o755);
    const repo = join(root, 'repository');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync(sudo!, ['-n', 'chown', '-R', '65534:65534', repo]);
    try {
      // Match the shim environment without inheriting host Git configuration or credentials.
      const env = { ...frame.environment, HOME: member.home };
      const stdout = execFileSync(sudo!, ['-n', '-u', '#65534', '--', '/usr/bin/env', '-i',
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`), git!,
        '-c', 'safe.directory=', '-C', repo, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
      expect(stdout).toBe('true\n');
    } finally { execFileSync(sudo!, ['-n', 'chown', '-R', `${process.getuid!()}:${process.getgid!()}`, repo]); }
  } finally { await launch.release(); await rm(root, { recursive: true, force: true }); }
});
