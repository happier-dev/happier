import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as protocol from './managedConfigurationV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { resolveMachineRetentionPolicyV1 } from './resolveMachineRetentionPolicyV1.js';
import { ManagedAcquireInputV1Schema, ManagedErrorV1Schema, resolveManagedAcquireReviewV1 } from './actionsV1.js';
import { MachineProvisionerOptionsResultV1Schema } from '../../plugins/contributions/machineProvisioners.js';

describe('managed preset executable selection', () => {
  it('retains typed preset admission refusals at the managed controller transport', () => {
    for (const code of ['preset_not_found', 'preset_archived', 'preset_limit_reached']) {
      expect(ManagedErrorV1Schema.parse({ code })).toEqual({ code });
    }
  });
  it('admits only the reviewed Home-qualified preset revision, never caller-supplied recipe or authority', () => {
    const schema: unknown = Reflect.get(protocol, 'ManagedPresetSelectionV1Schema');
    expect(schema).toBeInstanceOf(z.ZodType);
    if (!(schema instanceof z.ZodType)) throw new Error('The preset selection validator is missing');

    const selection = { kind: 'preset', homeId: 'home-a', id: 'preset-a', revision: 3 };
    expect(schema.parse(selection)).toEqual(selection);
    for (const extra of [
      { launch: { forged: true } },
      { credentialRef: { id: 'foreign' } },
      { controller: { kind: 'pool', poolId: 'pool-a' } },
      { custodianAccountId: 'foreign' },
      { price: { amount: '0' } },
      { optionStatus: 'current' },
    ]) {
      expect(schema.safeParse({ ...selection, ...extra }).success).toBe(false);
    }
    const { revision: _revision, ...unreviewed } = selection;
    expect(schema.safeParse(unreviewed).success).toBe(false);
    expect(schema.safeParse({ ...selection, revision: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...selection, homeId: '' }).success).toBe(false);
  });
});

