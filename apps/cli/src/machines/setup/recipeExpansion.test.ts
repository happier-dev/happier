import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createActionExecutor, createEmptyMachineSetupDesiredV1, getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { createMachineSetupPlanAction } from './machineSetupAction';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { MachineSetupNativeCommand, MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';

async function authoredPlan(recipe: unknown, runNative: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>) {
  const pluginId = 'com.example.recipe-expansion';
  const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {}, manifest: {
    schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Recipe expansion', runtime: { apiVersion: 1 },
    contributes: { machineRecipes: [recipe] },
  } }] });
  const actionOptions = { homeId: 'home', machineId: 'guest', runNative,
    apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: { setup: createEmptyMachineSetupDesiredV1() }, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Plan cannot publish desired setup'); },
    }) },
    acquirePluginRuntimeRegistryLease: () => acquireAuthoritativePluginRuntimeRegistryLease({
      controller: runtime.controller, happyHomeDir: runtime.happyHomeDir,
    }),
  };
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction(actionOptions) });
  const execute = (inputs: unknown, mode?: 'check' | 'effects') => executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'guest',
    ...(mode ? { mode } : {}), sources: [
    { kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection: {
      ref: { pluginId, recipeId: 'configured', revision: '1' }, inputs,
    } }] } },
  ] }, { surface: 'cli', authority: 'present_user' });
  return { execute, dispose: runtime.dispose, ref: { pluginId, recipeId: 'configured', revision: '1' } };
}

