import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents/resolution';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY } from '@happier-dev/cli-common/firstPartyRuntime';
import * as processBoundary from '@happier-dev/cli-common/process';
import * as childProcess from 'node:child_process';
import * as filesystem from 'node:fs/promises';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { activateAgentRuntimeContributionOnDemand } from '@/agent/runtime/registry/activationDemand';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { executeAgentLaunchPayload } from '@/daemon/agentIsolation/agentLaunchShim';
import { projectNativeAgentCliRuntimeDescriptor } from '@/plugins/projection/registry/agentCliRuntimeDescriptor';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createMuseMspProcessFixture } from './testkit/mspProcess.js';
import { museCliSupport } from './cli.js';
import { MUSE_PLUGIN } from '../manifest.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => Reflect.apply(actual.spawn, actual, args) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: (path: Parameters<typeof actual.realpath>[0]) => actual.realpath(path) };
});

it.skipIf(process.platform !== 'linux')('admits independent native-default history callbacks for the daemon requester member and retires their finite leases', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-member-history-'));
  let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  let basis: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  const restoreBoundaries: Array<() => void> = [];
  try {
    const requester = { serverId: 'home', accountId: 'member-account', machineId: 'machine', installationId: 'installation' };
    const member = { ...deriveAgentIsolationMemberIdentity({ homeServerIdentityId: 'home', requester }), agentUid: 2401, agentGid: 2401 };
    const backingHome = join(scratch, 'member');
    await mkdir(backingHome);
    const realpath = filesystem.realpath;
    const nativePaths = vi.spyOn(filesystem, 'realpath').mockImplementation(async path =>
      String(path) === member.workspaceRoot || String(path) === member.home ? String(path) : realpath(path));
    restoreBoundaries.push(() => nativePaths.mockRestore());
    vi.stubEnv(FIRST_PARTY_INSTALL_HOME_ENV_KEY, join(scratch, 'public-install'));
    const managed = resolveAgentCliManagedCommandPathForRuntime(projectNativeAgentCliRuntimeDescriptor({
      agentId: 'muse', title: 'Muse', cli: museCliSupport,
    }), { processEnv: process.env });
    await mkdir(dirname(managed), { recursive: true });
    const nativeScript = join(scratch, 'native.cjs');
    await writeFile(managed, `#!/bin/sh\nexec "${process.execPath}" "${nativeScript}" "$@"\n`, { mode: 0o755 });
    const originalSpawn = childProcess.spawn;
    const shim = join(scratch, 'run-as.mjs');
    const audit = join(scratch, 'launches.jsonl');
    let nativeStderr = '';
    // Only OS RunAs is substituted. Native admission, frame codec, material
    // ownership, launch shim, process supervision and MSP are the real owners.
    await writeFile(shim, `
      import { appendFile } from 'node:fs/promises';
      import { readAgentLaunchFrame } from ${JSON.stringify(new URL('../../../../../apps/cli/src/daemon/agentIsolation/agentLaunchFrame.ts', import.meta.url).href)};
      import { executeAgentLaunchPayload } from ${JSON.stringify(new URL('../../../../../apps/cli/src/daemon/agentIsolation/agentLaunchShim.ts', import.meta.url).href)};
      const frame = await readAgentLaunchFrame(process.stdin);
      await appendFile(${JSON.stringify(audit)}, JSON.stringify(frame)+'\\n');
      const result = await executeAgentLaunchPayload({ ...frame,
        cwd: frame.cwd === ${JSON.stringify(member.workspaceRoot)} ? ${JSON.stringify(backingHome)} : frame.cwd,
        runtimeHome: frame.runtimeHome.replace(${JSON.stringify(member.home)}, ${JSON.stringify(backingHome)}) }, {
        agentHome: ${JSON.stringify(backingHome)}, input: process.stdin, stdout: process.stdout, stderr: process.stderr });
      process.exitCode = result.code ?? 1;
    `);
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
      if (args[0] !== 'sudo') return Reflect.apply(originalSpawn, childProcess, args);
      expect(args[1]).toEqual(['-n', '-u', member.username, '--', '/managed/happier', 'agent-launch']);
      const child = originalSpawn(process.execPath, ['--conditions=happier-source', '--import',
        new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url).pathname, shim],
        { ...args[2], env: { ...process.env, TSX_TSCONFIG_PATH: new URL('../../../../../apps/cli/tsconfig.json', import.meta.url).pathname } });
      child.stderr?.on('data', chunk => { nativeStderr += String(chunk); });
      return child;
    });
    restoreBoundaries.push(() => spawn.mockRestore());
    let retired = 0;
    const execFileWithDeadline = processBoundary.execFileWithDeadline;
    const nativeExec = vi.spyOn(processBoundary, 'execFileWithDeadline').mockImplementation(async (...args) => {
      if (args[0] !== 'sudo') return await execFileWithDeadline(...args);
      const frame = await readAgentLaunchFrame(Readable.from([args[2]!.inputBytes!], { objectMode: false }), undefined, true);
      expect(frame).toMatchObject({ action: 'retire_operation', nativeIdentity: { username: member.username, home: member.home } });
      if (!('action' in frame)) throw new Error('Unexpected finite lease action');
      await executeAgentLaunchPayload({ ...frame, runtimeHome: frame.runtimeHome.replace(member.home, backingHome) }, {
        agentHome: backingHome, input: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough() });
      retired++;
      return { stdout: '', stderr: '' };
    });
    restoreBoundaries.push(() => nativeExec.mockRestore());
    let admissions = 0;
    async function phase() {
      const recording = JSON.parse((await readFile(new URL('./testkit/fixtures/isolated-three-turns.json', import.meta.url), 'utf8'))
        .replaceAll('[TEMP]/isolated-three-turns/data/muse', join(member.home, '.local/share/muse')));
      const native = await createMuseMspProcessFixture({ recording });
      const launch = await native.resolveExecutable();
      await writeFile(nativeScript, `if(process.env.XDG_DATA_HOME!==${JSON.stringify(join(member.home, '.local/share'))})throw Error('Wrong native source');\nObject.assign(process.env,${JSON.stringify(launch.env)});\n${launch.args[1]}`);
    }
    const runtimeOptions: NonNullable<NonNullable<Parameters<typeof createAdmittedPluginRuntimeFixture>[0]>['runtimeOptions']> = {
      pluginIds: ['happier.agent.muse'],
      scopedActionRuntime: { credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: requester.accountId })).toString('base64url')}.signature`, encryption: null },
        actionsSettingsProvider: createActionSettingsProvider() },
      externalActionHomeBinding: { serverId: 'fixture-home', serverApiUrl: 'https://fixture.invalid', serverIdentityId: 'home' }, resolveCurrentMachineId: () => requester.machineId,
      readDaemonRequesterWorkAttribution: () => requester,
      agentIsolation: { managedHappierBinaryPath: '/managed/happier',
        read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }),
        async readMember({ requesterIdentity }) {
          expect(requesterIdentity.requester).toEqual(requester); admissions++;
          return { identity: member, daemonObservation: { daemonIdentity: 'nonRoot', daemonUid: 1001, daemonUsername: 'happier', daemonPrimaryGroup: 'happier' } };
        },
        async prepareMember() { throw new Error('An admitted member must not be prepared per page'); },
      },
    };
    const happyHomeDir = join(scratch, 'happier');
    basis = await createAdmittedPluginRuntimeFixture({ happyHomeDir, runtimeOptions });
    const declaration = MUSE_PLUGIN.manifest.contributes.agents?.find(agent => agent.id === 'muse');
    if (!declaration) throw new Error('Authored Muse declaration is unavailable');
    // Publication is lead-owned. Exercise current authored metadata through its
    // canonical projection while retaining the fixture's real source custody.
    fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir, controller: basis.controller,
      runtimeOptions: { ...runtimeOptions, contributes: createResolvedContributionRegistry({ ...basis.registry.contributes,
        agents: basis.registry.contributes.agents.map(agent => agent.pluginId === MUSE_PLUGIN.manifest.id
          ? { ...agent, ...projectManifestAgentContribution({ ...agent, pluginId: MUSE_PLUGIN.manifest.id,
            definition: declaration, systemTools: MUSE_PLUGIN.manifest.contributes.systemTools }) }
          : agent),
      }) },
    });
    const agent = fixture.registry.contributes.agents.find(agent => agent.identity?.pluginId === MUSE_PLUGIN.manifest.id
      && agent.identity.localId === 'muse');
    if (!agent) throw new Error('Authored Muse declaration is unavailable');
    await activateAgentRuntimeContributionOnDemand(fixture.registry, agent.id);
    const callbacks = fixture.registry.agentRuntimesByAgentId.get(agent.id)?.externalSessions;
    if (!callbacks) throw new Error('Admitted Muse external callbacks are unavailable');
    const sources = [];
    for (let index = 0; index < 2; index++) {
      await phase();
      const result = await callbacks.resolveSource({ source: { kind: 'museNative' }, signal: new AbortController().signal, maxSerializedBytes: 524_288 });
      expect(result.ok ? null : result, nativeStderr).toBeNull();
      if (!result.ok) throw new Error(result.code);
      sources.push(result.value.source);
      expect(retired).toBe(index + 1);
    }
    expect(sources).toEqual(Array.from({ length: 2 }, () => ({ kind: 'museNative', museHome: join(member.home, '.local/share/muse') })));
    // Native preparation has succeeded, then executable resolution fails.
    // The containing callback still retires its lease before returning.
    await rm(managed);
    const failed = await callbacks.resolveSource({ source: { kind: 'museNative' },
      signal: new AbortController().signal, maxSerializedBytes: 524_288 });
    expect(failed).toMatchObject({ ok: false, code: 'source_unreachable' });
    expect(retired).toBe(3);
    const frames = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect(frame.nativeIdentity).toEqual({ username: member.username,
      agentUid: member.agentUid, agentGid: member.agentGid, home: member.home });
    expect(new Set(frames.map(frame => frame.runtimeHome)).size).toBe(2);
    expect(frames.map(frame => frame.cwd)).toEqual([member.workspaceRoot, member.workspaceRoot]);
    expect(frames.map(frame => frame.environment.XDG_DATA_HOME)).toEqual([join(member.home, '.local/share'), join(member.home, '.local/share')]);
    expect(admissions).toBe(3);
    expect(await readdir(join(backingHome, 'runtime/operations'))).toEqual([]);
  } finally {
    try { await fixture?.dispose(); }
    finally {
      try { await basis?.dispose(); }
      finally {
        for (const restore of restoreBoundaries.reverse()) restore();
        vi.unstubAllEnvs();
        await rm(scratch, { recursive: true, force: true });
      }
    }
  }
});
