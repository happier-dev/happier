import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { describe, expect, it } from 'vitest';
import { ManagedOpaquePresetMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { hydrateManagedOpaquePresetMachineV1, prepareManagedOpaquePresetAcquireV1,
  prepareManagedOpaquePresetReportV1, readManagedOpaquePresetNativeControlResultV1, type ManagedOpaquePresetContentOpenerV1 } from './presetAcquire.js';

describe('prepare managed opaque preset acquire', () => {
  const base = { t: 'plain' as const, v: { v: 1 as const, name: 'Private preset', launch: {
    provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1,
    name: 'Private saved name', choices: {} } } };
  const open: ManagedOpaquePresetContentOpenerV1 = async content => content.t === 'plain' ? content.v : null;

  it('opens a legacy Plain acquire without an override from its exact saved identity', async () => {
    const identity = { kind: 'guestProcess' as const, role: 'sandbox' as const };
    const input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    expect(input).not.toHaveProperty('presetContentOverride');
    const source = { ...base, v: { ...base.v, enrollmentIdentity: identity } };
    await expect(prepareManagedOpaquePresetAcquireV1({ content: source, provisioner: { id: 'vm', title: 'Virtual machine' }, open }))
      .resolves.toMatchObject({ opened: { enrollmentIdentity: identity, launch: { name: 'Virtual machine' } } });
  });

  it('uses the one async keyholding opener for a sealed own-name override', async () => {
    const provisioner = { id: 'vm', title: { key: 'compute.virtualMachine', fallback: 'Virtual machine' } };
    await expect(prepareManagedOpaquePresetAcquireV1({ content: base, provisioner, open }))
      .resolves.toMatchObject({ launchName: 'Virtual machine', opened: { launch: { name: 'Virtual machine' } } });
    const override = { content: { t: 'plain' as const, v: { ...base.v,
      launch: { ...base.v.launch, name: 'New Machine' } } } };
    await expect(prepareManagedOpaquePresetAcquireV1({ content: base, override,
      provisioner, open }))
      .resolves.toMatchObject({ launchName: 'New Machine', opened: { launch: { name: 'New Machine' } } });
  });

  it('accepts the one combined acquire override while retaining its private enrollment identity locally', async () => {
    const identity = { kind: 'dedicatedDaemonUser' as const, username: 'happier' as const, serviceMode: 'user' as const,
      role: 'deployTarget' as const, adminAccessAtCreation: 'ask' as const, administrator: { username: 'private-owner' } };
    const override = { content: { t: 'plain' as const, v: { ...base.v,
      launch: { ...base.v.launch, name: 'New Machine' }, enrollmentIdentity: identity } } };
    await expect(prepareManagedOpaquePresetAcquireV1({ content: base, override,
      provisioner: { id: 'vm', title: 'Virtual machine' }, open }))
      .resolves.toMatchObject({ launchName: 'New Machine', opened: { enrollmentIdentity: identity } });
  });

  it('refuses an override that changes sealed provider choices rather than only the name', async () => {
    const override = { content: { t: 'plain' as const, v: { ...base.v,
      launch: { ...base.v.launch, choices: { region: 'private-change' } } } } };
    await expect(prepareManagedOpaquePresetAcquireV1({ content: base, override,
      provisioner: { id: 'vm', title: 'Virtual machine' }, open })).resolves.toBeNull();
  });

  it('reseals a private provider report at the host boundary without creating a structural copy', () => {
    const machine = ManagedOpaquePresetMachineV1Schema.parse({ id: 'report-machine', homeId: 'home', custodianAccountId: 'account',
      preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, allocation: 'bound',
      creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const reviewedFacts = { launch: base.v.launch, optionStatus: 'current' as const,
      billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
      retentionCapabilities: { supportedIntents: ['start', 'delete'] }, prerequisites: [],
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } satisfies NonNullable<ManagedMachinePresetContentV1['reviewedFacts']>;
    const nativeResult = { kind: 'bound' as const, resource: { contributionRef: base.v.launch.provider,
      schemaVersion: 1, value: { namespace: 'private-namespace', transport: 'private-transport' } } };
    const prepared = prepareManagedOpaquePresetReportV1({ machine, content: base, recipients: [], accountId: 'account',
      randomBytes: length => new Uint8Array(length).fill(3), opened: { ...base.v, reviewedFacts }, nativeResult });

    expect(prepared).toMatchObject({ content: { t: 'plain', v: { nativeResult } }, opened: { reviewedFacts, nativeResult } });
  });

  it('retains a migrated no-review native identity and Delete outcome inside the sealed snapshot', () => {
    const machine = ManagedOpaquePresetMachineV1Schema.parse({ id: 'legacy-machine', homeId: 'home', custodianAccountId: 'account',
      preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, allocation: 'bound',
      creationState: 'active', desired: 'delete', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const nativeResult = { kind: 'bound' as const, resource: { contributionRef: base.v.launch.provider,
      schemaVersion: 1, value: { id: 'paid-native' } } };
    const nativeControlResult = { kind: 'delete' as const, result: { kind: 'confirmed' as const } };
    const prepared = prepareManagedOpaquePresetReportV1({ machine, content: base, recipients: [], accountId: 'account',
      opened: base.v, nativeResult, nativeControlResult, randomBytes: length => new Uint8Array(length).fill(4) });
    expect(prepared).toMatchObject({ opened: { nativeResult, nativeControlResult },
      content: { t: 'plain', v: { nativeResult, nativeControlResult } } });
    expect(prepared?.opened.reviewedFacts).toBeUndefined();
  });

  it.each([
    ['start', { kind: 'confirmed' }, { kind: 'power', intent: 'start', result: { kind: 'confirmed' } }],
    ['delete', { kind: 'confirmed' }, { kind: 'delete', result: { kind: 'confirmed' } }],
    ['rebuild', { kind: 'refused', code: 'provider_unavailable' },
      { kind: 'rebuild', result: { kind: 'refused', code: 'provider_unavailable' } }],
  ] as const)('classifies the private %s control result once before sealing it', (desired, value, expected) => {
    expect(readManagedOpaquePresetNativeControlResultV1({ desired }, value)).toEqual(expected);
  });

  it('refuses a malformed private control result rather than emitting a structural fallback', () => {
    expect(readManagedOpaquePresetNativeControlResultV1({ desired: 'delete' }, { kind: 'confirmed', resource: 'wrong-shape' }))
      .toBeNull();
  });

  it('hydrates an opaque row only from opened private content and fails closed for missing setup', () => {
    const machine = ManagedOpaquePresetMachineV1Schema.parse({ id: 'machine', homeId: 'home', custodianAccountId: 'account',
      preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, allocation: 'unsubmitted',
      creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
      machineSetup: { state: 'pending' } });
    const opened = { ...base.v, setup: { scripts: [{ body: 'private setup', affects: 'none' as const }] } };
    expect(hydrateManagedOpaquePresetMachineV1({ machine, opened })).toMatchObject({ launch: base.v.launch,
      machineSetup: { state: 'pending', setup: opened.setup } });
    expect(hydrateManagedOpaquePresetMachineV1({ machine, opened: base.v })).toBeNull();
  });

  it('restores sealed native identity and observation only for the keyholding local full view', () => {
    const machine = ManagedOpaquePresetMachineV1Schema.parse({ id: 'bound-machine', homeId: 'home', custodianAccountId: 'account',
      preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, allocation: 'bound',
      creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const opened = {
      ...base.v,
      nativeResult: { kind: 'bound' as const, resource: { contributionRef: base.v.launch.provider, schemaVersion: 1, value: {
        namespace: 'private-namespace', transport: 'private-transport', backendId: 'private-backend' } } },
      observation: { observedAt: 1, availability: 'present' as const, power: 'running' as const,
        size: { cpuCores: 4 } },
    } satisfies ManagedMachinePresetContentV1;

    expect(hydrateManagedOpaquePresetMachineV1({ machine, opened })).toMatchObject({
      resource: opened.nativeResult.resource,
      observation: opened.observation,
    });
  });

  it('prefers the latest sealed rebuild identity and observation over the initial acquisition snapshot', () => {
    const machine = ManagedOpaquePresetMachineV1Schema.parse({ id: 'rebuilt-machine', homeId: 'home', custodianAccountId: 'account',
      preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, allocation: 'bound',
      creationState: 'active', desired: 'rebuild', desiredWhen: 'now', intentRevision: 2,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const initialResource = { contributionRef: base.v.launch.provider, schemaVersion: 1,
      value: { namespace: 'initial-private-namespace', transport: 'initial-private-transport', backendId: 'initial-private-backend' } };
    const rebuiltResource = { contributionRef: base.v.launch.provider, schemaVersion: 1,
      value: { namespace: 'rebuilt-private-namespace', transport: 'rebuilt-private-transport', backendId: 'rebuilt-private-backend' } };
    const opened = {
      ...base.v,
      reviewedFacts: { launch: base.v.launch, optionStatus: 'current' as const,
        billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
        retentionCapabilities: { supportedIntents: ['start', 'rebuild', 'delete'] }, prerequisites: [],
        retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false },
      nativeResult: { kind: 'bound' as const, resource: initialResource },
      nativeControlResult: { kind: 'rebuild' as const, result: { kind: 'bound' as const, resource: rebuiltResource } },
      observation: { observedAt: 2, availability: 'present' as const, power: 'running' as const,
        size: { cpuCores: 8 } },
    } satisfies ManagedMachinePresetContentV1;

    expect(hydrateManagedOpaquePresetMachineV1({ machine, opened })).toMatchObject({
      resource: rebuiltResource,
      observation: opened.observation,
    });
  });

  it('retains the admitted bound resource while a sealed Delete remains accepted', () => {
    const machine = ManagedOpaquePresetMachineV1Schema.parse({ id: 'deleting-machine', homeId: 'home', custodianAccountId: 'account',
      preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, allocation: 'bound',
      creationState: 'active', desired: 'delete', desiredWhen: 'now', intentRevision: 2,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const resource = { contributionRef: base.v.launch.provider, schemaVersion: 1,
      value: { namespace: 'private-namespace', transport: 'private-transport' } };
    const nativeOperationRef = { contributionRef: base.v.launch.provider, schemaVersion: 1,
      value: { operationId: 'private-delete-operation' } };
    const opened = {
      ...base.v,
      reviewedFacts: { launch: base.v.launch, optionStatus: 'current' as const,
        billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
        retentionCapabilities: { supportedIntents: ['start', 'delete'] }, prerequisites: [],
        retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false },
      nativeResult: { kind: 'bound' as const, resource },
      nativeControlResult: { kind: 'delete' as const, result: { kind: 'accepted' as const, nativeOperationRef } },
    } satisfies ManagedMachinePresetContentV1;

    expect(hydrateManagedOpaquePresetMachineV1({ machine, opened })).toMatchObject({ resource, nativeOperationRef });
  });

  it('retains the rebuilt resource through a later accepted Delete continuation', () => {
    const rebuildMachine = ManagedOpaquePresetMachineV1Schema.parse({ id: 'rebuilt-then-deleted', homeId: 'home', custodianAccountId: 'account',
      preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' }, allocation: 'bound',
      creationState: 'active', desired: 'rebuild', desiredWhen: 'now', intentRevision: 2,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const deleteMachine = ManagedOpaquePresetMachineV1Schema.parse({ ...rebuildMachine, desired: 'delete', intentRevision: 3 });
    const reviewedFacts = { launch: base.v.launch, optionStatus: 'current' as const,
      billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
      retentionCapabilities: { supportedIntents: ['start', 'rebuild', 'delete'] }, prerequisites: [],
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } satisfies NonNullable<ManagedMachinePresetContentV1['reviewedFacts']>;
    const initialResource = { contributionRef: base.v.launch.provider, schemaVersion: 1,
      value: { namespace: 'initial-private-namespace', transport: 'initial-private-transport' } };
    const rebuiltResource = { contributionRef: base.v.launch.provider, schemaVersion: 1,
      value: { namespace: 'rebuilt-private-namespace', transport: 'rebuilt-private-transport' } };
    const nativeOperationRef = { contributionRef: base.v.launch.provider, schemaVersion: 1,
      value: { operationId: 'private-delete-operation' } };
    const beforeRebuild = { ...base.v, reviewedFacts,
      nativeResult: { kind: 'bound' as const, resource: initialResource } };
    const rebuilt = prepareManagedOpaquePresetReportV1({ machine: rebuildMachine, content: { t: 'plain' as const, v: beforeRebuild },
      recipients: [], accountId: 'account', randomBytes: length => new Uint8Array(length).fill(5), opened: beforeRebuild,
      nativeControlResult: { kind: 'rebuild', result: { kind: 'bound', resource: rebuiltResource } } });
    expect(rebuilt).not.toBeNull();
    if (!rebuilt?.opened.launch) throw new Error('Expected rebuilt opaque snapshot with its launch');

    const deleting = prepareManagedOpaquePresetReportV1({ machine: deleteMachine, content: rebuilt.content,
      recipients: [], accountId: 'account', randomBytes: length => new Uint8Array(length).fill(7), opened: { ...rebuilt.opened, launch: rebuilt.opened.launch },
      nativeControlResult: { kind: 'delete', result: { kind: 'accepted', nativeOperationRef } } });
    expect(deleting).not.toBeNull();
    if (!deleting) throw new Error('Expected deleting opaque snapshot');

    expect(hydrateManagedOpaquePresetMachineV1({ machine: deleteMachine, opened: deleting.opened }))
      .toMatchObject({ resource: rebuiltResource, nativeOperationRef });
  });
});
