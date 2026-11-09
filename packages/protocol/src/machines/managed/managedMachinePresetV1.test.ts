import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import * as protocol from './managedMachinePresetV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { MachinePresetActionInputSchemasV1 } from './machinePresetActionsV1.js';
import { ManagedMachineActionInputSchemasV1 } from './actionsV1.js';
import { buildManagedConfigurationFactsV1 } from './managedConfigurationV1.js';
import { encodeBase64 } from '../../crypto/base64.js';
import tweetnacl from 'tweetnacl';

describe('managed preset launch contracts', () => {
  it('preserves pool targets without manufacturing an exact controller', () => {
    const preset = { id: 'pool-preset', homeId: 'home', name: 'Team guest',
      owner: { kind: 'team', teamId: 'team' }, teamAcquireDelegated: true,
      launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      controllerPoolId: 'c1d23348-62b4-4584-aeb2-3c8e312acc8c' };
    expect(protocol.ManagedMachinePresetCreateInputV1Schema.parse(preset)).toEqual(preset);
    expect(protocol.ManagedMachinePresetV1ReadSchema.parse({ ...preset, revision: 0 })).toMatchObject({ controllerPoolId: preset.controllerPoolId });
    expect(protocol.ManagedMachinePresetCreateInputV1Schema.safeParse({ ...preset,
      controller: { machineId: 'controller', installationId: 'installation' } }).success).toBe(false);
    expect(protocol.ManagedMachinePresetUpdateInputV1Schema.parse({ homeId: 'home', id: preset.id, expectedRevision: 0,
      patch: { controller: null, controllerPoolId: preset.controllerPoolId } })).toMatchObject({ patch: { controllerPoolId: preset.controllerPoolId } });
  });
  it('round-trips an optional author-saved controller label outside native launch choices', () => {
    const create = { id: 'named-controller', homeId: 'home', name: 'Team guest',
      owner: { kind: 'team', teamId: 'team' },
      launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      controller: { machineId: 'controller', installationId: 'installation' }, controllerDisplayName: 'Company builder' };
    expect(protocol.ManagedMachinePresetCreateInputV1Schema.parse(create)).toEqual(create);
    expect(protocol.ManagedMachinePresetV1ReadSchema.parse({ ...create, revision: 0 }))
      .toMatchObject({ controllerDisplayName: create.controllerDisplayName, launch: create.launch });
    expect(protocol.ManagedMachinePresetUpdateInputV1Schema.parse({ homeId: 'home', id: create.id,
      expectedRevision: 0, patch: { controllerDisplayName: 'Renamed builder' } }))
      .toMatchObject({ patch: { controllerDisplayName: 'Renamed builder' } });
    expect(protocol.ManagedMachinePresetUpdateInputV1Schema.parse({ homeId: 'home', id: create.id,
      expectedRevision: 0, patch: { controllerDisplayName: null } })).toMatchObject({ patch: { controllerDisplayName: null } });
    const { controllerDisplayName: _label, ...old } = create;
    expect(protocol.ManagedMachinePresetV1ReadSchema.parse({ ...old, revision: 0 })).not.toHaveProperty('controllerDisplayName');
  });
  it('normalizes a retained singular script through the complete preset stored reader', () => {
    const body = '\r\necho retained\r\n';
    const check = { executable: 'fixture-check', args: [], unsatisfiedExitCodes: [1], requiredFacts: [] };
    const setup = { setupScript: body, setupScriptAffects: 'none', setupScriptCheck: check,
      toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' },
      secretRefs: { v: 1, bindings: { API_TOKEN: { ref: 'setup-token' } } } };
    const stored = { id: 'retained-script', homeId: 'home', revision: 4, name: 'Retained',
      owner: { kind: 'account', accountId: 'owner' },
      launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      controller: { machineId: 'controller', installationId: 'installation' }, setup };
    const { setupScript: _body, setupScriptAffects: _affects, setupScriptCheck: _check, ...rest } = setup;
    const canonical = { ...stored, setup: { ...rest, scripts: [{ body, affects: 'none', check }] } };
    expect(protocol.ManagedMachinePresetV1ReadSchema.parse(stored)).toEqual(canonical);
    expect(protocol.ManagedMachinePresetV1Schema.parse(canonical)).toEqual(canonical);
    expect(protocol.ManagedMachinePresetV1Schema.safeParse(stored).success).toBe(false);
    expect(protocol.ManagedMachinePresetV1ReadSchema.safeParse({ ...stored, setup: { setupScript: null } }).success).toBe(false);
  });
  it('recognizes portable creation from its launch while setup-only drafts have no creation', () => {
    const hasCreation = protocol.hasManagedMachinePresetCreationV1;
    const launch = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
    const controller = { machineId: 'controller', installationId: 'installation' };
    expect(hasCreation({ launch, controller })).toBe(true);
    expect(hasCreation({ launch })).toBe(true);
    expect(hasCreation({ launch, controller, setup: { scripts: [{ body: 'echo retained' }] } })).toBe(true);
    const absent: Array<Partial<{ launch: protocol.ManagedMachinePresetCreationV1['launch'] | null;
      controller: protocol.ManagedMachinePresetCreationV1['controller'] | null; setup: { scripts: { body: string }[] } }> | null | undefined> = [
      { setup: { scripts: [{ body: 'echo retained' }] } }, { controller },
      { launch: null, controller }, { launch, controller: null }, {}, null, undefined,
    ];
    for (const draft of absent) {
      expect(hasCreation(draft)).toBe(false);
    }
    const draft: { name: string; launch?: typeof launch & { choices: { cores: number } }; controller?: typeof controller } = {
      name: 'Draft', launch: { ...launch, choices: { cores: 2 } }, controller,
    };
    if (!hasCreation(draft)) throw new Error('complete_creation_not_recognized');
    expect(draft.launch.choices.cores).toBe(2);
    expect(draft.controller?.installationId).toBe('installation');
    expect(draft.name).toBe('Draft');
  });
  it('reads a credential-free delegated preset projection but never accepts it as a mutation', () => {
    const descriptor = { id: 'vm', title: 'VM', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
      launchSchema: { type: 'object', properties: {}, additionalProperties: false },
      resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
      billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
      actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } as const;
    const launch = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
    const controller = { machineId: 'controller', installationId: 'installation' };
    const preset = { id: 'delegated', homeId: 'home', revision: 1, name: 'Team guest', owner: { kind: 'team', teamId: 'team' },
      launch, controller, teamAcquireDelegated: true };
    const delegatedAcquire = { kind: 'ready', controller: { custodian: { accountId: 'company' },
      installationPublicKey: encodeBase64(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey, 'base64url') },
      provisioner: descriptor, reviewedFacts: buildManagedConfigurationFactsV1({ choicesSchema: z.strictObject({}), launch, controller,
        billing: descriptor.billing, retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, prerequisites: [],
        optionStatus: 'current', preset: { id: preset.id, revision: preset.revision, name: preset.name } }) };
    expect(protocol.ManagedMachinePresetGetResultV1Schema.parse({ kind: 'found', preset: { ...preset, delegatedAcquire } }))
      .toMatchObject({ preset: { delegatedAcquire } });
    const { revision: _revision, ...create } = preset;
    expect(protocol.ManagedMachinePresetCreateInputV1Schema.safeParse({ ...create, delegatedAcquire }).success).toBe(false);
    const credentials = [{ purpose: { consumer: launch.provider, purpose: 'native' },
      account: { service: { pluginId: 'custom.compute', localId: 'native' }, accountId: 'company-secret' } }];
    expect(protocol.ManagedMachinePresetV1Schema.safeParse({ ...preset, delegatedAcquire: { ...delegatedAcquire,
      reviewedFacts: { ...delegatedAcquire.reviewedFacts, launch: { ...launch, credentials } } } }).success).toBe(false);
    expect(protocol.ManagedMachinePresetV1Schema.parse({ ...preset, delegatedAcquire: { kind: 'unavailable', code: 'controller_unavailable' } }))
      .toMatchObject({ delegatedAcquire: { kind: 'unavailable', code: 'controller_unavailable' } });
  });
  it('keeps Team acquire delegation explicit across preset reads and revisioned mutations', () => {
    const preset = { id: 'delegated-preset', homeId: 'home', revision: 2, name: 'Team guest',
      owner: { kind: 'team', teamId: 'team' },
      launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      controller: { machineId: 'controller', installationId: 'installation' } };
    expect(protocol.ManagedMachinePresetV1Schema.parse(preset)).not.toHaveProperty('teamAcquireDelegated');
    const { revision: _revision, ...create } = preset;
    for (const teamAcquireDelegated of [false, true]) {
      expect(protocol.ManagedMachinePresetV1Schema.parse({ ...preset, teamAcquireDelegated }))
        .toMatchObject({ teamAcquireDelegated });
      expect(MachinePresetActionInputSchemasV1['machines.presets.create'].parse({ ...create, teamAcquireDelegated }))
        .toMatchObject({ teamAcquireDelegated });
      expect(MachinePresetActionInputSchemasV1['machines.presets.update'].parse({ homeId: preset.homeId, id: preset.id,
        expectedRevision: preset.revision, patch: { teamAcquireDelegated } })).toMatchObject({ patch: { teamAcquireDelegated } });
    }
    expect(protocol.ManagedMachinePresetUpdateInputV1Schema.safeParse({ homeId: preset.homeId, id: preset.id,
      expectedRevision: preset.revision, patch: { teamAcquireDelegated: 'true' } }).success).toBe(false);
  });
  it('admits portable Account creation and setup-only presets while delegated creation retains its controller', () => {
    const setupOnly = { id: 'setup-only', homeId: 'home', revision: 0, name: 'Bot tools',
      owner: { kind: 'account', accountId: 'owner' }, setup: { scripts: [{ body: 'echo tools' }] } };
    expect(protocol.ManagedMachinePresetV1Schema.parse(setupOnly)).toEqual(setupOnly);
    const { revision: _revision, ...input } = setupOnly;
    expect(protocol.ManagedMachinePresetCreateInputV1Schema.parse(input)).toEqual(input);
    const creation = {
      launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      controller: { machineId: 'controller', installationId: 'installation' },
    };
    expect(protocol.ManagedMachinePresetV1Schema.parse({ ...setupOnly, ...creation })).toEqual({ ...setupOnly, ...creation });
    const { setup: _setup, ...empty } = setupOnly;
    expect(protocol.ManagedMachinePresetV1Schema.safeParse(empty).success).toBe(false);
    expect(protocol.ManagedMachinePresetV1Schema.parse({ ...empty, launch: creation.launch })).toEqual({ ...empty, launch: creation.launch });
    const { revision: _portableRevision, ...portableCreate } = { ...empty, launch: creation.launch };
    expect(protocol.ManagedMachinePresetCreateInputV1Schema.parse(portableCreate)).toEqual(portableCreate);
    expect(protocol.ManagedMachinePresetV1Schema.safeParse({ ...empty, launch: creation.launch, teamAcquireDelegated: true }).success).toBe(false);
    expect(protocol.ManagedMachinePresetV1Schema.safeParse({ ...setupOnly, controller: creation.controller }).success).toBe(false);
    expect(protocol.ManagedMachinePresetV1Schema.safeParse({ ...empty, launch: creation.launch,
      controller: { machineId: creation.controller.machineId } }).success).toBe(false);
    expect(protocol.ManagedMachinePresetV1Schema.safeParse({ ...setupOnly, launch: null, controller: null }).success).toBe(false);
    expect(protocol.ManagedMachinePresetUpdateInputV1Schema.parse({ homeId: 'home', id: input.id, expectedRevision: 0,
      patch: { launch: null, controller: null } })).toMatchObject({ patch: { launch: null, controller: null } });
  });

  it('rejects deadline preset writes while preserving reusable policies and reviewed one-off/live deadlines', () => {
    const deadline = { kind: 'deadline', at: 4_000, effect: 'delete' } as const;
    const preset = { id: 'policy-preset', homeId: 'home', name: 'Guest', owner: { kind: 'account', accountId: 'owner' },
      launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      controller: { machineId: 'controller', installationId: 'installation' }, wakeOnAcceptedMessage: true };
    const create = MachinePresetActionInputSchemasV1['machines.presets.create'];
    const update = MachinePresetActionInputSchemasV1['machines.presets.update'];
    expect(create.safeParse({ ...preset, retention: deadline }).success).toBe(false);
    expect(update.safeParse({ homeId: 'home', id: preset.id, expectedRevision: 2,
      patch: { retention: deadline, wakeOnAcceptedMessage: false } }).success).toBe(false);
    for (const retention of [{ kind: 'until-delete' }, { kind: 'unused', afterMs: 3_600_000, effect: 'stop' }] as const) {
      expect(create.parse({ ...preset, retention })).toEqual({ ...preset, retention });
      expect(update.parse({ homeId: 'home', id: preset.id, expectedRevision: 2,
        patch: { retention, wakeOnAcceptedMessage: false } })).toMatchObject({ patch: { retention, wakeOnAcceptedMessage: false } });
    }
    expect(create.parse(preset)).not.toHaveProperty('retention');
    expect(update.parse({ homeId: 'home', id: preset.id, expectedRevision: 2,
      patch: { retention: null, wakeOnAcceptedMessage: null } })).toMatchObject({ patch: { retention: null, wakeOnAcceptedMessage: null } });
    const oneOff = { enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
      role: 'server', adminAccessAtCreation: 'preauthorized' }, selection: { kind: 'one-off', homeId: 'home', controller: preset.controller,
      launch: preset.launch, retention: deadline, wakeOnAcceptedMessage: false } };
    expect(ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse(oneOff)).toEqual(oneOff);
    const live = { homeId: 'home', managedId: 'managed', expectedIntentRevision: 2,
      retention: deadline, wakeOnAcceptedMessage: false };
    expect(ManagedMachineActionInputSchemasV1['machines.managed.retention.update'].parse(live)).toEqual(live);
  });
  it('keeps revisioned environment references canonical on mutation and tolerantly reads stored additions', () => {
    const schema = protocol.createManagedMachinePresetV1Schema(z.strictObject({ cores: z.number().check(z.int(), z.positive()) }));
    const setup = { toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' }, scripts: [{ body: 'echo setup' }],
      secretRefs: { v: 1, bindings: { API_TOKEN: { ref: 'setup-token' } } } };
    const preset = { id: 'environment-preset', homeId: 'home', revision: 2, name: 'Tools', owner: { kind: 'account', accountId: 'owner' },
      launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: { cores: 2 } },
      controller: { machineId: 'controller', installationId: 'installation' }, setup };
    expect(schema.parse(preset)).toEqual(preset);
    const stored = { ...preset, setup: { ...setup, future: true,
      toolchain: { ...setup.toolchain, future: true }, secretRefs: { ...setup.secretRefs, future: true,
        bindings: { API_TOKEN: { ...setup.secretRefs.bindings.API_TOKEN, future: true } } } } };
    expect(schema.safeParse(stored).success).toBe(false);
    expect(createStoredReadSchema(schema).parse(stored)).toEqual(preset);
    expect(schema.safeParse({ ...preset, setup: { secretRefs: { v: 1, bindings: { API_TOKEN: { value: 'raw-secret' } } } } }).success).toBe(false);
    expect(protocol.ManagedMachinePresetUpdateInputV1Schema.parse({ homeId: 'home', id: preset.id, expectedRevision: 2,
      patch: { setup: null } })).toMatchObject({ patch: { setup: null } });
  });
  it('validates contributed choices once and drops stored extras without relaxing mutation admission', () => {
    // The contribution supplies its launch schema; all surrounding host admission stays real.
    const schema = protocol.createManagedMachinePresetV1Schema(z.strictObject({ cores: z.number().check(z.int(), z.positive()) }));
    const preset = {
      id: 'preset-a', homeId: 'home-a', revision: 1, name: 'My VM',
      owner: { kind: 'account', accountId: 'owner' },
      launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
        name: 'guest', choices: { cores: 2 } },
      controller: { machineId: 'host-a', installationId: 'installation-a' },
    };
    expect(schema.parse(preset)).toEqual(preset);
    const stored = { ...preset, extra: true, launch: { ...preset.launch, extra: true,
      choices: { cores: 2, future: true } }, owner: { ...preset.owner, extra: true } };
    expect(schema.safeParse(stored).success).toBe(false);
    expect(createStoredReadSchema(schema).parse(stored)).toEqual(preset);
    expect(schema.safeParse({ ...preset, launch: { ...preset.launch, choices: { cores: 0 } } }).success).toBe(false);
    expect(schema.safeParse({ ...preset, owner: { kind: 'group', teamId: 'team', groupId: 'group' } }).success).toBe(false);
    expect(schema.safeParse({ ...preset, owner: { kind: 'team', teamId: 'team' } }).success).toBe(true);
    expect(schema.safeParse({ ...preset, controller: { poolId: 'pool-a' } }).success).toBe(false);
    expect(schema.safeParse({ ...preset, simultaneousLimit: { maximum: 0 } }).success).toBe(false);
    expect(schema.parse({ ...preset, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }))
      .toMatchObject({ retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    // Absence remains inheritance, rather than a stored false or a copied category default.
    expect(schema.parse(preset)).not.toHaveProperty('wakeOnAcceptedMessage');
    expect(schema.parse(preset)).not.toHaveProperty('retention');
  });
});
