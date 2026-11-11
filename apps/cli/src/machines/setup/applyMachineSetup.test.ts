import { withSavedSecretMaterializer } from '@/settings/secrets/savedSecretCatalog.testkit';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as nativeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationOwnerUpdate } from '@/daemon/actionOperations/actionOperationTypes';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { PtyExitEvent, PtyProcess, PtyProvider, PtySpawnParams } from '@/terminal/pty/provider';
import { applyMachineSetup } from './applyMachineSetup';
import { ActionOperationDomainRefV1Schema, ActionOperationSnapshotV1Schema, projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { listAdvertisedSystemTaskKinds } from '@/capabilities/registry/toolSystemTasks';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { MachineRecipeStepV1Schema } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { observeDockerEngine } from '@/daemon/local/services/launch/dockerEngineObservation';
import { checkMachineSetupEffectPlan, createMachineSetupNativeBackend, type MachineSetupNativeCommand } from '@happier-dev/cli-common/machineSetup';
import { runMachineSetupEffectInternal } from './effectInternal';
import type { MachineElevationDependencies, MachineElevationSpawn } from '../adminAccess/runElevatedEffect';

// Only native PTY/process-tree and installed-tool IO are substituted. The
// terminal/output lifetime, native environment and Saved Secret owners are real.
class SetupPty implements PtyProcess {
  readonly pid = 23456;
  readonly ownedProcessGroupId = 23456;
  private readonly exits = new Set<(event: PtyExitEvent) => void>();
  write() { throw new Error('Setup is not interactive'); }
  resize() {}
  kill() {}
  onData() { return { dispose() {} }; }
  onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) }; }
  exit(exitCode: number) { for (const listener of this.exits) listener({ exitCode, signal: 0 }); }
}