describe('reviewed managed configuration facts', () => {
  const choices = z.object({ cores: z.number().int().positive() }).strict();
  const launch = { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
    name: 'guest', choices: { cores: 2 } };
  const controller = { machineId: 'host-a', installationId: 'installation-a' };

  it('preserves a declared native duration in the same labelled option and immutable fact seam', () => {
    const duration = { id: 'lease-two-hours', title: '2 hours', afterMs: 7_200_000 };
    const options = MachineProvisionerOptionsResultV1Schema.parse({ choices: [{ id: 'lease', title: 'Lease', launch: { cores: 2 }, nativeFacts: { duration } }] });
    const facts = protocol.buildManagedConfigurationFactsV1({ choicesSchema: choices, launch, controller,
      optionStatus: 'current', prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'unknown' },
      retentionCapabilities: { supportedIntents: ['delete'], finiteOnly: true }, nativeFacts: options.choices[0]!.nativeFacts });
    expect(facts.nativeFacts).toMatchObject({ duration });
    expect(protocol.ManagedConfigurationFactsV1ReadSchema.parse({ ...facts, nativeFacts: { duration: { ...duration, future: true } } }).nativeFacts)
      .toEqual({ duration });
  });

  it('retains native monthly provenance beside the hourly price in current and stored receipts', () => {
    const price = { amount: '0.005', currency: 'EUR', unit: 'hour', source: 'native', observedAt: 10 };
    const monthlyPrice = { amount: '3.75', currency: 'EUR', unit: 'month', source: 'native', observedAt: 20 };
    const build: unknown = Reflect.get(protocol, 'buildManagedConfigurationFactsV1');
    if (typeof build !== 'function') throw new Error('Missing canonical builder');
    const facts = build({ choicesSchema: choices, launch, controller, optionStatus: 'current', prerequisites: [],
      billing: { location: 'cloud', stoppedBilling: 'billed' }, retentionCapabilities: { supportedIntents: ['delete'] }, prices: [price, monthlyPrice] });
    expect(facts).toMatchObject({ prices: [price, monthlyPrice] });
    expect(protocol.ManagedConfigurationFactsV1ReadSchema.parse({ ...facts, prices: [price, { ...monthlyPrice, future: true }] }))
      .toMatchObject({ prices: [price, monthlyPrice] });
  });

  it('snapshots every labelled native price line through current and tolerant stored receipts', () => {
    const prices = [
      { amount: '0.005', currency: 'EUR', unit: 'hour', source: 'native-compute', observedAt: 10,
        label: { key: 'price.compute', fallback: 'Compute' } },
      { amount: '0.0008', currency: 'EUR', unit: 'hour', source: 'native-network', observedAt: 20, label: 'Primary IPv4' },
      { amount: '0.50', currency: 'EUR', unit: 'month', source: 'native-network', observedAt: 20, label: 'Primary IPv4' },
    ];
    const build: unknown = Reflect.get(protocol, 'buildManagedConfigurationFactsV1');
    if (typeof build !== 'function') throw new Error('Missing canonical builder');
    const facts = build({ choicesSchema: choices, launch, controller, optionStatus: 'current', prerequisites: [],
      billing: { location: 'cloud', stoppedBilling: 'billed' }, retentionCapabilities: { supportedIntents: ['delete'] }, prices });
    expect(facts).toMatchObject({ prices });
    expect(protocol.ManagedConfigurationFactsV1ReadSchema.parse({ ...facts,
      prices: prices.map(price => ({ ...price, future: true })) })).toMatchObject({ prices });
    prices[1]!.label = 'Changed later';
    expect(facts.prices[1].label).toBe('Primary IPv4');
  });

  it('preserves a native no-cap fact separately from the provider monthly rate through options and reviewed receipts', () => {
    const price = { amount: '12', currency: 'USD', unit: 'month', source: 'native-api', observedAt: 10 };
    const options = MachineProvisionerOptionsResultV1Schema.parse({ choices: [{ id: 'native-size', title: 'Native size',
      prices: [price], nativeFacts: { monthlyCapStatus: 'none' } }] });
    const selected = options.choices[0]!;
    const facts = protocol.buildManagedConfigurationFactsV1({ choicesSchema: choices, launch, controller,
      optionStatus: 'current', prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' },
      retentionCapabilities: { supportedIntents: ['delete'] }, prices: selected.prices, nativeFacts: selected.nativeFacts });
    expect(facts).toMatchObject({ prices: [price], nativeFacts: { monthlyCapStatus: 'none' } });
    expect(protocol.ManagedConfigurationFactsV1ReadSchema.parse({ ...facts,
      nativeFacts: { monthlyCapStatus: 'unknown', future: true } }).nativeFacts)
      .toEqual({ monthlyCapStatus: 'unknown' });
    expect(MachineProvisionerOptionsResultV1Schema.parse({ choices: [{ id: 'unmeasured', title: 'Unmeasured', prices: [price] }] })
      .choices[0]?.nativeFacts).toBeUndefined();
    expect(MachineProvisionerOptionsResultV1Schema.safeParse({ choices: [{ id: 'invalid', title: 'Invalid',
      nativeFacts: { monthlyCapStatus: 'inferred-from-rate' } }] }).success).toBe(false);
  });

  it('snapshots the reviewed native dimensions without changing the executable launch', () => {
    const nativeFacts = { size: { id: 'small', title: 'Small', cpuCores: 2 },
      image: { id: 'linux', title: 'Linux' }, location: { id: 'region', title: 'Region' } };
    const build: unknown = Reflect.get(protocol, 'buildManagedConfigurationFactsV1');
    if (typeof build !== 'function') throw new Error('The reviewed fact projection is missing');
    const facts = build({ choicesSchema: choices, launch, controller, optionStatus: 'current', prerequisites: [],
      billing: { location: 'cloud', stoppedBilling: 'billed' }, retentionCapabilities: { supportedIntents: ['delete'] }, nativeFacts });
    expect(facts).toMatchObject({ launch, nativeFacts });
    const stored = { ...facts, nativeFacts: { ...nativeFacts, size: { ...nativeFacts.size, future: true }, future: true } };
    expect(protocol.ManagedConfigurationFactsV1ReadSchema.parse(stored)).toMatchObject({ nativeFacts });
    expect(protocol.ManagedConfigurationFactsV1ReadSchema.parse(stored).nativeFacts?.size).not.toHaveProperty('future');
    expect(protocol.ManagedConfigurationFactsV1Schema.safeParse({ ...facts, nativeFacts: { size: { id: 'small', title: 'Small', cpuCores: '2' } } }).success).toBe(false);
    nativeFacts.size.title = 'Changed after review';
    expect(facts.nativeFacts?.size?.title).toBe('Small');
  });

  it('keeps price unknown and preserves stopped billing and native expiry in a tolerant stored receipt', () => {
    const factory: unknown = Reflect.get(protocol, 'createManagedConfigurationFactsV1Schema');
    expect(factory).toBeTypeOf('function');
    if (typeof factory !== 'function') throw new Error('The configuration fact validator is missing');
    const schema = factory(choices);
    const facts = { launch, optionStatus: 'current', controller, prerequisites: [],
      billing: { location: 'cloud', stoppedBilling: 'billed' },
      retentionCapabilities: { supportedIntents: ['delete'], nativeExpiry: { kind: 'deadline', at: 9000 } },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    expect(schema.parse(facts)).toEqual(facts);
    expect(schema.parse(facts)).not.toHaveProperty('prices');
    const stored = { ...facts, future: true, launch: { ...launch, choices: { cores: 2, future: true } },
      billing: { ...facts.billing, future: true } };
    expect(schema.safeParse(stored).success).toBe(false);
    expect(createStoredReadSchema(schema).parse(stored)).toEqual(facts);
    const measured = { ...facts, localResources: { observedAt: 5000, availableCpuCores: 0 },
      prerequisites: [{ requirement: { kind: 'managedDependency', id: 'lima-cli' },
        status: 'unavailable', reason: 'missing executable' }] };
    expect(schema.parse(measured)).toEqual(measured);
    expect(schema.parse(measured).localResources).not.toHaveProperty('availableMemoryBytes');
    expect(schema.safeParse({ ...measured, localResources: { observedAt: 5000, availableMemoryBytes: -1 } }).success).toBe(false);
    expect(schema.safeParse({ ...facts, prices: [{ amount: '0', currency: 'USD', unit: 'hour' }] }).success).toBe(false);
    expect(schema.safeParse({ ...facts, prices: [{ amount: 'free', currency: 'USD', unit: 'hour', source: 'provider', observedAt: 0 }] }).success).toBe(false);
    expect(schema.parse({ ...facts, prices: [{ amount: '0.001', currency: 'USD', unit: 'hour', source: 'provider', observedAt: 0 }] }).prices[0].amount).toBe('0.001');
    expect(schema.parse({ ...facts, prices: [{ amount: '-0.001', currency: 'USD', unit: 'hour', source: 'provider', observedAt: 0 }] }).prices[0].amount).toBe('-0.001');
  });

  it('admits only selected effect fields with the exact installation and contributed choice schema', () => {
    const factory: unknown = Reflect.get(protocol, 'createManagedCreationSelectionV1Schema');
    expect(factory).toBeTypeOf('function');
    if (typeof factory !== 'function') throw new Error('The creation selection validator is missing');
    const schema = factory(choices);
    const selection = { kind: 'one-off', homeId: 'home-a', launch, controller,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    expect(schema.parse(selection)).toEqual(selection);
    for (const extra of [{ price: { amount: '0' } }, { optionStatus: 'current' },
      { credentialRef: 'foreign' }, { schemaVersion: 999 }, { prerequisites: [] }]) {
      expect(schema.safeParse({ ...selection, ...extra }).success).toBe(false);
    }
    expect(schema.safeParse({ ...selection, controller: { poolId: 'pool-a' } }).success).toBe(false);
    expect(schema.safeParse({ ...selection, launch: { ...launch, choices: { cores: 2, foreign: true } } }).success).toBe(false);
    const request = ManagedAcquireInputV1Schema.parse({ selection });
    expect(resolveManagedAcquireReviewV1(request)).toMatchObject({ homeId: selection.homeId,
      controller, retention: selection.retention, wakeOnAcceptedMessage: false });
    expect(ManagedAcquireInputV1Schema.safeParse({ selection, controller }).success).toBe(false);
    const preset = { selection: { kind: 'preset', homeId: 'home-a', id: 'preset', revision: 4 },
      controller, retention: selection.retention, wakeOnAcceptedMessage: false };
    expect(ManagedAcquireInputV1Schema.safeParse(preset).success).toBe(true);
    expect(ManagedAcquireInputV1Schema.safeParse({ selection: preset.selection }).success).toBe(false);
  });

  it('resolves the receipt through the category owner without fabricating price or unmeasured headroom', () => {
    const build: unknown = Reflect.get(protocol, 'buildManagedConfigurationFactsV1');
    expect(build).toBeTypeOf('function');
    if (typeof build !== 'function') throw new Error('The reviewed fact projection is missing');
    const billing = { location: 'cloud', stoppedBilling: 'not-billed' } as const;
    const retentionCapabilities = { supportedIntents: ['start', 'stop', 'delete'] as const };
    const preset = { id: 'preset', revision: 4, name: 'VM', wakeOnAcceptedMessage: false };
    const facts = build({ choicesSchema: choices, launch, controller, optionStatus: 'current',
      prerequisites: [], billing, retentionCapabilities, preset });
    const policy = resolveMachineRetentionPolicyV1({ billing, presetOverride: preset,
      nativeCapabilities: { supportedIntents: [...retentionCapabilities.supportedIntents] } });
    expect(facts).toMatchObject({ retention: policy.retention, wakeOnAcceptedMessage: false,
      preset: { id: 'preset', revision: 4, name: 'VM' } });
    expect(facts).not.toHaveProperty('prices');
    expect(facts).not.toHaveProperty('localResources');
    expect(facts.preset).not.toHaveProperty('wakeOnAcceptedMessage');
  });
});