describe('Machine recipe expansion through the receiving Plan Action', () => {
  it.each([
    { affects: 'dockerEngine', downtime: 'possible' },
    { affects: { services: ['environment/database'] }, downtime: 'possible' },
    { affects: 'none', downtime: 'unknown' },
  ])('keeps unsupported native effects explicit while reviewing their declared impact ($downtime)', async ({ affects, downtime }) => {
    const fixture = await authoredPlan({ id: 'configured', revision: '1', title: 'Declared impact',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [
        { id: 'native', kind: 'command', executable: 'fixture-apply', args: [], affects,
          check: { executable: 'fixture-check', args: [], unsatisfiedExitCodes: [1] } },
      ],
    }, async () => { throw new Error('Unsupported declaration must not probe or run'); });
    try {
      expect(await fixture.execute({}, 'effects')).toMatchObject({ ok: true, result: {
        support: [{ sourceIndex: 0, itemIndex: 0, status: 'unsupported' }],
        review: { target: { homeId: 'home', machineId: 'guest' }, administratorRequired: true, downtime },
      } });
    } finally { await fixture.dispose(); }
  });
  it('discloses the actual administrator execution requirement even when native checks are already satisfied', async () => {
    const fixture = await authoredPlan({ id: 'configured', revision: '1', title: 'Checked native effect',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [
        { id: 'native', kind: 'command', executable: 'fixture-apply', args: [],
          check: { executable: 'fixture-check', args: [], unsatisfiedExitCodes: [1] } },
      ],
    }, async command => {
      if (command.executable !== 'fixture-check') throw new Error('Plan cannot execute effects');
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      expect(await fixture.execute({}, 'effects')).toMatchObject({ ok: true, result: {
        support: [{ sourceIndex: 0, itemIndex: 0, status: 'satisfied' }],
        review: { target: { homeId: 'home', machineId: 'guest' }, administratorRequired: true, downtime: 'none' },
      } });
    } finally { await fixture.dispose(); }
  });
  it('binds reviewed user, file and exact package inputs and renders templates once before native observation', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'happier-recipe-binding-'));
    const path = join(scratch, 'authorized_keys');
    const input = (path: string) => ({ kind: 'input', path });
    const calls: MachineSetupNativeCommand[] = [];
    const fixture = await authoredPlan({ id: 'configured', revision: '1', title: 'Configured',
      inputSchema: { type: 'object', properties: {
        receiver: { type: 'object', properties: { username: { type: 'string' }, keyPath: { type: 'string' }, home: { type: 'string' } },
          required: ['username', 'keyPath'], additionalProperties: false },
        senderPublicKey: { type: 'string' }, manager: { type: 'string' },
        packages: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
      }, required: ['receiver', 'manager', 'packages'], additionalProperties: false },
      steps: [
        { id: 'receiver', kind: 'user', username: input('receiver.username'), home: input('receiver.home') },
        { id: 'sender-key', kind: 'file', path: input('receiver.keyPath'), owner: input('receiver.username'), group: 'root', mode: 0o600,
          content: { kind: 'template', value: 'restrict {senderKey}\n', variables: { senderKey: input('senderPublicKey') } } },
        { id: 'package', kind: 'package', manager: input('manager'), packages: input('packages') },
      ],
    }, async command => {
      calls.push(command);
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (command.executable === 'getent') return ok(command.args.includes('passwd') ? 'root:x:0:0:root:/root:/bin/sh\n' : 'root:x:0:\n');
      if (command.executable === 'dpkg') return ok('amd64\n');
      if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 2.6\n');
      if (command.executable === 'dpkg-query') return { code: 1, stdout: '', stderr: '' };
      if (command.executable === 'lslocks') return ok('{"locks":[]}');
      if (command.executable === 'apt-cache') return ok(command.args[0] === 'policy'
        ? 'wanted:\n  Candidate: 1\n  Version table:\n     1 500\n' : 'Package: wanted\nVersion: 1\nArchitecture: amd64\n\n');
      throw new Error('Plan must observe without native mutation');
    }).catch(async error => { await rm(scratch, { recursive: true, force: true }); throw error; });
    try {
      const inputs = { receiver: { username: 'root', keyPath: path, home: '/root' }, senderPublicKey: 'ssh-ed25519 AAAA{senderKey}', manager: 'apt', packages: [{ name: 'wanted' }] };
      expect(await fixture.execute(inputs)).toMatchObject({ ok: true, result: {
        support: [{ sourceIndex: 0, itemIndex: 0, status: 'drifted' }],
        recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: { basis: { kind: 'setup', machineId: 'guest', desiredRevision: 0,
          selection: { ref: fixture.ref, inputs } }, steps: [
          { id: 'receiver', kind: 'user', username: 'root' },
          { id: 'sender-key', kind: 'file', path, owner: 'root', content: { kind: 'literal', value: 'restrict ssh-ed25519 AAAA{senderKey}\n' } },
          { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] },
        ] } }],
      } });
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
      calls.length = 0;
      const { senderPublicKey: _omitted, ...missingBinding } = inputs;
      expect(await fixture.execute(missingBinding)).toMatchObject({ ok: false, errorCode: 'invalid_machine_recipe_inputs' });
      expect(calls).toEqual([]);
      const { home: _missingOptional, ...receiver } = inputs.receiver;
      expect(await fixture.execute({ ...inputs, receiver })).toMatchObject({ ok: false, errorCode: 'invalid_machine_recipe_inputs' });
      expect(calls).toEqual([]);
    } finally {
      await fixture.dispose();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('does not reinterpret ref-shaped reviewed argument values as authored input references', async () => {
    const calls: MachineSetupNativeCommand[] = [];
    const fixture = await authoredPlan({ id: 'configured', revision: '1', title: 'Configured',
      inputSchema: { type: 'object', properties: {
        argument: { type: 'string' }, argv: { type: 'array', items: { type: 'object', properties: {
          kind: { type: 'string' }, path: { type: 'string' },
        }, required: ['kind', 'path'], additionalProperties: false } },
      }, required: ['argument', 'argv'], additionalProperties: false },
      steps: [{ id: 'configured', kind: 'command', executable: 'fixture-configure', args: { kind: 'input', path: 'argv' },
        check: { executable: 'fixture-check', args: [], unsatisfiedExitCodes: [1] } }],
    }, async command => { calls.push(command); return { code: 1, stdout: '', stderr: '' }; });
    try {
      expect(await fixture.execute({ argument: 'not-an-authored-ref', argv: [{ kind: 'input', path: 'argument' }] }))
        .toMatchObject({ ok: false, errorCode: 'invalid_machine_recipe_inputs' });
      expect(calls).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  it('leaves omitted optional manager branches unbound and unobserved while selecting the supported reviewed package', async () => {
    const calls: MachineSetupNativeCommand[] = [];
    const packages = { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['formula', 'cask'] } }, required: ['name'], additionalProperties: false } };
    const fixture = await authoredPlan({ id: 'configured', revision: '1', title: 'Configured',
      inputSchema: { type: 'object', properties: { apt: packages, brew: packages }, required: ['apt'], additionalProperties: false },
      checks: [
        { id: 'apt', kind: 'package', manager: 'apt', packages: { kind: 'input', path: 'apt' } },
        { id: 'brew', kind: 'package', manager: 'brew', packages: { kind: 'input', path: 'brew' } },
      ],
      steps: [
        { id: 'apt', kind: 'package', manager: 'apt', packages: { kind: 'input', path: 'apt' },
          when: [{ input: { op: 'truthy', path: 'apt' } }, { checkId: 'apt', status: ['satisfied', 'drifted'] }] },
        { id: 'brew', kind: 'package', manager: 'brew', packages: { kind: 'input', path: 'brew' },
          when: [{ input: { op: 'truthy', path: 'brew' } }, { checkId: 'brew', status: ['satisfied', 'drifted'] }] },
      ],
    }, async command => {
      calls.push(command);
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (command.executable === 'dpkg') return ok('amd64\n');
      if (command.executable === 'apt-get' && command.args[0] === '--version') return ok('apt 2.6\n');
      if (command.executable === 'dpkg-query') return { code: 1, stdout: '', stderr: '' };
      if (command.executable === 'lslocks') return ok('{"locks":[]}');
      if (command.executable === 'brew') return { code: null, errorCode: 'ENOENT', stdout: '', stderr: '' };
      if (command.executable === 'apt-cache') return ok(command.args[0] === 'policy'
        ? 'wanted:\n  Candidate: 1\n  Version table:\n     1 500\n' : 'Package: wanted\nVersion: 1\nArchitecture: amd64\n\n');
      throw new Error('No omitted manager read or native mutation is allowed');
    });
    try {
      expect(await fixture.execute({ apt: [{ name: 'wanted' }] })).toMatchObject({ ok: true, result: {
        support: [{ status: 'drifted' }], recipePlans: [{ plan: {
          steps: [{ id: 'apt', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] }],
          checks: [{ id: 'apt' }], checkFacts: [{ stepId: 'apt', status: 'drifted' }],
        } }],
      } });
      expect(calls.some(command => command.executable === 'brew')).toBe(false);
      expect(await fixture.execute({ apt: [{ name: 'wanted' }], brew: [{ name: 'wanted', kind: 'formula' }] })).toMatchObject({ ok: true, result: {
        support: [{ status: 'drifted' }], recipePlans: [{ plan: {
          steps: [{ id: 'apt', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] }],
          checks: [{ id: 'apt' }, { id: 'brew' }], selectedCheckIds: ['apt'],
        } }],
      } });
    } finally { await fixture.dispose(); }
  });

  it('binds receiver and administrator sshd context data into concrete file validator and effective probes', async () => {
    const probe = { kind: 'sshd', contexts: [
      { user: { kind: 'input', path: 'receiver' }, host: 'machine', address: '192.0.2.1' },
      { user: { kind: 'input', path: 'administrator' }, host: 'machine', address: '192.0.2.2' },
    ] };
    const fixture = await authoredPlan({ id: 'configured', revision: '1', title: 'Configured',
      inputSchema: { type: 'object', properties: { receiver: { type: 'string' }, administrator: { type: 'string' } },
        required: ['receiver', 'administrator'], additionalProperties: false },
      steps: [{ id: 'receiver-policy', kind: 'file', path: '/etc/happier-recipe-binding.conf', owner: 'root', group: 'root', mode: 0o600,
        content: { kind: 'literal', value: '# reviewed receiver policy\n' }, validate: probe, probe }],
    }, async () => ({ code: 1, stdout: '', stderr: '' }));
    try {
      const contexts = [
        { user: 'backup', host: 'machine', address: '192.0.2.1' },
        { user: 'operator', host: 'machine', address: '192.0.2.2' },
      ];
      expect(await fixture.execute({ receiver: 'backup', administrator: 'operator' })).toMatchObject({ ok: true, result: {
        recipePlans: [{ plan: { steps: [{ id: 'receiver-policy', validate: { kind: 'sshd', contexts }, probe: { kind: 'sshd', contexts } }] } }],
      } });
    } finally { await fixture.dispose(); }
  });

  it('selects package-first and explicit-unavailable fallback branches and demands no package facts when already working', async () => {
    let mode: 'working' | 'available' | 'installed' | 'none' | 'empty' | 'managerMissing' | 'denied' = 'working';
    const calls: MachineSetupNativeCommand[] = [];
    const whenPrimary = [{ checkId: 'working', status: ['drifted'] }, { checkId: 'package', status: ['satisfied', 'drifted'] }];
    const nativeCheck = { executable: 'fixture-ready', args: [], unsatisfiedExitCodes: [1] };
    const fixture = await authoredPlan({ id: 'configured', revision: '1', title: 'Configured',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      checks: [
        { id: 'working', kind: 'command', executable: 'never-apply-probe', args: [], check: nativeCheck },
        { id: 'package', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }] },
      ],
      steps: [
        { id: 'primary-package', kind: 'package', manager: 'apt', packages: [{ name: 'wanted' }], when: whenPrimary },
        { id: 'primary-register', kind: 'command', executable: 'fixture-register-package', args: [], check: nativeCheck, when: whenPrimary },
        { id: 'fallback-register', kind: 'command', executable: 'fixture-register-fallback', args: [], check: nativeCheck,
          when: [{ checkId: 'working', status: ['drifted'] }, { checkId: 'package', status: ['packageUnavailable'] }] },
      ],
    }, async command => {
      calls.push(command);
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (command.executable === 'fixture-ready') return { code: mode === 'working' ? 0 : 1, stdout: '', stderr: '' };
      if (mode === 'working') throw new Error('Satisfied readiness must not demand a package observation');
      if (command.executable === 'dpkg') return mode === 'denied'
        ? { code: null, errorCode: 'EACCES', stdout: '', stderr: '' } : ok('amd64\n');
      if (command.executable === 'apt-get' && command.args[0] === '--version') return mode === 'managerMissing'
        ? { code: null, errorCode: 'ENOENT', stdout: '', stderr: '' } : ok('apt 2.6\n');
      if (command.executable === 'dpkg-query') return mode === 'installed' ? ok('wanted\tinstall ok installed\t1\tamd64\n') : { code: 1, stdout: '', stderr: '' };
      if (command.executable === 'lslocks') return ok('{"locks":[]}');
      if (command.executable === 'apt-cache') return ok(command.args[0] === 'policy'
        ? mode === 'empty' ? '' : `wanted:\n  Candidate: ${mode === 'none' ? '(none)' : '1'}\n  Version table:\n     1 500\n`
        : 'Package: wanted\nVersion: 1\nArchitecture: amd64\n\n');
      throw new Error('Plan must not install packages or register native state');
    });
    try {
      expect(await fixture.execute({})).toMatchObject({ ok: true, result: { support: [{ status: 'satisfied' }],
        recipePlans: [{ plan: { steps: [], checks: [{ id: 'working' }], checkFacts: [{ stepId: 'working', status: 'satisfied' }] } }] } });
      expect(calls.map(command => command.executable)).toEqual(['fixture-ready']);
      for (const selectedMode of ['available', 'installed', 'none', 'empty', 'managerMissing', 'denied'] as const) {
        mode = selectedMode;
        const selected = mode === 'none' ? [{ id: 'fallback-register' }]
          : mode === 'managerMissing' || mode === 'denied' ? [] : [{ id: 'primary-package' }, { id: 'primary-register' }];
        expect(await fixture.execute({})).toMatchObject({ ok: true, result: {
          support: [{ status: mode === 'managerMissing' ? 'unsupported' : mode === 'denied' ? 'unavailable' : 'drifted',
            ...(mode === 'denied' ? { reason: 'needs_admin_to_check' } : {}) }],
          recipePlans: [{ plan: { steps: selected, checks: [{ id: 'working' }, { id: 'package' }] } }],
        } });
      }
    } finally { await fixture.dispose(); }
  });

  it('checks an exact admitted recipe through the native observer without running its effect', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'happier-recipe-expansion-'));
    const target = join(scratch, 'configured');
    const pluginId = 'com.example.recipe-expansion';
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {}, manifest: {
      schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Recipe expansion', runtime: { apiVersion: 1 },
      contributes: { machineRecipes: [{ id: 'configured', revision: '1', title: 'Configure native fixture',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        steps: [{ id: 'configured', kind: 'command', executable: '/usr/bin/touch', args: [target],
          check: { executable: '/usr/bin/test', args: ['-f', target], unsatisfiedExitCodes: [1] } }],
      }] },
    } }] });
    try {
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupPlan: createMachineSetupPlanAction({ homeId: 'home', machineId: 'guest',
        apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1({
          read: async () => ({ status: 'ready', metadata: { setup: createEmptyMachineSetupDesiredV1() }, metadataVersion: 0 }),
          compareAndSwap: async () => { throw new Error('Plan cannot publish desired setup'); },
        }) },
        acquirePluginRuntimeRegistryLease: () => acquireAuthoritativePluginRuntimeRegistryLease({
          controller: runtime.controller, happyHomeDir: runtime.happyHomeDir,
        }),
      }) });
      const result = await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'guest', sources: [
        { kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection: {
          ref: { pluginId, recipeId: 'configured', revision: '1' }, inputs: {},
        } }] } },
      ] }, { surface: 'cli', authority: 'present_user' });
      expect(result).toMatchObject({ ok: true, result: {
        support: [{ sourceIndex: 0, itemIndex: 0, status: 'drifted' }],
      } });
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runtime.dispose();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
