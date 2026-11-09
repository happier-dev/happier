import { expect, it } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { chmod, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { executeAgentLaunchPayload } from '@/daemon/agentIsolation/agentLaunchShim';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { observeAgentIsolationMemberLaunchReadiness, type AgentIsolationReadinessSystem } from '@/daemon/agentIsolation/agentIsolationReadiness';
import { promoteVersionedPayload } from '@happier-dev/cli-common/firstPartyRuntime';

it.skipIf(process.platform !== 'linux')('publishes the member-separated status from successful native readiness', async () => {
  const identity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'canonical-home',
    requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' } }),
    agentUid: 2401, agentGid: 2401 };
  // The process is the OS boundary; native launch framing and readiness
  // interpretation remain real, including a failed probe beside success.
  for (const stdout of ['member-native-ready\n', '']) {
    const system: AgentIsolationReadinessSystem = { run: async () => ({ stdout, stderr: '' }) };
    expect(await observeAgentIsolationMemberLaunchReadiness({ installedCli: '/opt/happier/cli/current/happier', memberIdentity: identity, system }))
      .toEqual(stdout ? { kind: 'member_native_ready', status: { kind: 'effective', platform: 'linux' },
        directories: { home: identity.home, workspace: identity.workspaceRoot } }
        : { kind: 'unavailable', code: 'launch_probe_failed', probeFailure: { check: 'output', exitCode: 0,
          identity: { username: identity.username, uid: identity.agentUid, gid: identity.agentGid, home: identity.home, cwd: identity.home } } });
  }
});

const current = userInfo();
// The sudo/OS identity boundary is replaced with this process's real native
// identity. Frame parsing, material lease, shell checks and child exit are real.
it.skipIf(process.platform !== 'linux' || current.uid <= 0 || current.gid <= 0
  || process.getgroups?.().some(group => group !== current.gid))('qualifies own readiness only through the exact finite member launch and immutable payload', async () => {
  await withTempDir('member-readiness-', async directory => {
    const home = join(directory, 'member');
    await mkdir(home, { mode: 0o700 });
    const payload = join(directory, 'managed-happier');
    await writeFile(payload, '#!/bin/sh\nexit 0\n', { mode: 0o555 });
    const stagedPayloadPath = join(directory, 'staged');
    await mkdir(join(stagedPayloadPath, 'scripts'), { recursive: true, mode: 0o700 });
    await writeFile(join(stagedPayloadPath, 'scripts', 'process_tree.cjs'), 'module.exports = {};\n', { mode: 0o600 });
    const installed = await promoteVersionedPayload({ componentId: 'happier-cli', versionId: 'member-probe',
      stagedPayloadPath, processEnv: { ...process.env, HAPPIER_HOME_DIR: join(directory, 'install') } });
    const identity = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'canonical-home',
      requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' } }),
      username: current.username, agentUid: current.uid, agentGid: current.gid, home };
    let launches = 0;
    const controller = new AbortController();
    const system: AgentIsolationReadinessSystem = { run: async (command, args, options) => {
      launches++;
      expect(command).toBe('sudo');
      expect(args).toEqual(['-n', '-u', identity.username, '--', payload, 'agent-launch']);
      expect(options?.env).toEqual({});
      // Model only the cross-UID filesystem boundary: this process owns the
      // fixture, whereas the deployed hpm user must load code via other bits.
      // Loading this CJS dependency precedes frame parsing in the real shim.
      for (const [path, access] of [[installed.versionPath, 0o005],
        [join(installed.versionPath, 'scripts'), 0o005],
        [join(installed.versionPath, 'scripts', 'process_tree.cjs'), 0o004]] as const) {
        if (((await stat(path)).mode & access) !== access) {
          throw Object.assign(new Error('Native runtime dependency is inaccessible'), { code: 'EACCES' });
        }
      }
      createRequire(import.meta.url)(join(installed.versionPath, 'scripts', 'process_tree.cjs'));
      const frame = await readAgentLaunchFrame(Readable.from([options!.inputBytes!], { objectMode: false }));
      expect(frame.nativeIdentity).toMatchObject({ username: identity.username, home });
      if (launches === 1) expect(frame.nativeIdentity).toEqual({ username: identity.username, agentUid: current.uid, agentGid: current.gid, home });
      expect(frame.selectedMaterials).toEqual([]);
      expect(frame.environment).not.toHaveProperty('HAPPIER_DAEMON_TOKEN');
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on('data', chunk => chunks.push(Buffer.from(chunk)));
      const result = await executeAgentLaunchPayload(frame, { agentHome: home, input: Readable.from([]),
        stdout: output, stderr: new PassThrough(), signal: options?.signal });
      if (result.code !== 0) throw Object.assign(new Error('Native launch refused'), { code: result.code });
      return { stdout: Buffer.concat(chunks), stderr: '' };
    } };
    const inspect = () => observeAgentIsolationMemberLaunchReadiness({ installedCli: payload, memberIdentity: identity,
      system, signal: controller.signal });
    expect(await inspect()).toEqual({ kind: 'member_native_ready', status: { kind: 'effective', platform: 'linux' },
      directories: { home: identity.home, workspace: identity.workspaceRoot } });
    expect(await readdir(join(home, 'runtime'))).toEqual([]);
    await chmod(payload, 0o755);
    expect(await inspect()).toMatchObject({ kind: 'unavailable', code: 'payload_not_accessible', probeFailure: { check: 'managed_payload', exitCode: 73 } });
    await chmod(payload, 0o555);
    expect(await observeAgentIsolationMemberLaunchReadiness({ installedCli: payload,
      memberIdentity: { ...identity, agentGid: current.gid + 1 }, system })).toMatchObject({ kind: 'unavailable', code: 'launch_probe_failed', probeFailure: { check: 'groups', exitCode: 79 } });
    expect(await observeAgentIsolationMemberLaunchReadiness({ installedCli: payload,
      memberIdentity: { ...identity, agentUid: current.uid + 1 }, system })).toMatchObject({ kind: 'unavailable', code: 'launch_probe_failed', probeFailure: { check: 'uid', exitCode: 71 } });
    const denied: AgentIsolationReadinessSystem = { run: async () => {
      throw Object.assign(new Error('sudo: a password is required'), { code: 1 });
    } };
    expect(await observeAgentIsolationMemberLaunchReadiness({ installedCli: payload, memberIdentity: identity,
      system: denied })).toMatchObject({ kind: 'unavailable', code: 'launch_probe_failed', probeFailure: { check: 'launch', exitCode: 1 } });
    const cancelled: AgentIsolationReadinessSystem = { run: async () => {
      controller.abort();
      controller.signal.throwIfAborted();
      throw new Error('unreachable');
    } };
    await expect(observeAgentIsolationMemberLaunchReadiness({ installedCli: payload, memberIdentity: identity,
      system: cancelled, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