describe('applyMachineSetup', () => {
  const roots: string[] = [];
  const managers: Array<ReturnType<typeof createTerminalPtySessionManager>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    managers.splice(0).forEach(manager => manager.dispose());
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  async function fixture(autoExit: boolean | ((launch: PtySpawnParams) => number) = false) {
    const home = await mkdtemp(join(tmpdir(), 'happier-machine-setup-'));
    roots.push(home);
    const spawned: Array<{ launch: PtySpawnParams; pty: SetupPty }> = [];
    const provider: PtyProvider = { spawn(launch) { const pty = new SetupPty(); spawned.push({ launch, pty });
      if (autoExit) queueMicrotask(() => pty.exit(typeof autoExit === 'function' ? autoExit(launch) : 0));
      return pty; } };
    let stopped = 0;
    const terminalSessions = createTerminalPtySessionManager({ ptyProvider: provider, env: { SHELL: '/bin/bash' },
      probeProcessGroup: () => 'absent', stopProcessTree: async () => { stopped++; },
      config: { bufferMaxBytes: 100000, bufferMaxEvents: 1000,
        urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 },
    });
    managers.push(terminalSessions);
    const updates: ActionOperationOwnerUpdate[] = [];
    const controller = new AbortController();
    const nativeRequests: unknown[] = [];
    const input = {
      homeId: 'home', machineId: 'guest', preset: { id: 'preset', revision: 4 }, requesterAccountId: 'owner', userHomeDirectory: home,
      setup: { toolchain: { adapterId: 'mise', config: '[env]\nREMOVE = false\n' }, scripts: [{ body: 'echo setup', affects: 'none' as const }],
        secretRefs: { v: 1 as const, bindings: { SETUP_SECRET: { ref: 'saved' } } } },
      terminalSessions, platform: 'linux' as const, hostEnvironment: { SHELL: '/bin/bash', PATH: '/host', REMOVE: 'remove' },
      isCurrent: async () => true,
      secretEnvironment: withSavedSecretMaterializer({ accountSettings: { secrets: [{ id: 'saved', name: 'Setup', kind: 'apiKey',
        encryptedValue: { _isSecretValue: true as const, value: 'private-value' }, createdAt: 1, updatedAt: 1 }] }, settingsSecretsReadKeys: [] }),
      environmentIo: {
        resolveTool: async () => ({ executablePath: '/tools/runtime', args: ['mise'], version: '2026.10.4' }),
        run: async (request: unknown) => { nativeRequests.push(request); return { exitCode: 0, stdout: 'PATH=/native\0' }; },
      },
      operation: { actionRequestId: 'setup-operation', signal: controller.signal,
        operationProgress: { update() {} }, operationOwnerUpdate: { update: (update: ActionOperationOwnerUpdate) => updates.push(update) } },
    };
    return { home, spawned, updates, input, nativeRequests, controller, stopped: () => stopped };
  }
  it('runs canonical ordered scripts verbatim with each source overlay and each script check, skipping empty bodies', async () => {
    const f = await fixture(true);
    const first = 'echo first\r\n', second = 'echo second\n', third = 'echo third';
    const check = (id: string) => ({ executable: 'fixture-check', args: [id], unsatisfiedExitCodes: [1] });
    // The structurally typed value reaches the real runtime without importing
    // a not-yet-published script type during the coordinated schema cut.
    const setup: MachineSetupV1[] = [
      { secretRefs: { v: 1 as const, bindings: { A_ONLY: { ref: 'saved' } } }, scripts: [
        { body: first, affects: 'none' as const, check: check('first') }, { body: '' },
        { body: second, affects: 'none' as const, check: check('second') },
      ] },
      { secretRefs: { v: 1 as const, bindings: { B_ONLY: { ref: 'saved' } } }, scripts: [{ body: third, affects: 'none' as const }] },
    ];
    const checks: string[] = [];
    let admissionReads = 0;
    expect(await applyMachineSetup({ ...f.input, setup,
      // The containing Action's Home admission/desired-read callback is the external authority boundary.
      isCurrent: async () => { admissionReads++; return true; },
      environmentIo: { ...f.input.environmentIo, run: async request => {
      if (request.command !== 'fixture-check') throw new Error('No implicit native check or Docker probe is allowed');
      const id = request.args[0]!;
      checks.push(id);
      const body = id === 'first' ? first : second;
      return { exitCode: f.spawned.some(process => process.launch.args.includes(body)) ? 0 : 1, stdout: '' };
    } } })).toMatchObject({ ok: true });
    expect(f.spawned.map(process => process.launch.args)).toEqual([['-c', first], ['-c', second], ['-c', third]]);
    expect(checks).toEqual(['first', 'first', 'second', 'second']);
    expect(admissionReads).toBe(1);
    for (const process of f.spawned.slice(0, 2)) {
      expect(process.launch.options.env).toMatchObject({ A_ONLY: 'private-value' });
      expect(process.launch.options.env).not.toHaveProperty('B_ONLY');
    }
    expect(f.spawned[2]!.launch.options.env).toMatchObject({ B_ONLY: 'private-value' });
    expect(f.spawned[2]!.launch.options.env).not.toHaveProperty('A_ONLY');
  });
  it('retains only the failing ordered command phase, step and exit for Action readers', async () => {
    const f = await fixture(launch => launch.args.at(-1)?.includes('exit 23') ? 23 : 0);
    const result = await applyMachineSetup({ ...f.input, setup: { scripts: [
      { body: 'printf PRIVATE_FIRST_MARKER', affects: 'none' },
      { body: 'printf PRIVATE_COMMAND_BODY; exit 23', affects: 'none' },
      { body: 'printf MUST_NOT_RUN', affects: 'none' },
    ] } });
    expect(result).toMatchObject({ ok: false, errorCode: 'machine_setup_setup_failed', details: {
      kind: 'finiteCommand', phase: 'setup', step: 1, exitCode: 23, signal: 0,
    } });
    expect(f.spawned).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|private-value|MUST_NOT_RUN/);
  });
  it('runs unchanged source scripts while excluding reviewed recipes and preserves merge conflicts', async () => {
    const f = await fixture(true);
    const ref = { pluginId: 'com.example.machine-tools', recipeId: 'unavailable', revision: '1' };
    const script = '\r\necho retained full-copy script\r\n';
    const setup = [{ scripts: [{ body: script, affects: 'none' as const }, { body: '' }], items: [{
      kind: 'setupRecipe' as const, selection: { ref, inputs: {} },
    }] }, {}];
    const exclusions = [{ ref, reason: 'not_selected' as const }];
    const input = { ...f.input, setup, recipePlans: [], exclusions };
    expect(await applyMachineSetup(input)).toMatchObject({ ok: true });
    expect(f.spawned.map(process => process.launch.args)).toEqual([['-c', script]]);
    expect(setup[0]?.items?.[0]?.selection.ref).toBe(ref);
    const before = f.spawned.length;
    expect(f.spawned).toHaveLength(before);
    expect(f.nativeRequests).toEqual([]);
    const conflicting = { ...input, setup: [setup[0]!, { items: [{ kind: 'setupRecipe' as const,
      selection: { ref: { ...ref, revision: '2' }, inputs: {} },
    }] }] };
    expect(await applyMachineSetup(conflicting)).toMatchObject({ ok: false, errorCode: 'machine_setup_conflict' });
    expect(f.spawned).toHaveLength(before);
  });
  it('keeps unchanged Update scripts and toolchain inert through native execution', async () => {
    const f = await fixture(true);
    const source = { kind: 'direct' as const, setup: f.input.setup };
    const input = { ...f.input, setup: [source.setup], recipePlans: [], sourceChange: { currentSources: [source], currentExclusions: [], sources: [source] } };
    expect(await applyMachineSetup(input)).toMatchObject({ ok: true });
    expect(f.spawned).toEqual([]);
    expect(f.nativeRequests).toEqual([]);
    expect(source.setup.scripts).toEqual([{ body: 'echo setup', affects: 'none' }]);
  });
  it('executes new Update scripts in order without deduplicating identical scripts from another attachment', async () => {
    const f = await fixture(true);
    const current = { kind: 'direct' as const, setup: f.input.setup };
    const first = { body: 'echo new first\r\n', affects: 'none' as const };
    const second = { body: 'echo new second\n', affects: 'none' as const };
    const sources = [{ ...current, setup: { ...current.setup, scripts: [...current.setup.scripts, first, second] } },
      { kind: 'bundledPreset' as const, ref: { pluginId: 'com.example.scripts', localId: 'new', revision: '1' }, setup: { scripts: [first] } }];
    const input = { ...f.input, setup: sources.map(source => source.setup), recipePlans: [], sourceChange: { currentSources: [current], currentExclusions: [], sources } };
    const before = JSON.stringify(sources);
    expect(await applyMachineSetup(input)).toMatchObject({ ok: true });
    expect(f.spawned.map(process => process.launch.args.at(-1))).toEqual([first.body, second.body, first.body]);
    expect(f.nativeRequests).toEqual([]);
    expect(JSON.stringify(sources)).toBe(before);
  });
  it('runs a script without declared effects alongside unrelated engine work without probing Docker', async () => {
    const f = await fixture(true);
    let nativeReads = 0;
    const result = await machineNativeEffectAdmission.run({ operation: { operationId: 'unrelated-compose', kind: 'fixture' },
      keys: [{ kind: 'composeProject', dockerEndpoint: 'engine', projectName: 'incumbent' }] }, () => applyMachineSetup({
      ...f.input, setup: { scripts: [{ body: 'echo ordinary' }] },
      environmentIo: { ...f.input.environmentIo, run: async () => {
        nativeReads++;
        throw new Error('An undeclared script impact cannot demand a Docker probe');
      } },
    }));
    expect(result).toMatchObject({ ok: true });
    expect(f.spawned.map(process => process.launch.args)).toEqual([['-c', 'echo ordinary']]);
    expect(nativeReads).toBe(0);
  });
  it('admits the explicit engine impact of a later canonical script before the first script can run', async () => {
    const f = await fixture(true);
    const setup = { secretRefs: f.input.setup.secretRefs, scripts: [
      { body: 'echo first', affects: 'none' as const }, { body: 'echo later', affects: 'dockerEngine' as const },
    ] };
    let release!: () => void;
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const held = machineNativeEffectAdmission.run({ operation: { operationId: 'incumbent-compose', kind: 'fixture' },
      keys: [{ kind: 'composeProject', dockerEndpoint: 'engine', projectName: 'incumbent' }] }, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await running;
    try {
      expect(await applyMachineSetup({ ...f.input, setup, environmentIo: { ...f.input.environmentIo,
        run: async () => ({ exitCode: 0, stdout: '{"ID":"engine"}' }) } }))
        .toMatchObject({ ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'incumbent-compose' } });
      expect(f.spawned).toEqual([]);
    } finally { release(); await held; }
  });
  it('retries canonical ordered scripts without replaying a checked predecessor or running past a failed body', async () => {
    const complete = new Set<string>();
    let secondAttempts = 0;
    const f = await fixture(launch => {
      const body = launch.args.at(-1);
      if (body === 'echo first') { complete.add('first'); return 0; }
      if (body === 'echo second') { if (++secondAttempts === 1) return 7; complete.add('second'); return 0; }
      if (body === 'echo third') return 0;
      throw new Error('Unexpected script process');
    });
    const check = (id: string) => ({ executable: 'fixture-check', args: [id], unsatisfiedExitCodes: [1] });
    const setup = { secretRefs: f.input.setup.secretRefs, scripts: [
      { body: 'echo first', affects: 'none' as const, check: check('first') },
      { body: 'echo second', affects: 'none' as const, check: check('second') },
      { body: 'echo third', affects: 'none' as const },
    ] };
    const input = { ...f.input, setup, environmentIo: { ...f.input.environmentIo,
      run: async (request: Parameters<typeof f.input.environmentIo.run>[0]) => {
        if (!request || typeof request !== 'object' || !('args' in request) || !Array.isArray(request.args)
          || typeof request.args[0] !== 'string') throw new Error('Expected native check');
        return { exitCode: complete.has(request.args[0]) ? 0 : 1, stdout: '' };
      } } };
    expect(await applyMachineSetup(input)).toMatchObject({ ok: false, errorCode: 'machine_setup_setup_failed' });
    expect(f.spawned.map(process => process.launch.args.at(-1))).toEqual(['echo first', 'echo second']);
    expect(await applyMachineSetup({ ...input, operation: { ...f.input.operation, actionRequestId: 'setup-retry' } }))
      .toMatchObject({ ok: true });
    expect(f.spawned.map(process => process.launch.args.at(-1))).toEqual(['echo first', 'echo second', 'echo second', 'echo third']);
  });
  it('finishes admitted canonical scripts after their initial desired basis changes', async () => {
    let current = true;
    const f = await fixture(() => {
      current = false;
      return 0;
    });
    const setup = { secretRefs: f.input.setup.secretRefs, scripts: [
      { body: 'echo first', affects: 'none' as const }, { body: 'echo second', affects: 'none' as const },
    ] };
    expect(await applyMachineSetup({ ...f.input, setup, isCurrent: async () => current })).toMatchObject({ ok: true });
    expect(f.spawned.map(process => process.launch.args.at(-1))).toEqual(['echo first', 'echo second']);
  });
  it('withholds the next canonical script when cancel occurs after the first body', async () => {
    const f = await fixture(launch => {
      expect(launch.args.at(-1)).toBe('echo first');
      f.controller.abort();
      return 0;
    });
    const setup = { secretRefs: f.input.setup.secretRefs, scripts: [
      { body: 'echo first', affects: 'none' as const }, { body: 'echo second', affects: 'none' as const },
    ] };
    expect(await applyMachineSetup({ ...f.input, setup })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.spawned).toHaveLength(1);
  });
  async function rootfulDockerSetup(holdEffect = false) {
    const f = await fixture(true);
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
    let running = true;
    let rootLaunches = 0;
    let mutations = 0;
    let release!: () => void;
    let started!: () => void;
    const effectStarted = new Promise<void>(resolve => { started = resolve; });
    const effectReleased = holdEffect ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
    const runNative = async (command: MachineSetupNativeCommand) => {
      if (command.executable !== 'systemctl') throw new Error('Unexpected native recipe command');
      if (command.args.includes('show')) return { code: 0, stdout:
        `LoadState=loaded\nUnitFileState=enabled\nActiveState=${running ? 'active' : 'inactive'}\n`, stderr: '' };
      expect(command.args).toContain('stop');
      mutations++;
      started();
      await effectReleased;
      running = false;
      return { code: 0, stdout: '', stderr: '' };
    };
    const item = { kind: 'setupRecipe' as const, selection: {
      ref: { pluginId: 'com.example.tools', recipeId: 'rootful-engine', revision: '1' }, inputs: {},
    } };
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0,
      selection: item.selection }, steps: [{ id: 'stop', kind: 'serviceUnit', unit: 'docker.service', enabled: true, running: false }],
      backend: createMachineSetupNativeBackend({ run: runNative }) });
    const spawn: MachineElevationSpawn = launch => {
      rootLaunches++;
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      let settle!: (value: { code: number | null; signal: string | null }) => void;
      const settled = new Promise<{ code: number | null; signal: string | null }>(resolve => { settle = resolve; });
      void runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), { stdin, stdout, runNative })
        .then(code => { stdout.end(); stderr.end(); settle({ code, signal: null }); });
      return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    const input = { ...f.input, setup: { items: [item] }, recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }],
      hostEnvironment: { DOCKER_HOST: 'ssh://selected-remote' },
      environmentIo: { ...f.input.environmentIo, run: async (request: { command: string }) => request.command === 'systemctl'
        ? { exitCode: 0, stdout: 'ActiveState=active\nMainPID=2352\n' }
        : { exitCode: 0, stdout: '{"ID":"selected-engine"}' } },
      elevation: { installationId: 'installation', installedCli: '/managed/happier', spawn,
        readPolicy: async () => ({ version: 1 as const, mode: 'preauthorized' as const }), verifyCurrent: async () => true,
        observe: async () => ({ version: 1 as const, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot' as const,
          rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed' as const, managedDropIn: 'valid' as const, tailscaledOperator: { authorization: 'unknown' as const } }) } };
    return { ...f, input, effectStarted, release: () => release?.(), rootLaunches: () => rootLaunches, mutations: () => mutations };
  }
  it('admits a non-root rootful local engine effect when no observed engine has colliding work', async () => {
    const f = await rootfulDockerSetup();
    const result = await applyMachineSetup(f.input);
    expect(result.ok ? 'applied' : result.errorCode).toBe('applied');
    expect(f.rootLaunches()).toBe(1);
    expect(f.mutations()).toBe(1);
  });
  it('links a nonselected observed engine collision before non-root rootful local effects', async () => {
    const f = await rootfulDockerSetup();
    const processLinks = vi.spyOn(nativeFs, 'readlink');
    const processFiles = vi.spyOn(nativeFs, 'readFile');
    const processDirectories = vi.spyOn(nativeFs, 'readdir');
    let infoReads = 0;
    let censusReads = 0;
    const result = await machineNativeEffectAdmission.run({ operation: { operationId: 'nonselected-deploy', kind: 'deploy' },
      keys: [{ kind: 'composeProject', dockerEndpoint: 'other-observed-engine', projectName: 'incumbent' }] }, () => applyMachineSetup({ ...f.input,
        environmentIo: { ...f.input.environmentIo, run: async request => {
          if (request.command === 'docker') infoReads++;
          if (request.command === 'systemctl') censusReads++;
          throw Object.assign(new Error('Native read unavailable'), { code: 'EACCES' });
        } } }));
    expect(result).toMatchObject({ ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'nonselected-deploy' } });
    expect(f.rootLaunches()).toBe(0);
    expect(f.mutations()).toBe(0);
    expect(infoReads).toBe(0);
    expect(censusReads).toBe(0);
    for (const calls of [processLinks.mock.calls, processFiles.mock.calls, processDirectories.mock.calls]) {
      expect(calls.filter(([path]) => String(path).startsWith('/proc/'))).toEqual([]);
    }
  });
  it('cancels an empty-inventory canonical info read before any root or mutating native effect', async () => {
    const f = await rootfulDockerSetup();
    const result = await applyMachineSetup({ ...f.input, environmentIo: { ...f.input.environmentIo, run: async request => {
      if (request.command === 'systemctl') return { exitCode: 0, stdout: 'ActiveState=active\nMainPID=2352\n' };
      f.controller.abort();
      return { exitCode: 0, stdout: '{"ID":"selected-engine"}' };
    } } });
    expect(result).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.rootLaunches()).toBe(0);
    expect(f.mutations()).toBe(0);
  });
  it('retains admitted engine exclusion while allowing a different engine observed after admission', async () => {
    const f = await rootfulDockerSetup(true);
    let observer: ReturnType<typeof observeDockerEngine> | undefined;
    const applying = applyMachineSetup({ ...f.input, onAdmitted: async () => {
      // Docker events/inspect are the genuine network boundary. The shared
      // observer and retained native admission owners both remain real.
      observer = observeDockerEngine('readonly-new-engine', { ids: ['native-container'],
        events: async () => ({ async dispose() {} }), inspect: async () => [], changed() {} });
      await observer.ready;
    } });
    try {
      await Promise.race([f.effectStarted, applying.then(result => { throw new Error(`Setup stopped before native effect: ${JSON.stringify(result)}`); })]);
      let competingEffects = 0;
      await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'same-engine-deploy', kind: 'deploy' },
        keys: [{ kind: 'composeProject', dockerEndpoint: 'selected-engine', projectName: 'same' }] }, async () => { competingEffects++; }))
        .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'setup-operation' });
      await machineNativeEffectAdmission.run({ operation: { operationId: 'new-engine-deploy', kind: 'deploy' },
        keys: [{ kind: 'composeProject', dockerEndpoint: 'first-observed-after-admission', projectName: 'new' }] }, async () => { competingEffects++; });
      // Unrelated native effects have no Docker coordinates and remain allowed.
      await machineNativeEffectAdmission.run({ operation: { operationId: 'unrelated-native', kind: 'fixture' }, keys: [] }, async () => { competingEffects++; });
      expect(competingEffects).toBe(2);
      f.release();
      expect(await applying).toMatchObject({ ok: true });
      await machineNativeEffectAdmission.run({ operation: { operationId: 'new-engine-after-settlement', kind: 'deploy' },
        keys: [{ kind: 'composeProject', dockerEndpoint: 'first-observed-after-admission', projectName: 'new' }] }, async () => { competingEffects++; });
      expect(competingEffects).toBe(3);
    } finally { f.release(); await applying; await observer?.dispose(); }
  });
  it('executes exact reviewed recipe plans in one admitted task and one root interpreter before daemon-user scripts', async () => {
    const f = await fixture(true);
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
    const installed = new Set<string>();
    const mutations: string[] = [];
    let failSecond = false;
    const runNative = async (command: MachineSetupNativeCommand) => {
      if (command.executable === 'bash') {
        const [action, id] = Buffer.from(command.inputBytes ?? []).toString('utf8').trim().split(' ');
        if (!id) throw new Error('Missing reviewed script bytes');
        if (action === 'check') return { code: installed.has(id) ? 0 : 1, stdout: '', stderr: '' };
        if (action === 'install') {
          if (failSecond && id === 'second') return { code: 7, stdout: 'PRIVATE_NATIVE_OUTPUT', stderr: 'PRIVATE_NATIVE_OUTPUT' };
          installed.add(id); mutations.push(id); return { code: 0, stdout: '', stderr: '' };
        }
        throw new Error('Unexpected reviewed script');
      }
      throw new Error('Unexpected native command');
    };
    const backend = createMachineSetupNativeBackend({ run: runNative });
    const items: NonNullable<MachineSetupV1['items']> = ['first', 'second'].map(id => ({ kind: 'setupRecipe', selection: {
      ref: { pluginId: 'com.example.tools', recipeId: id, revision: '1' }, inputs: {},
    } }));
    const recipePlans = await Promise.all(items.map(async (item, itemIndex) => {
      if (item.kind === 'app') throw new Error('Expected a recipe');
      return { sourceIndex: 0, itemIndex, plan: await checkMachineSetupEffectPlan({ basis: {
        kind: 'setup', machineId: 'guest', desiredRevision: 0, selection: item.selection,
      }, steps: [MachineRecipeStepV1Schema.parse({ id: 'install', kind: 'script', shell: 'bash',
        review: { title: { key: 'setup.install', fallback: 'Install {name}', params: { name: item.selection.ref.recipeId } } },
        body: `install ${item.selection.ref.recipeId}\n`, affects: 'none',
        check: { body: `check ${item.selection.ref.recipeId}\n`, unsatisfiedExitCodes: [1] } })], backend }) };
    }));
    const launches: Parameters<MachineElevationSpawn>[0][] = [];
    const spawn: MachineElevationSpawn = launch => {
      launches.push(launch);
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const nativeStdout = new PassThrough();
      // The native process pipe is a system boundary. Repeated progress frames
      // must not multiply publications of the same operation snapshot facts.
      nativeStdout.on('data', (chunk: Buffer) => {
        stdout.write(chunk);
        if (chunk.toString('utf8').includes('"type":"progress"')) {
          for (let repeat = 0; repeat < 20; repeat++) stdout.write(chunk);
        }
      });
      let settle!: (value: { code: number | null; signal: string | null }) => void;
      const settled = new Promise<{ code: number | null; signal: string | null }>(resolve => { settle = resolve; });
      void runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), { stdin, stdout: nativeStdout, runNative })
        .then(code => { stdout.end(); stderr.end(); settle({ code, signal: null }); });
      return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    const elevation: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
      readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
      observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
        rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }),
    };
    let admitted = 0;
    let publicationsBeforeScripts = 0;
    const input = { ...f.input, setup: { items, scripts: [{ body: 'echo after-recipes', affects: 'none' as const }],  },
      recipePlans, elevation, onAdmitted: async () => { admitted++; },
      onSetupApplied: () => { publicationsBeforeScripts = published.length; } };
    const scope = { accountId: 'owner', machineId: 'guest' };
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.setup.apply');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'setup-operation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    const published: NonNullable<ReturnType<typeof store.get>>[] = [];
    const unsubscribe = store.subscribe(() => {
      const snapshot = store.get(scope, 'setup-operation');
      if (snapshot) published.push(ActionOperationSnapshotV1Schema.parse(JSON.parse(JSON.stringify(snapshot))));
    });
    try {
      expect(await runner.observe({ actionId: spec.id, scope, requestId: 'setup-operation', input: {},
        execute: context => applyMachineSetup({ ...input, operation: { ...input.operation,
          operationProgress: { update: context.updateProgress },
          operationOwnerUpdate: { update: update => { f.updates.push(update); context.publishOwnerUpdate(update); } },
        } }),
      })).toMatchObject({ ok: true });
    } finally { unsubscribe(); }
    const stepSnapshots = published.flatMap(snapshot => snapshot.domainRef?.kind === 'machineSetup'
      && 'steps' in snapshot.domainRef ? [snapshot.domainRef.steps] : []);
    // Two plans deliberately reuse the same native step id. The existing store
    // publishes initial pending rows + one snapshot per real state transition.
    const distinctSteps = stepSnapshots.filter((steps, index) => index === 0
      || JSON.stringify(steps) !== JSON.stringify(stepSnapshots[index - 1]));
    expect(distinctSteps).toEqual([
      [{ planIndex: 0, stepId: 'install', label: recipePlans[0]!.plan.steps[0]!.review!.title, state: 'pending' },
        { planIndex: 1, stepId: 'install', label: recipePlans[1]!.plan.steps[0]!.review!.title, state: 'pending' }],
      expect.arrayContaining([expect.objectContaining({ planIndex: 0, state: 'running' })]),
      expect.arrayContaining([expect.objectContaining({ planIndex: 0, state: 'succeeded' })]),
      expect.arrayContaining([expect.objectContaining({ planIndex: 1, state: 'running' })]),
      expect.arrayContaining([expect.objectContaining({ planIndex: 1, state: 'succeeded' })]),
    ]);
    // Accepted/running + initial attachment/task identity + four native state
    // transitions. Twenty equal repeats per frame add zero publications.
    expect(publicationsBeforeScripts).toBe(8);
    const terminal = store.get(scope, 'setup-operation')!;
    expect(terminal).toMatchObject({ state: 'succeeded', domainRef: { steps: [
      { planIndex: 0, stepId: 'install', state: 'succeeded' }, { planIndex: 1, stepId: 'install', state: 'succeeded' },
    ], terminalId: expect.any(String), setupTask: { id: expect.any(String) } } });
    expect(projectActionOperationSnapshotForV1Reader(terminal)).not.toHaveProperty('domainRef');
    expect(mutations).toEqual(['first', 'second']);
    expect(launches).toHaveLength(1);
    expect(admitted).toBe(1);
    expect(f.spawned.map(process => process.launch.args)).toEqual([['-c', 'echo after-recipes']]);
    const task = f.updates.find(update => update.domainRef?.kind === 'machineSetup' && update.domainRef.setupTask)?.domainRef;
    if (task?.kind !== 'machineSetup' || !task.setupTask) throw new Error('Missing setup task');
    const progress = await getLiveSystemTasksRunnerAdapter().poll({ taskId: task.setupTask.id, cursor: 0 });
    expect(progress).toMatchObject({ events: expect.arrayContaining([
      expect.objectContaining({ type: 'machine.setup.progress', data: expect.objectContaining({ phase: 'verify', planIndex: 0 }) }),
      expect.objectContaining({ type: 'machine.setup.progress', data: expect.objectContaining({ phase: 'verify', planIndex: 1 }) }),
    ]) });
    // Reapplying the admitted setup observes the installed recipes and skips
    // their effects while continuing the requested toolchain and script work.
    const stale = { ...input, setup: { ...input.setup, toolchain: f.input.setup.toolchain } };
    expect(await applyMachineSetup(stale)).toMatchObject({ ok: true });
    expect(mutations).toEqual(['first', 'second']);
    expect(f.spawned.at(-1)?.launch.args).toEqual(['-c', 'echo after-recipes']);
    await expect(readFile(join(f.home, '.config/mise/config.toml'), 'utf8')).resolves.toContain('[env]');
    installed.delete('second');
    failSecond = true;
    const failed = await applyMachineSetup(input);
    expect(failed).toMatchObject({ ok: false, errorCode: 'native_effect_failed' });
    const failedAttachment = f.updates.at(-1)?.domainRef;
    expect(failedAttachment).toMatchObject({ kind: 'machineSetup', steps: [
      { planIndex: 0, stepId: 'install', state: 'succeeded' },
      { planIndex: 1, stepId: 'install', state: 'failed', failureCause: 'native_effect_failed' },
    ] });
    expect(JSON.stringify(failedAttachment)).not.toContain('PRIVATE_NATIVE_OUTPUT');
  });
  it('refuses config and process effects when cancelled during native tool resolution', async () => {
    const f = await fixture(true);
    const result = await applyMachineSetup({ ...f.input,
      environmentIo: { ...f.input.environmentIo, resolveTool: async () => {
        f.controller.abort();
        return { executablePath: '/tools/runtime', args: ['mise'], version: '2026.10.4' };
      } } });
    expect(result).toMatchObject({ ok: false, errorCode: 'cancelled' });
    await expect(readFile(join(f.home, '.config/mise/config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.spawned).toHaveLength(0);
    expect(f.nativeRequests).toHaveLength(0);
  });
  it('reserves native impacts of satisfied later recipe steps before an earlier recipe can change them', async () => {
    const f = await fixture(true);
    const item = { kind: 'setupRecipe' as const, selection: {
      ref: { pluginId: 'com.example.tools', recipeId: 'docker', revision: '1' }, inputs: {},
    } };
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0,
      selection: item.selection }, steps: [{ id: 'earlier', kind: 'command', executable: 'fixture-apply', args: [],
        check: { executable: 'fixture-check', args: [], unsatisfiedExitCodes: [1] } },
      { id: 'docker', kind: 'serviceUnit', unit: 'docker.service', enabled: true, running: true }],
      backend: createMachineSetupNativeBackend({ run: async command => command.executable === 'fixture-check'
        ? { code: 1, stdout: '', stderr: '' } : { code: 0,
          stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n', stderr: '' } }) });
    let release!: () => void;
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const held = machineNativeEffectAdmission.run({ operation: { operationId: 'incumbent-compose', kind: 'fixture' },
      keys: [{ kind: 'composeProject', dockerEndpoint: 'engine', projectName: 'incumbent' }] }, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await running;
    try {
      expect(await applyMachineSetup({ ...f.input, setup: { items: [item] }, recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }],
        environmentIo: { ...f.input.environmentIo, run: async request => request.command === 'systemctl'
          ? { exitCode: 0, stdout: 'ActiveState=active\nMainPID=42\n' } : { exitCode: 0, stdout: '{"ID":"engine"}' } } }))
        .toMatchObject({ ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'incumbent-compose' } });
      expect(f.spawned).toEqual([]);
    } finally { release(); await held; }
  });
  it('does unrelated setup without physical engine reads when the Docker prefix is already satisfied', async () => {
    const f = await fixture(true);
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
    let installed = false;
    const mutations: string[] = [];
    const runNative = async (command: MachineSetupNativeCommand) => {
      if (command.executable === 'systemctl') return { code: 0,
        stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n', stderr: '' };
      if (command.executable === 'fixture-check') return { code: installed ? 0 : 1, stdout: '', stderr: '' };
      if (command.executable === 'fixture-apply') { installed = true; mutations.push('unrelated'); return { code: 0, stdout: '', stderr: '' }; }
      throw new Error('Unexpected native command');
    };
    const item = { kind: 'setupRecipe' as const, selection: {
      ref: { pluginId: 'com.example.tools', recipeId: 'unrelated', revision: '1' }, inputs: {},
    } };
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0,
      selection: item.selection }, steps: [{ id: 'docker', kind: 'serviceUnit', unit: 'docker.service', enabled: true, running: true },
      { id: 'unrelated', kind: 'command', executable: 'fixture-apply', args: [],
        check: { executable: 'fixture-check', args: [], unsatisfiedExitCodes: [1] } }], backend: createMachineSetupNativeBackend({ run: runNative }) });
    expect(plan.nativeFacts.map(fact => fact.status)).toEqual(['satisfied', 'drifted']);
    let launches = 0;
    const spawn: MachineElevationSpawn = launch => {
      launches++;
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      let settle!: (value: { code: number | null; signal: string | null }) => void;
      const settled = new Promise<{ code: number | null; signal: string | null }>(resolve => { settle = resolve; });
      void runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1), { stdin, stdout, runNative })
        .then(code => { stdout.end(); stderr.end(); settle({ code, signal: null }); });
      return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    let probes = 0;
    const result = await applyMachineSetup({ ...f.input, setup: { items: [item] }, recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }],
      environmentIo: { ...f.input.environmentIo, run: async () => { probes++; return { exitCode: 0, stdout: 'ActiveState=active\nMainPID=42\n' }; } },
      elevation: { installationId: 'installation', installedCli: '/managed/happier', spawn,
        readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
        observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
          rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }) } });
    expect(result.ok ? 'applied' : result.errorCode).toBe('applied');
    expect(mutations).toEqual(['unrelated']);
    expect(launches).toBe(1);
    expect(probes).toBe(0);
  });
  it.each([
    { unit: 'docker.service', dockerMissing: false, errorCode: 'admin_access_unavailable' },
    { unit: 'containerd.service', dockerMissing: false, errorCode: 'admin_access_unavailable' },
    { unit: 'docker.service', dockerMissing: true, errorCode: 'admin_access_unavailable' },
  ])('keeps local $unit effects behind engine admission and administrator access (missing $dockerMissing)', async ({ unit, dockerMissing, errorCode }) => {
    const f = await fixture(true);
    const item = { kind: 'setupRecipe' as const, selection: {
      ref: { pluginId: 'com.example.tools', recipeId: 'local-engine', revision: '1' }, inputs: {},
    } };
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0,
      selection: item.selection }, steps: [{ id: 'stop', kind: 'serviceUnit', unit, enabled: true, running: false }],
      backend: createMachineSetupNativeBackend({ run: async () => ({ code: 0,
        stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n', stderr: '' }) }) });
    let publications = 0;
    let engineReads = 0;
    const result = await applyMachineSetup({ ...f.input, setup: { items: [item] },
      recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }], onAdmitted: async () => { publications++; },
      environmentIo: { ...f.input.environmentIo, run: async request => {
        expect(request.command).toBe('docker');
        engineReads++;
        if (dockerMissing) throw Object.assign(new Error('Docker executable is absent'), { code: 'ENOENT' });
        return { exitCode: 1, stdout: '', stderr: 'Cannot connect to Docker' };
      } } });
    expect(result).toMatchObject({ ok: false, errorCode });
    // Unreadable Docker changes exclusion scope, not administrator requirements.
    expect(publications).toBe(1);
    expect(engineReads).toBe(1);
    expect(f.spawned).toEqual([]);
  });
  it('excludes observed engine work before a reviewed Docker configuration effect', async () => {
    const f = await fixture(true);
    const reviewedPath = join(f.home, 'daemon.json');
    await nativeFs.writeFile(reviewedPath, '{}');
    const item = { kind: 'setupRecipe' as const, selection: {
      ref: { pluginId: 'com.example.tools', recipeId: 'configure-engine', revision: '1' }, inputs: {},
    } };
    const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0,
      selection: item.selection }, steps: [{ id: 'data-root', kind: 'file', path: reviewedPath, owner: 'root', group: 'root', mode: 0o600,
        content: { kind: 'jsonMerge', value: { 'data-root': '/new-engine-data' } }, validate: 'docker' }],
      backend: createMachineSetupNativeBackend({ run: async command => ({ code: 0, stderr: '', stdout: command.executable === 'getent'
        ? command.args.includes('passwd') ? 'root:x:0:0::/root:/bin/sh\n' : 'root:x:0:\n' : '' }) }) });
    let reads = 0;
    const result = await machineNativeEffectAdmission.run({ operation: { operationId: 'configured-engine-work', kind: 'deploy' },
      keys: [{ kind: 'composeProject', dockerEndpoint: 'configured-engine', projectName: 'incumbent' }] }, () =>
      applyMachineSetup({ ...f.input, setup: { items: [item] }, recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }],
        environmentIo: { ...f.input.environmentIo, run: async () => { reads++; throw new Error('Observed custody needs no native probe'); } } }));
    expect(result).toMatchObject({ ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'configured-engine-work' } });
    expect(reads).toBe(0);
    expect(f.spawned).toEqual([]);
  });
  it.each<Readonly<{ name: string; setup: MachineSetupV1; errorCode: string }>>([
    { name: 'ordered items', setup: { items: [{ kind: 'setupRecipe',
      selection: { ref: { pluginId: 'example.machine', recipeId: 'fonts', revision: '1' }, inputs: {} } }] },
      errorCode: 'machine_setup_items_unsupported' },
    { name: 'script required facts', setup: { scripts: [{ body: 'echo setup', affects: 'none',
      check: { executable: 'test', args: ['-f', '/prepared'], unsatisfiedExitCodes: [1],
        requiredFacts: [{ kind: 'administrator' }] } }] },
      errorCode: 'machine_setup_script_check_unsupported' },
  ])('refuses unimplemented ordered items or script checks before any toolchain or script effect ($name)', async ({ setup, errorCode }) => {
    const f = await fixture(true);
    const result = await applyMachineSetup({ ...f.input, setup: { ...f.input.setup, ...setup } });
    expect(result).toMatchObject({ ok: false, errorCode });
    await expect(readFile(join(f.home, '.config/mise/config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.spawned).toHaveLength(0);
    expect(f.nativeRequests).toHaveLength(0);
  });
  it('writes native global config, installs first, then injects secrets only in the setup process', async () => {
    const f = await fixture();
    const work = applyMachineSetup(f.input);
    await expect.poll(() => f.spawned.length).toBe(1);
    expect(f.updates.at(-1)?.domainRef).toMatchObject({ kind: 'machineSetup', setupTask: {
      id: expect.any(String), taskKind: 'machine.setup.apply.v1',
    } });
    expect(await readFile(join(f.home, '.config/mise/config.toml'), 'utf8')).toBe(f.input.setup.toolchain.config);
    expect(f.spawned[0]!.launch).toMatchObject({ file: '/tools/runtime', args: ['mise', 'install'], options: { cwd: f.home } });
    expect(f.spawned[0]!.launch.options.env).not.toHaveProperty('SETUP_SECRET');
    f.spawned[0]!.pty.exit(0);
    await expect.poll(() => f.spawned.length).toBe(2);
    expect(f.nativeRequests).toEqual([expect.objectContaining({ command: '/tools/runtime', args: ['mise', 'exec', '--', '/usr/bin/env', '-0'] })]);
    expect(f.spawned[1]!.launch).toMatchObject({ file: '/bin/bash', args: ['-c', 'echo setup'], options: { env: { PATH: '/native', SETUP_SECRET: 'private-value' } } });
    expect(f.spawned[1]!.launch.options.env).not.toHaveProperty('REMOVE');
    f.spawned[1]!.pty.exit(0);
    expect(await work).toMatchObject({ ok: true, result: { operationId: 'setup-operation', terminalId: expect.any(String) } });
    expect(f.updates.at(-1)?.domainRef).toMatchObject({ kind: 'machineSetup', terminals: { install: expect.any(String), setup: expect.any(String) }, terminalId: expect.any(String) });
    const retained = ActionOperationDomainRefV1Schema.parse(JSON.parse(JSON.stringify(f.updates.at(-1)?.domainRef)));
    expect(retained).toMatchObject({ setupTask: { taskKind: 'machine.setup.apply.v1' } });
    if (retained.kind !== 'machineSetup' || !retained.setupTask) throw new Error('Missing admitted setup task');
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...retained,
      setupTask: { ...retained.setupTask, taskKind: 'system.noop.v1' } }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ kind: 'systemTask', id: retained.setupTask.id,
      taskKind: retained.setupTask.taskKind }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...retained,
      setupTask: { ...retained.setupTask, password: 'not-published' } }).success).toBe(false);
    const owner = getLiveSystemTasksRunnerAdapter();
    expect(await owner.wait({ taskId: retained.setupTask.id })).toMatchObject({ ok: true,
      data: { operationId: 'setup-operation' } });
    const installing = f.updates.find(update => update.domainRef?.kind === 'machineSetup'
      && update.domainRef.terminalId && !update.domainRef.terminals?.setup)?.domainRef;
    if (!installing) throw new Error('Missing original install output');
    const store = createActionOperationStore();
    const scope = { accountId: 'owner', machineId: 'guest' };
    store.create({ operationId: 'setup-operation', actionId: 'machines.setup.apply', title: 'Set up Machine',
      scope, cancellation: 'supported', inputIdentity: '{}', domainRef: installing });
    const before = store.get(scope, 'setup-operation');
    let publications = 0;
    const unsubscribe = store.subscribe(() => { publications++; });
    try {
      store.updateDomainRef('setup-operation', ActionOperationDomainRefV1Schema.parse(JSON.parse(JSON.stringify(installing))));
      expect(publications).toBe(0);
      expect(store.get(scope, 'setup-operation')).toBe(before);
      store.updateDomainRef('setup-operation', retained);
      expect(publications).toBe(1);
      expect(store.get(scope, 'setup-operation')?.domainRef).toEqual(retained);
    } finally { unsubscribe(); }
    for (const kind of ['machine.setup.plan.v1', 'machine.setup.apply.v1', 'machine.setup.remove.v1']) {
      expect(listAdvertisedSystemTaskKinds({ canUpdateCliRemotely: false })).not.toContain(kind);
      await expect(owner.start({ spec: { protocolVersion: 1, kind, params: {} } })).rejects.toThrow();
    }
    expect(JSON.stringify(f.updates)).not.toContain('private-value');
  });
  it('uses a declared satisfied native check instead of repeating a retained script', async () => {
    const f = await fixture(true);
    const result = await applyMachineSetup({ ...f.input, setup: {
      scripts: [{ body: '\r\necho retained\r\n', affects: 'none', check: { executable: 'test', args: ['-f', '/prepared'], unsatisfiedExitCodes: [1] } }],

    } });
    expect(result).toMatchObject({ ok: true });
    expect(f.spawned).toHaveLength(0);
    expect(f.nativeRequests).toEqual([expect.objectContaining({ command: 'test', args: ['-f', '/prepared'] })]);
  });
  it('runs retained source scripts separately in attachment order under one setup task and source-scoped secret overlays', async () => {
    const f = await fixture(true);
    const first = '\r\necho first\r\n';
    const second = 'echo second\r\n';
    const result = await applyMachineSetup({ ...f.input, setup: [
      { ...f.input.setup, scripts: [{ ...f.input.setup.scripts[0]!, body: first }] },
      { scripts: [{ body: second, affects: 'none' }],  },
    ] });
    expect(result).toMatchObject({ ok: true });
    expect(f.spawned.map(process => process.launch.args)).toEqual([
      ['mise', 'install'], ['-c', first], ['-c', second],
    ]);
    expect(f.spawned[1]?.launch.options.env).toMatchObject({ PATH: '/native', SETUP_SECRET: 'private-value' });
    expect(f.spawned[2]?.launch.options.env).toMatchObject({ PATH: '/native' });
    expect(f.spawned[2]?.launch.options.env).not.toHaveProperty('SETUP_SECRET');
    const taskIds = new Set(f.updates.flatMap(update => update.domainRef?.kind === 'machineSetup' && update.domainRef.setupTask
      ? [update.domainRef.setupTask.id] : []));
    expect(taskIds.size).toBe(1);
  });
  it.each(['toolchain', 'secretRefs'] as const)('refuses conflicting source %s before any setup effect', async field => {
    const f = await fixture(true);
    const changed = field === 'toolchain' ? { ...f.input.setup, toolchain: { ...f.input.setup.toolchain, config: '[tools]\nnode="24"\n' } }
      : { ...f.input.setup, secretRefs: { v: 1 as const, bindings: { SETUP_SECRET: { ref: 'different' } } } };
    expect(await applyMachineSetup({ ...f.input, setup: [f.input.setup, changed] }))
      .toMatchObject({ ok: false, errorCode: 'machine_setup_conflict' });
    expect(f.spawned).toHaveLength(0);
    expect(f.nativeRequests).toHaveLength(0);
    await expect(readFile(join(f.home, '.config/mise/config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([0, 1])('runs an unsatisfied retained script once and verifies its native check afterward (%i)', async verifiedExitCode => {
    const f = await fixture(true);
    let checks = 0;
    const body = '\r\necho retained\r\n';
    const result = await applyMachineSetup({ ...f.input, setup: {
      scripts: [{ body: body, affects: 'none', check: { executable: 'test', args: ['-f', '/prepared'], unsatisfiedExitCodes: [1] } }],  secretRefs: f.input.setup.secretRefs,

    }, environmentIo: { ...f.input.environmentIo, run: async request => {
      f.nativeRequests.push(request);
      return { exitCode: ++checks === 1 ? 1 : verifiedExitCode, stdout: 'private check output' };
    } } });
    expect(result).toMatchObject(verifiedExitCode === 0 ? { ok: true }
      : { ok: false, errorCode: 'machine_setup_script_check_failed' });
    expect(checks).toBe(2);
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.launch).toMatchObject({ file: '/bin/bash', args: ['-c', body],
      options: { env: { SETUP_SECRET: 'private-value' } } });
    expect(f.nativeRequests).toEqual([expect.objectContaining({ env: expect.objectContaining({ SETUP_SECRET: 'private-value' }) }),
      expect.objectContaining({ env: expect.objectContaining({ SETUP_SECRET: 'private-value' }) })]);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('does not interpret an undeclared probe failure as permission to repeat the script', async () => {
    const f = await fixture(true);
    const result = await applyMachineSetup({ ...f.input, setup: {
      scripts: [{ body: 'echo do-not-run', affects: 'none', check: { executable: 'test', args: ['-f', '/prepared'], unsatisfiedExitCodes: [1] } }],

    }, environmentIo: { ...f.input.environmentIo, run: async () => ({ exitCode: 7, stdout: 'private check output' }) } });
    expect(result).toMatchObject({ ok: false, errorCode: 'machine_setup_script_check_unavailable' });
    expect(f.spawned).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('retains the setup operation after an unconfirmed native check process until native reconciliation', async () => {
    const f = await fixture(true);
    const setup = { scripts: [{ body: 'echo retained', affects: 'none' as const, check: { executable: 'test', args: ['-f', '/prepared'], unsatisfiedExitCodes: [1] } }],
       };
    try {
      const result = await applyMachineSetup({ ...f.input, setup, environmentIo: { ...f.input.environmentIo, run: async () => {
        throw Object.assign(new Error('private native output'), { code: 'plugin_exec_termination_incomplete' });
      } } });
      expect(result).toMatchObject({ ok: false, errorCode: 'plugin_exec_termination_incomplete' });
      expect(JSON.stringify(result)).not.toContain('private');
      expect(f.spawned).toHaveLength(0);
      expect(await applyMachineSetup({ ...f.input, setup,
        operation: { ...f.input.operation, actionRequestId: 'competing-check' } })).toMatchObject({
        ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'setup-operation' },
      });
    } finally {
      // This test owns the substituted process boundary; only that process's
      // confirmed physical settlement can retire its retained native admission.
      await machineNativeEffectAdmission.reconcileUnknown({ keys: [{ kind: 'machineSetup' }],
        observeSettled: async operation => operation.operationId === 'setup-operation' });
    }
    expect(await applyMachineSetup({ ...f.input, setup })).toMatchObject({ ok: true });
  });
  it('allows a fresh reviewed package retry after the failed native command process has settled', async () => {
    const f = await fixture(true);
    vi.spyOn(process as NodeJS.Process & { getuid: () => number }, 'getuid').mockReturnValue(0);
    const installed = new Set<string>();
    const commands: string[] = [];
    let failInstall = true;
    const runNative = async (command: MachineSetupNativeCommand) => {
      if (command.executable === 'dpkg') return { code: 0, stdout: 'amd64\n', stderr: '' };
      if (command.executable === 'dpkg-query') return installed.has(command.args.at(-1)!)
        ? { code: 0, stdout: `${command.args.at(-1)}\tinstall ok installed\t1.0\tamd64\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
      if (command.executable === 'lslocks') return { code: 0, stdout: '{"locks":[]}', stderr: '' };
      if (command.executable === 'apt-cache') return { code: 0, stdout: command.args[0] === 'policy'
        ? `${command.args.at(-1)}:\n  Candidate: 1.0\n     1.0 500\n`
        : `Package: ${command.args.at(-1)!.split('=')[0]}\nVersion: 1.0\nArchitecture: amd64\n`, stderr: '' };
      if (command.executable === 'apt-get' && command.args[0] === '--version') return { code: 0, stdout: 'apt 2.6\n', stderr: '' };
      if (command.executable === 'apt-get' && command.args[0] === 'install') {
        const name = command.args.at(-1)!.split('=')[0]!;
        commands.push(name);
        if (name === 'hello' && failInstall) return { code: 1, stdout: '', stderr: 'private apt diagnostic' };
        installed.add(name);
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected native command ${command.executable}`);
    };
    const selection = { ref: { pluginId: 'com.example.tools', recipeId: 'hello', revision: '1' }, inputs: {} };
    const item = { kind: 'setupRecipe' as const, selection };
    const steps = ['first', 'hello'].map(id => MachineRecipeStepV1Schema.parse({ id, kind: 'package', manager: 'apt', packages: [{ name: id }] }));
    const plan = () => checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0, selection },
      steps, backend: createMachineSetupNativeBackend({ run: runNative }) });
    const spawn: MachineElevationSpawn = launch => {
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const settled = runMachineSetupEffectInternal(launch.args.slice(launch.args.indexOf('effect-internal') + 1),
        { stdin, stdout, runNative, readUid: () => 0 }).then(code => {
          stdout.end(); stderr.end(); return { code, signal: null };
        });
      return { stdin, stdout, stderr, settled, terminate: async () => { stdin.destroy(); await settled; } };
    };
    const elevation: MachineElevationDependencies = { installationId: 'installation', installedCli: '/managed/happier', spawn,
      readPolicy: async () => ({ version: 1, mode: 'preauthorized' }), verifyCurrent: async () => true,
      observe: async () => ({ version: 1, observedAt: 0, daemonUid: 1001, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
        rootEquivalentGroups: [], passwordlessSudoToRoot: 'allowed', managedDropIn: 'valid', tailscaledOperator: { authorization: 'unknown' } }) };
    const input = { ...f.input, setup: { items: [item] }, elevation };
    try {
      const first = await applyMachineSetup({ ...input, recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: await plan() }] });
      expect(first).toMatchObject({ ok: false, errorCode: 'native_effect_failed', details: { kind: 'machineSetup', failure: {
        nativeCommand: { command: 'apt-get', phase: 'install', exitCode: 1, category: 'command_failed' },
      } } });
      failInstall = false;
      const second = await applyMachineSetup({ ...input, operation: { ...f.input.operation, actionRequestId: 'fresh-review' },
        recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: await plan() }] });
      expect(second).toMatchObject({ ok: true });
      expect(commands).toEqual(['first', 'hello', 'hello']);
      expect([...installed].sort()).toEqual(['first', 'hello']);
      expect(JSON.stringify(first)).not.toContain('private apt diagnostic');
    } finally {
      // Retire only after assertions; this cleanup cannot make the retry pass.
      await machineNativeEffectAdmission.reconcileUnknown({ keys: [{ kind: 'machineSetup' }],
        observeSettled: async operation => operation.operationId === 'setup-operation' });
    }
  });
  it('keeps cancellation pending until actual process exit and never starts the setup script', async () => {
    const f = await fixture();
    let settled = false;
    const work = applyMachineSetup(f.input).finally(() => { settled = true; });
    await expect.poll(() => f.spawned.length).toBe(1);
    f.controller.abort();
    await expect.poll(() => f.stopped()).toBe(1);
    expect(settled).toBe(false);
    f.spawned[0]!.pty.exit(0);
    expect(await work).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.spawned).toHaveLength(1);
  });
  it('keeps task cancellation pending until native exit and retains the same failed task through reload', async () => {
    const f = await fixture();
    let settled = false;
    const work = applyMachineSetup(f.input).finally(() => { settled = true; });
    await expect.poll(() => f.spawned.length).toBe(1);
    const running = ActionOperationDomainRefV1Schema.parse(f.updates.at(-1)?.domainRef);
    if (running.kind !== 'machineSetup' || !running.setupTask) throw new Error('Missing admitted setup task');
    const task = { taskId: running.setupTask.id };
    const owner = getLiveSystemTasksRunnerAdapter();
    try {
      await owner.cancel(task);
      await expect.poll(() => f.stopped()).toBe(1);
      expect(settled).toBe(false);
      expect((await owner.poll({ ...task, cursor: 0 })) as { result: unknown }).toMatchObject({ result: null });
      f.spawned[0]!.pty.exit(0);
      expect(await work).toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect(await owner.wait(task)).toMatchObject({ ok: false, error: { code: 'cancelled' } });
      const reloaded = ActionOperationDomainRefV1Schema.parse(JSON.parse(JSON.stringify(f.updates.at(-1)?.domainRef)));
      expect(reloaded).toMatchObject({ setupTask: running.setupTask, terminalId: running.terminalId });
      expect(f.spawned).toHaveLength(1);
    } finally { f.controller.abort(); f.spawned[0]!.pty.exit(0); await work; }
  });
  it('stops on containing transport cancellation without confusing it with the owned Stop signal', async () => {
    const f = await fixture();
    const external = new AbortController();
    const work = applyMachineSetup({ ...f.input, signal: external.signal,
      operation: { ...f.input.operation, operationCancellation: { onRequest() { return () => {}; } } } });
    await expect.poll(() => f.spawned.length).toBe(1);
    try {
      external.abort();
      await expect.poll(() => f.stopped()).toBe(1);
      expect(f.input.operation.signal.aborted).toBe(false);
      f.spawned[0]!.pty.exit(0);
      expect(await work).toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect(f.spawned).toHaveLength(1);
    } finally { f.controller.abort(); f.spawned[0]!.pty.exit(0); await work; }
  });
  it('refuses an unsupported global adapter before writing files or executing commands', async () => {
    const f = await fixture();
    expect(await applyMachineSetup({ ...f.input, setup: { toolchain: { adapterId: 'pixi', config: 'unsupported' } } }))
      .toMatchObject({ ok: false, errorCode: 'native_adapter_not_characterized' });
    expect(f.spawned).toHaveLength(0);
    await expect(readFile(join(f.home, '.config/mise/config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('honors the native global path overrides and stops after a failed install', async () => {
    const f = await fixture();
    const custom = join(f.home, 'custom config', 'chosen.toml');
    const work = applyMachineSetup({ ...f.input, hostEnvironment: { ...f.input.hostEnvironment,
      MISE_GLOBAL_CONFIG_FILE: custom, MISE_CONFIG_DIR: join(f.home, 'ignored'), XDG_CONFIG_HOME: join(f.home, 'also-ignored') } });
    await expect.poll(() => f.spawned.length).toBe(1);
    expect(await readFile(custom, 'utf8')).toBe(f.input.setup.toolchain.config);
    expect(f.spawned[0]!.launch.options.env).toMatchObject({ MISE_OVERRIDE_CONFIG_FILENAMES: custom });
    f.spawned[0]!.pty.exit(5);
    expect(await work).toMatchObject({ ok: false, errorCode: 'machine_setup_install_failed' });
    expect(f.spawned).toHaveLength(1);
    expect(f.nativeRequests).toHaveLength(0);
  });
  it('does not run setup or expose private diagnostics after native environment failure', async () => {
    const f = await fixture();
    const work = applyMachineSetup({ ...f.input, environmentIo: { ...f.input.environmentIo,
      run: async () => ({ exitCode: 42, stdout: 'private-native-diagnostic' }) } });
    await expect.poll(() => f.spawned.length).toBe(1);
    f.spawned[0]!.pty.exit(0);
    const result = await work;
    expect(result).toMatchObject({ ok: false, errorCode: 'native_toolchain_failed' });
    expect(JSON.stringify(result)).not.toContain('private-native-diagnostic');
    expect(f.spawned).toHaveLength(1);
  });
  it('waits for cancelled native environment IO to settle before returning without setup', async () => {
    const f = await fixture();
    let release!: () => void;
    let nativeEntered = false;
    const nativeExit = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const work = applyMachineSetup({ ...f.input, environmentIo: { ...f.input.environmentIo,
      run: async () => { nativeEntered = true; await nativeExit; return { exitCode: 0, stdout: 'PATH=/native\0' }; } } }).finally(() => { settled = true; });
    await expect.poll(() => f.spawned.length).toBe(1);
    f.spawned[0]!.pty.exit(0);
    await expect.poll(() => nativeEntered).toBe(true);
    f.controller.abort();
    expect(settled).toBe(false);
    release();
    expect(await work).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.spawned).toHaveLength(1);
  });
  it.each([
    { platform: 'darwin' as const, shellEnv: { SHELL: '/bin/zsh' }, file: '/bin/zsh', args: ['-c', 'echo setup'] },
    { platform: 'win32' as const, shellEnv: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'echo setup'] },
    { platform: 'win32' as const, shellEnv: { HAPPIER_DAEMON_TERMINAL_SHELL: 'C:\\PowerShell\\pwsh.exe' },
      file: 'C:\\PowerShell\\pwsh.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'echo setup'] },
  ])('uses the canonical script-only shell on $platform without a native toolchain', async ({ platform, shellEnv, file, args }) => {
    const f = await fixture();
    const work = applyMachineSetup({ ...f.input, platform, hostEnvironment: { ...f.input.hostEnvironment, ...shellEnv },
      setup: { scripts: [{ body: 'echo setup', affects: 'none' }],  secretRefs: f.input.setup.secretRefs } });
    await expect.poll(() => f.spawned.length).toBe(1);
    expect(f.spawned[0]!.launch).toMatchObject({ file, args, options: { cwd: f.home, env: { PATH: '/host', REMOVE: 'remove', SETUP_SECRET: 'private-value' } } });
    f.spawned[0]!.pty.exit(0);
    expect(await work).toMatchObject({ ok: true, result: { operationId: 'setup-operation' } });
    expect(f.nativeRequests).toHaveLength(0);
    await expect(readFile(join(f.home, '.config/mise/config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
