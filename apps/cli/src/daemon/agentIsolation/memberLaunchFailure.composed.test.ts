import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentIsolationMemberPreparationBoundary } from './agentIsolationEffects.testkit';
import { deriveAgentIsolationMemberIdentity, type AgentIsolationMemberRequester } from './provisioning';
import { createAgentIsolationOperationContext, createAgentIsolationSessionContext } from './agentIsolationSessionContext';
import type { HostAgentIsolationLaunchContext } from './agentIsolationLaunchPolicy';
import { authorizeResolvedProjectExecLaunchForHost, spawnAuthorizedHostExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { executeHostFiniteTerminalProcess } from '@/terminal/pty/finiteProcess';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';

const nativeOs = vi.hoisted(() => ({ home: '', workspace: '', directory: '', runAs: true, payloads: 0, exitCode: 0 }));
// Substitute only native home metadata and sudo dispatch. The real preparation,
// RunAs framing, setup repair, process supervision and payload child remain live.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => String(path) === nativeOs.home
      ? Object.assign(await actual.lstat(nativeOs.directory), { uid: 2401, gid: 2401, mode: 0o40700 }) : actual.lstat(path),
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => String(path) === nativeOs.home || String(path) === nativeOs.workspace
      ? String(path) : actual.realpath(path),
  };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (args[0] !== 'sudo') return actual.spawn(...args);
    if (nativeOs.runAs) nativeOs.payloads++;
    return actual.spawn(process.execPath, ['-e', nativeOs.runAs
      ? `process.stdout.write('payload');process.exit(${nativeOs.exitCode})` : 'process.exit(1)'], args[2]);
  } };
});

const requester: AgentIsolationMemberRequester = { kind: 'isolated', separationRequired: true,
  homeServerIdentityId: 'canonical-home', requester: { serverId: 'profile', accountId: 'member',
    machineId: 'machine', installationId: 'installation' } };
const derived = deriveAgentIsolationMemberIdentity(requester);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== 'linux')('member failed launch recovery', () => {
  it.each([
    { consumer: 'exec', broken: false, session: false }, { consumer: 'exec', broken: true, session: false },
    { consumer: 'pty', broken: false, session: false }, { consumer: 'pty', broken: true, session: false },
    { consumer: 'exec', broken: true, session: true },
  ])('repairs only failed isolation without payload replay ($consumer, broken=$broken, session=$session)', async ({ consumer, broken, session }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-launch-failure-')); directories.push(directory);
    Object.assign(nativeOs, { home: derived.home, workspace: derived.workspaceRoot, directory, runAs: true, payloads: 0, exitCode: 0 });
    const native = createAgentIsolationMemberPreparationBoundary({ activeServerDir: directory,
      requesterIdentity: requester, uid: 2401, custodianAccountId: 'owner', encryptionMode: 'plain' });
    const prepared = await native.prepare();
    if (prepared.kind !== 'ready') throw new Error('Member fixture setup failed');
    native.permissionQueries.length = 0; native.mutations.length = 0;
    const signal = new AbortController().signal;
    const material = { materializationKey: 'operation', environment: {}, selectedMaterials: [] };
    const machine: HostAgentIsolationLaunchContext = { read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1',
        status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [directory] }),
        async prepareMember(input) {
          const result = await native.members.prepare(input);
          if (result.kind !== 'ready') throw new Error('Member repair refused');
          return result;
        } };
    const sessionMaterial = { ...material, runtimeHome: join(prepared.identity.home, 'runtime', 'session'), memberIdentity: prepared.identity };
    const context = session ? createAgentIsolationSessionContext({ machine,
      managedHappierBinaryPath: native.effects.installedCli, sessionRequester: requester.requester,
      sessionRequesterHomeServerIdentityId: requester.homeServerIdentityId,
      hostHomeServerIdentityId: requester.homeServerIdentityId, sessionCustodianAccountId: 'owner',
      readMaterial: () => sessionMaterial,
    }) : createAgentIsolationOperationContext({ requesterIdentity: requester, signal, machine,
      managedHappierBinaryPath: native.effects.installedCli, memberIdentity: prepared.identity, readMaterial: () => material });
    const authorize = () => authorizeResolvedProjectExecLaunchForHost({ signal, assertCurrent() {}, agentIsolation: context,
      launch: { command: process.execPath, args: [], env: {}, cwd: directory, release() {} } });
    for (let index = 0; index < 3; index++) {
      const launch = await authorize();
      const process = spawnAuthorizedHostExecLaunchForHost(launch);
      expect((await process.handle.wait()).termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
      await process.dispose();
    }
    expect(native.permissionQueries).toHaveLength(0);
    const launch = await authorize();
    if (broken) { native.installed.delete('agent-runas'); nativeOs.runAs = false; }
    nativeOs.exitCode = 7;
    const beforePayloads = nativeOs.payloads;
    if (consumer === 'exec') {
      const process = spawnAuthorizedHostExecLaunchForHost(launch);
      const result = await process.handle.wait();
      await process.dispose();
      expect(nativeOs.payloads - beforePayloads).toBe(broken ? 0 : 1);
      expect(result.termination.observed).toMatchObject(broken
        ? { kind: 'failed', diagnostic: { code: 'agent_isolation_unavailable' } } : { kind: 'exit', exitCode: 7 });
    } else {
      let attempted = 0;
      const terminalSessions = createTerminalPtySessionManager({ config: readDaemonTerminalPtyConfig({}).sessionManager,
        ptyProvider: { spawn() { attempted++; throw Object.assign(new Error('Native PTY start failed'), { code: 'EACCES' }); } } });
      const result = await executeHostFiniteTerminalProcess({ operation: { signal }, terminalSessions,
        requesterAccountId: requester.requester.accountId, terminalKey: 'failed-native-pty',
        launch: { ...launch, cwd: directory }, authorizedNativeLaunch: launch,
        progress: { phase: 'command', label: 'Running' }, failureCode: 'project_command_step_failed',
        attachment: ({ terminalId }) => ({ kind: 'projectCommand', purpose: 'script', serverId: 'profile',
          machineId: 'machine', workspaceRefId: 'workspace', cwd: directory, terminalId }),
      });
      terminalSessions.dispose();
      expect(result).toMatchObject({ kind: 'no_launch', result: { ok: false,
        errorCode: broken ? 'agent_isolation_unavailable' : 'terminal_spawn_failed' } });
      expect(attempted).toBe(1);
      expect(nativeOs.payloads).toBe(beforePayloads);
    }
    if (broken) {
      expect(native.installed.has('agent-runas')).toBe(true);
      expect(native.mutations).toEqual(['agent-runas']);
      expect(native.permissionQueries).toHaveLength(2);
      // Repair prepares the next visible attempt; it never replays the failed
      // payload. The OS boundary now observes the repaired managed rule.
      nativeOs.runAs = true; nativeOs.exitCode = 0;
      const retry = spawnAuthorizedHostExecLaunchForHost(await authorize());
      expect((await retry.handle.wait()).termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
      await retry.dispose();
      expect(nativeOs.payloads - beforePayloads).toBe(1);
      expect(native.permissionQueries).toHaveLength(2);
    } else {
      expect(native.mutations).toEqual([]);
      expect(native.permissionQueries).toHaveLength(1);
    }
    expect((await lstat(join(directory, 'agent-isolation', 'members', `${derived.digest}.json`))).isFile()).toBe(true);
  });
});
