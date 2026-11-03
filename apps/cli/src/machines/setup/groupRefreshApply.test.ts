import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { checkMachineSetupEffectPlan, createMachineSetupNativeBackend, type MachineSetupNativeCommand } from '@happier-dev/cli-common/machineSetup';
import { applyMachineSetup, type ApplyMachineSetupInput } from './applyMachineSetup';
import { runMachineSetupEffectInternal } from './effectInternal';
import type { MachineElevationDependencies, MachineElevationSpawn } from '../adminAccess/runElevatedEffect';

// Only native PTY/elevation/OS reads are substituted. The task runner, terminal
// owner, native interpreter, admission and lifecycle projection remain real.
describe('Software Apply group refresh recovery', () => {
  const managers: Array<ReturnType<typeof createTerminalPtySessionManager>> = [];
  afterEach(() => { vi.restoreAllMocks(); managers.splice(0).forEach(manager => manager.dispose()); });
  async function fixture() {
    const spawned: unknown[] = [];
    // The committed terminal API still requires retention; no terminal opens here.
    const config = { bufferMaxBytes: 100000, bufferMaxEvents: 1000, bufferRetentionMs: 0,
      urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 };
    const terminalSessions = createTerminalPtySessionManager({
      ptyProvider: { spawn(launch) { spawned.push(launch); throw new Error('Scripts must wait for group refresh'); } },
      env: { SHELL: '/bin/bash' }, probeProcessGroup: () => 'absent', stopProcessTree: async () => {},
      config,
    });
    managers.push(terminalSessions);
    const input: ApplyMachineSetupInput = { homeId: 'home', machineId: 'guest', requesterAccountId: 'owner',
      userHomeDirectory: '/home/happier', setup: {}, terminalSessions, platform: 'linux', hostEnvironment: { SHELL: '/bin/bash' },
      isCurrent: async () => true,
      environmentIo: { resolveTool: async () => null, run: async () => { throw new Error('No implicit native probe'); } },
      operation: { actionRequestId: 'group-refresh-operation', signal: new AbortController().signal,
        operationProgress: { update() {} }, operationOwnerUpdate: { update() {} } },
    };
    return { input, spawned };
  }
  it('retains the closed native cause when an elevated mutation fails with an unknown outcome', async () => {
    const f = await fixture();
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
    const runNative = async (command: MachineSetupNativeCommand) => {
      if (command.executable === 'getent') return { code: 0, stderr: '', stdout: command.args.includes('group')
        ? 'docker:x:109:\n' : 'happier:x:1000:1000::/home/happier:/bin/bash\n' };
      if (command.executable === 'id') return { code: 0, stderr: '', stdout: '1000\n' };
      if (command.executable === 'usermod') return { code: 1, stdout: '', stderr: 'private native output' };
      throw new Error(`Unexpected native effect ${command.executable}`);
    };
    const item = { kind: 'softwareRecipe' as const, selection: { ref: { pluginId: 'com.example.tools', recipeId: 'engine', revision: '1' }, inputs: {} } };
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0, selection: item.selection },
      steps: [{ id: 'engine-access', kind: 'group', name: 'docker', members: ['happier'] }],
      backend: createMachineSetupNativeBackend({ run: runNative }) });
    const spawn: MachineElevationSpawn = launch => {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), { stdin, stdout, runNative })
        .then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
      return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    const elevation: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
      readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
      observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1000, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
        rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }),
    };
    try {
      expect(await applyMachineSetup({ ...f.input, setup: { items: [item] },
        recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }], elevation })).toEqual({
        ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown',
        details: { kind: 'machineSetup', failure: { kind: 'native_effect_failed', reason: 'native_effect_failed' } },
      });
    } finally {
      // The supplied OS child has settled. Release this test's uncertain admission
      // through the real owner, without changing the returned uncertainty.
      await machineNativeEffectAdmission.reconcileUnknown({ keys: [{ kind: 'machineSetup' }],
        observeSettled: async operation => operation.operationId === f.input.operation.actionRequestId });
    }
  });
  it.each(['user', 'system'] as const)('returns a typed %s-service remedy after a real elevated group grant, including a no-op retry', async mode => {
    const f = await fixture();
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
    let member = false;
    const mutations: string[] = [];
    const runNative = async (command: MachineSetupNativeCommand) => {
      if (command.executable === 'getent') return { code: 0, stderr: '', stdout: command.args.includes('group')
        ? `docker:x:109:${member ? 'happier' : ''}\n` : 'happier:x:1000:1000::/home/happier:/bin/bash\n' };
      if (command.executable === 'id') return { code: 0, stderr: '', stdout: member ? '1000 109\n' : '1000\n' };
      if (command.executable === 'usermod') { member = true; mutations.push(command.executable); return { code: 0, stdout: '', stderr: '' }; }
      throw new Error(`Unexpected native effect ${command.executable}`);
    };
    const item = { kind: 'softwareRecipe' as const, selection: { ref: { pluginId: 'com.example.tools', recipeId: 'engine', revision: '1' }, inputs: {} } };
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0, selection: item.selection },
      steps: [{ id: 'engine-access', kind: 'group', name: 'docker', members: ['happier'] }],
      backend: createMachineSetupNativeBackend({ run: runNative }) });
    const spawn: MachineElevationSpawn = launch => {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), { stdin, stdout, runNative })
        .then(code => { stdout.end(); stderr.end(); return { code, signal: null }; });
      return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    const elevation: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
      readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
      observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1000, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
        rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }),
    };
    const input = { ...f.input, setup: { items: [item], scripts: [{ body: 'docker info' }] }, recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }], elevation,
      groupRefreshNative: { platform: 'linux' as const, user: { username: 'happier', uid: 1000 }, groups: [1000],
        serviceLabel: 'happier-daemon.default', readCgroup: async () => mode === 'user'
          ? '0::/user.slice/user-1000.slice/user@1000.service/app.slice/happier-daemon.default.service\n'
          : '0::/system.slice/happier-daemon.default.service\n' } };
    const required = { ok: false, errorCode: 'requires_session_refresh', details: { requiredStep: {
      kind: 'requiresSessionRefresh', scope: mode === 'user' ? 'userServices' : 'daemonService', requiresAdministrator: true,
      command: { executable: 'systemctl', args: ['restart', ...(mode === 'user' ? ['--', 'user@1000.service'] : ['happier-daemon.default.service'])] },
    } } };
    expect(await applyMachineSetup(input)).toMatchObject(required);
    expect(mutations).toEqual(['usermod']);
    expect(f.spawned).toEqual([]);
    expect(await applyMachineSetup(input)).toMatchObject(required);
    expect(mutations).toEqual(['usermod']);
    expect(await applyMachineSetup({ ...input, setup: { items: [item] },
      groupRefreshNative: { ...input.groupRefreshNative, groups: [1000, 109] } })).toMatchObject({ ok: true });
    expect(mutations).toEqual(['usermod']);
  });
});
