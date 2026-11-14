import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import * as protocol from './managedMachinePresetV1.js';
import * as rootProtocol from '../../index.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { MachinePresetActionInputSchemasV1 } from './machinePresetActionsV1.js';
import { buildManagedConfigurationFactsV1 } from './managedConfigurationV1.js';
import { ManagedMachineActionInputSchemasV1 } from './actionsV1.js';
import { encodeBase64 } from '../../crypto/base64.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { createManagedMachinePresetContentV1Schema } from './managedMachinePresetContentV1.js';

const launch = {
  provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1,
  name: 'Guest', choices: {},
} as const;
const setup = { scripts: [{ body: 'echo setup', affects: 'none' as const }] } as const;

function plainContent(name = 'Team guest', overrides: Readonly<Record<string, unknown>> = {}) {
  return { t: 'plain' as const, v: { v: 1 as const, name, launch, ...overrides } };
}

function preset(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: 'preset', homeId: 'home', revision: 1,
    owner: { kind: 'account' as const, accountId: 'owner' },
    contentEncryptionMode: 'plain' as const, content: plainContent(), recipients: [], ...overrides,
  };
}

describe('managed preset content and structural contracts', () => {
  it('keeps preset search client-local and rejects it at the list wire', () => {
    const input = { homeId: 'home', includeArchived: false, cursor: 'cursor' };
    expect(protocol.ManagedMachinePresetListInputV1Schema.parse(input)).toEqual(input);
    expect(protocol.ManagedMachinePresetListInputV1Schema.safeParse({ ...input, search: 'guest' }).success).toBe(false);
    expect(MachinePresetActionInputSchemasV1['machines.presets.list'].safeParse({ ...input, search: 'guest' }).success).toBe(false);
  });

  it('keeps private values in the mode-tagged content and Account envelopes', () => {
    const value = preset({ owner: { kind: 'team', teamId: 'team' },
      controller: { machineId: 'controller', installationId: 'installation' },
      teamAcquireDelegated: true, content: plainContent('Team guest', { controllerDisplayName: 'Company builder' }) });
    expect(protocol.ManagedMachinePresetV1Schema.parse(value)).toEqual(value);
    for (const legacy of ['name', 'launch', 'setup', 'controllerDisplayName']) {
      expect(protocol.ManagedMachinePresetV1Schema.safeParse({ ...value, [legacy]: 'legacy' }).success).toBe(false);
    }
    const { revision: _revision, ...create } = value;
    expect(protocol.ManagedMachinePresetCreateInputV1Schema.parse(create)).toEqual(create);
    expect(protocol.ManagedMachinePresetUpdateInputV1Schema.parse({ homeId: value.homeId, id: value.id,
      expectedRevision: value.revision, patch: { contentEncryptionMode: 'plain', content: value.content, recipients: [] } }))
      .toMatchObject({ patch: { contentEncryptionMode: 'plain', content: value.content, recipients: [] } });
  });

  it('preserves structural controller and pool targets without manufacturing either one', () => {
    const value = preset({ controllerPoolId: 'c1d23348-62b4-4584-aeb2-3c8e312acc8c',
      owner: { kind: 'team', teamId: 'team' }, teamAcquireDelegated: true });
    expect(protocol.ManagedMachinePresetV1ReadSchema.parse(value)).toMatchObject({ controllerPoolId: value.controllerPoolId });
    expect(protocol.ManagedMachinePresetV1Schema.safeParse({ ...value,
      controller: { machineId: 'controller', installationId: 'installation' } }).success).toBe(false);
    expect(protocol.ManagedMachinePresetUpdateInputV1Schema.parse({ homeId: value.homeId, id: value.id,
      expectedRevision: value.revision, patch: { controller: null, controllerPoolId: value.controllerPoolId } }))
      .toMatchObject({ patch: { controllerPoolId: value.controllerPoolId } });
  });

  it('normalizes retained singular setup scripts at the private content reader', () => {
    const body = '\r\necho retained\r\n';
    const check = { executable: 'fixture-check', args: [], unsatisfiedExitCodes: [1], requiredFacts: [] };
    const storedSetup = { setupScript: body, setupScriptAffects: 'none', setupScriptCheck: check,
      toolchain: { adapterId: 'mise', config: '[tools]\nnode = "22"' } };
    const stored = { v: 1, name: 'Retained', launch, setup: storedSetup };
    const canonical = { v: 1, name: 'Retained', launch,
      setup: { toolchain: storedSetup.toolchain, scripts: [{ body, affects: 'none', check }] } };
    const contentSchema = createManagedMachinePresetContentV1Schema(PluginJsonValueV2Schema);
    expect(createStoredReadSchema(contentSchema).parse(stored)).toEqual(canonical);
    expect(contentSchema.parse(canonical)).toEqual(canonical);
    expect(contentSchema.safeParse(stored).success).toBe(false);
  });

  it('treats private bodies as opaque while enforcing only mode tags and outer structural constraints', () => {
    const controller = { machineId: 'controller', installationId: 'installation' };
    const setupOnly = preset({ controller, content: plainContent('Setup only', { launch: undefined, setup }) });
    expect(protocol.ManagedMachinePresetV1Schema.parse(setupOnly)).toEqual(setupOnly);
    const encryptedContent = { t: 'encrypted' as const, c: encodeBase64(new Uint8Array(40)) };
    expect(protocol.ManagedMachinePresetV1Schema.safeParse(preset({ contentEncryptionMode: 'e2ee', content: encryptedContent, recipients: [] })).success).toBe(true);
    expect(protocol.ManagedMachinePresetV1Schema.safeParse(preset({ content: plainContent('Portable'),
      teamAcquireDelegated: true })).success).toBe(false);
    const opaquePlain = preset({ content: { t: 'plain', v: { privateBody: 'server must not inspect this' } }, recipients: [] });
    expect(protocol.ManagedMachinePresetV1Schema.parse(opaquePlain)).toEqual(opaquePlain);
  });

  it('refuses reviewed acquisition facts outside the private content envelope', () => {
    const descriptor = { id: 'vm', title: 'VM', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
      launchSchema: { type: 'object', properties: {}, additionalProperties: false },
      resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
      billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
      actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } } as const;
    const value = preset({ id: 'delegated', owner: { kind: 'team', teamId: 'team' },
      controller: { machineId: 'controller', installationId: 'installation' }, teamAcquireDelegated: true });
    const delegatedAcquire = { kind: 'ready' as const, provisioner: descriptor,
      reviewedFacts: buildManagedConfigurationFactsV1({ choicesSchema: z.strictObject({}), launch,
        controller: value.controller, billing: descriptor.billing, retentionCapabilities: descriptor.retention,
        prerequisites: [], optionStatus: 'current', preset: { id: value.id, revision: value.revision,
          name: 'Team guest', retention: { kind: 'until-delete' } } }) };
    expect(protocol.ManagedMachinePresetV1Schema.safeParse({ ...value, delegatedAcquire }).success).toBe(false);
    const { revision: _revision, ...create } = value;
    expect(protocol.ManagedMachinePresetCreateInputV1Schema.safeParse({ ...create, delegatedAcquire }).success).toBe(false);
  });

  it('keeps Team delegation, retention, wake, and limit as structural mutation fields', () => {
    const value = preset({ owner: { kind: 'team', teamId: 'team' },
      controller: { machineId: 'controller', installationId: 'installation' } });
    for (const teamAcquireDelegated of [false, true]) {
      const { revision: _revision, ...create } = { ...value, teamAcquireDelegated };
      expect(MachinePresetActionInputSchemasV1['machines.presets.create'].parse(create)).toMatchObject({ teamAcquireDelegated });
      expect(MachinePresetActionInputSchemasV1['machines.presets.update'].parse({ homeId: value.homeId, id: value.id,
        expectedRevision: value.revision, patch: { teamAcquireDelegated } })).toMatchObject({ patch: { teamAcquireDelegated } });
    }
    const deadline = { kind: 'deadline', at: 4_000, effect: 'delete' } as const;
    expect(MachinePresetActionInputSchemasV1['machines.presets.create'].safeParse({
      ...(() => { const { revision: _revision, ...create } = value; return create; })(), retention: deadline,
    }).success).toBe(false);
    expect(MachinePresetActionInputSchemasV1['machines.presets.update'].parse({ homeId: value.homeId, id: value.id,
      expectedRevision: value.revision, patch: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        simultaneousLimit: { maximum: 2 } } })).toMatchObject({ patch: { simultaneousLimit: { maximum: 2 } } });
    const oneOff = { enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
      role: 'server', adminAccessAtCreation: 'preauthorized' }, selection: { kind: 'one-off', homeId: 'home',
      controller: value.controller, launch, retention: deadline, wakeOnAcceptedMessage: false } };
    expect(ManagedMachineActionInputSchemasV1['machines.managed.acquire'].parse(oneOff)).toEqual(oneOff);
  });

  it('validates contributed launch choices at the private content owner and drops stored additions only at read', () => {
    const schema = createManagedMachinePresetContentV1Schema(z.strictObject({ cores: z.number().check(z.int(), z.positive()) }));
    const contributedLaunch = { ...launch, choices: { cores: 2 } };
    const value = { v: 1, name: 'My VM', launch: contributedLaunch };
    expect(schema.parse(value)).toEqual(value);
    const stored = { ...value, future: true,
      launch: { ...contributedLaunch, extra: true, choices: { cores: 2, future: true } } };
    expect(schema.safeParse(stored).success).toBe(false);
    expect(createStoredReadSchema(schema).parse(stored)).toEqual(value);
    expect(schema.safeParse({ ...value, launch: { ...contributedLaunch, choices: { cores: 0 } } }).success).toBe(false);
  });

  it('binds tagged private content to the persisted owner mode while exposing the unrefined base schema', () => {
    const encryptedContent = { t: 'encrypted' as const, c: encodeBase64(new Uint8Array(40).fill(7)) };
    const encrypted = preset({ contentEncryptionMode: 'e2ee', content: encryptedContent, recipients: [] });
    expect(protocol.ManagedMachinePresetV1Schema.parse(encrypted)).toEqual(encrypted);
    expect(protocol.ManagedMachinePresetV1Schema.safeParse({ ...encrypted, contentEncryptionMode: 'plain' }).success).toBe(false);
    expect(protocol.ManagedMachinePresetV1Schema.safeParse({ ...preset(), contentEncryptionMode: 'e2ee' }).success).toBe(false);

    const structurallyCompleteButSemanticallyInvalid = preset({
      controller: { machineId: 'controller', installationId: 'installation' },
      controllerPoolId: 'c1d23348-62b4-4584-aeb2-3c8e312acc8c',
    });
    expect(protocol.createManagedMachinePresetV1BaseSchema(PluginJsonValueV2Schema)
      .safeParse(structurallyCompleteButSemanticallyInvalid).success).toBe(true);
    expect(protocol.ManagedMachinePresetV1Schema.safeParse(structurallyCompleteButSemanticallyInvalid).success).toBe(false);
  });

  it('defines the server-owned recipient census request and ready/refused result contract', () => {
    const input = { homeId: 'home', owner: { kind: 'team' as const, teamId: 'team' },
      controller: { machineId: 'controller', installationId: 'installation' } };
    expect(protocol.ManagedMachinePresetRecipientCensusInputV1Schema.parse(input)).toEqual(input);
    expect(protocol.ManagedMachinePresetRecipientCensusInputV1Schema.parse({ ...input, presetId: 'existing-preset' }))
      .toEqual({ ...input, presetId: 'existing-preset' });
    expect(protocol.ManagedMachinePresetRecipientCensusResultV1Schema.parse({
      kind: 'ready', contentEncryptionMode: 'plain', recipients: [],
    })).toEqual({ kind: 'ready', contentEncryptionMode: 'plain', recipients: [] });
    expect(protocol.ManagedMachinePresetRecipientCensusResultV1Schema.parse({
      kind: 'refused', code: 'permission_denied',
    })).toEqual({ kind: 'refused', code: 'permission_denied' });
    expect(rootProtocol.ManagedMachinePresetRecipientCensusResultV1Schema)
      .toBe(protocol.ManagedMachinePresetRecipientCensusResultV1Schema);
  });
  it('exposes the Account-mode migration opaque inventory and snapshot fence', () => {
    const privatePlain = { t: 'plain' as const, v: { opaque: 'private preset body' } };
    const inventory = { presets: [{ presetId: 'preset-personal', expectedRevision: 4, contentEncryptionMode: 'plain' as const, content: privatePlain, recipientEnvelope: null }], snapshots: [{ managedId: 'managed-retained', presetId: 'preset-personal', contentEncryptionMode: 'plain' as const, content: privatePlain, recipientEnvelope: null }] };
    const directive = { presets: [{ presetId: 'preset-personal', expectedRevision: 4, replacement: { content: privatePlain, recipients: [] } }], snapshots: [{ managedId: 'managed-retained', presetId: 'preset-personal', expectedContentEncryptionMode: 'plain' as const, expectedContent: privatePlain, expectedRecipientEnvelope: null, replacement: { content: privatePlain, recipients: [] } }] };
    const inventorySchema = Reflect.get(protocol, 'ManagedMachinePresetAccountEncryptionMigrationInventoryV1Schema') as Readonly<{ parse(value: unknown): unknown }>;
    const directiveSchema = Reflect.get(protocol, 'AccountEncryptionMigrateManagedMachinePresetsDirectiveV1Schema') as Readonly<{ parse(value: unknown): unknown; safeParse(value: unknown): Readonly<{ success: boolean }> }>;
    expect(inventorySchema.parse(inventory)).toEqual(inventory);
    expect(directiveSchema.parse(directive)).toEqual(directive);
    expect(directiveSchema.safeParse({ ...directive, snapshots: [{ ...directive.snapshots[0], expectedContentEncryptionMode: 'e2ee' }] }).success).toBe(false);
    expect(rootProtocol.ManagedMachinePresetAccountEncryptionMigrationInventoryV1Schema).toBe(inventorySchema);
  });
});
