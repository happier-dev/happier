import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import tweetnacl from 'tweetnacl';
import { signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from '../../actions/externalActionExecutionAuthorization.js';

import * as protocol from './managedConfigurationV1.js';
import { sealManagedMachinePresetContentV1, openManagedMachinePresetContentV1, createManagedMachinePresetAcquireOverrideV1, replaceManagedMachinePresetLaunchNameV1 } from './managedMachinePresetContentV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { resolveMachineRetentionPolicyV1 } from './resolveMachineRetentionPolicyV1.js';
import { ManagedAcquireInputV1Schema, ManagedAdmissionInputV1Schema, ManagedErrorV1Schema, resolveManagedAcquireReviewV1 } from './actionsV1.js';
import { ExternalActionManagedContinuationV1Schema } from '../../actions/externalActionApi.js';
import { MachineProvisionerContributionV1Schema, MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1, readMachineProvisionerSelectionForLaunchV1 } from '../../plugins/contributions/machineProvisioners.js';
import { createPluginJsonSchemaZodValueAdapter } from '../../plugins/actions/jsonSchemaValidation.js';

describe('managed preset executable selection', () => {
  it('binds computed native effects to acquisition facts without putting the digest in saved operands', () => {
    const choices = z.strictObject({ image: z.string() });
    const launch = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1,
      name: 'Guest', choices: { image: 'example:latest' } };
    const effectReview = { kind: 'devcontainer' as const, reviewedEffectDigest: 'a'.repeat(64), effects: [] };
    const facts = protocol.buildManagedConfigurationFactsV1({ choicesSchema: choices, launch,
      optionProjection: { kind: 'ready', launch: launch.choices, prices: [], nativeFacts: {}, effectReview },
      optionStatus: 'current', prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
      retentionCapabilities: { supportedIntents: ['delete'] } });
    expect(facts).toMatchObject({ launch, reviewedEffectDigest: effectReview.reviewedEffectDigest });
    expect(facts).not.toHaveProperty('effectReview');
    expect(facts.launch.choices).not.toHaveProperty('reviewedEffectDigest');
    const sealed = sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content: {
      v: 1, name: launch.name, launch,
    } });
    const projection = { content: sealed.content, recipientEnvelope: null };
    const override = createManagedMachinePresetAcquireOverrideV1({ presetId: 'preset', mode: 'plain', projection,
      enrollmentIdentity: { kind: 'existingUser', role: 'adopted' } });
    if (!override) throw new Error('Expected private acquisition identity');
    const request = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
      retention: facts.retention, wakeOnAcceptedMessage: facts.wakeOnAcceptedMessage, presetContentOverride: override });
    const captured = replaceManagedMachinePresetLaunchNameV1({ presetId: 'preset', mode: 'plain',
      content: override.content, launchName: launch.name, reviewedFacts: facts });
    if (!captured) throw new Error('Expected locally reviewed snapshot');
    const opened = openManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content: captured });
    expect(opened?.reviewedFacts).toMatchObject({ reviewedEffectDigest: effectReview.reviewedEffectDigest });
    expect(replaceManagedMachinePresetLaunchNameV1({ presetId: 'preset', mode: 'plain', content: captured,
      launchName: launch.name, reviewedFacts: { ...facts, reviewedEffectDigest: 'b'.repeat(64) } })).toBeNull();
    expect(request).not.toHaveProperty('reviewedFacts');
    expect(request).not.toHaveProperty('enrollmentIdentity');
    const key = tweetnacl.sign.keyPair();
    const approval = { authorizationToken: 'original-acquisition', actionId: 'machines.managed.acquire',
      target: { kind: 'machine' as const, machineId: 'controller' }, input: request };
    const signature = signExternalActionApprovalInputV1({ ...approval, privateKey: key.secretKey });
    expect(verifyExternalActionApprovalInputV1({ ...approval, signature, publicKey: key.publicKey })).toBe(true);
    const tampered = createManagedMachinePresetAcquireOverrideV1({ presetId: 'preset', mode: 'plain', projection,
      enrollmentIdentity: { kind: 'existingUser', role: 'personal' } });
    if (!tampered) throw new Error('Expected changed private acquisition identity');
    expect(verifyExternalActionApprovalInputV1({ ...approval, input: { ...request,
      presetContentOverride: tampered }, signature, publicKey: key.publicKey })).toBe(false);
  });
  it('captures native option facts for an already authored launch through the shared receipt builder', () => {
    const launchSchema = { type: 'object', properties: { cpu: { type: 'integer' }, image: { type: 'string' } },
      required: ['cpu', 'image'], additionalProperties: false } as const;
    const launch = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1,
      name: 'Guest', choices: { cpu: 4, image: 'ubuntu' } };
    const selectedBilling = { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [
      { amount: '0.08', currency: 'USD', unit: 'GB-month', source: 'https://native.example/pricing', observedAt: 1 },
    ] } as const;
    const options = MachineProvisionerOptionsResultV1Schema.parse({
      base: { launch: launch.choices, nativeFacts: { image: { id: 'ubuntu', title: 'Ubuntu Linux' } } },
      dimensions: { size: [{ id: 'four', title: 'Four cores', assignments: [],
        billing: selectedBilling, nativeFacts: { size: { id: 'four', title: 'Four cores', cpuCores: 4, memoryBytes: 4 * 2 ** 30 } } }],
        image: [], location: [], network: [], duration: [] },
    });
    const facts = protocol.buildManagedConfigurationFactsV1({ choicesSchema: createPluginJsonSchemaZodValueAdapter(launchSchema),
      launch, optionProjection: projectMachineProvisionerSelectionV1({ options, launchSchema,
        selection: readMachineProvisionerSelectionForLaunchV1(options, launch.choices) }), optionStatus: 'current', prerequisites: [],
      billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['delete'] },
      machineOverride: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
    expect(facts).toMatchObject({ launch, billing: selectedBilling, optionStatus: 'current', nativeFacts: {
      image: { title: 'Ubuntu Linux' }, size: { cpuCores: 4, memoryBytes: 4 * 2 ** 30 },
    } });
  });
  it('admits controller-free one-off and preset reviews without confusing their policy carriers', () => {
    const enrollmentIdentity = { kind: 'existingUser', role: 'adopted' } as const;
    const launch = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
    const policy = { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } as const;
    const oneOff = { selection: { kind: 'one-off', homeId: 'home', launch, ...policy }, enrollmentIdentity };
    const sealed = sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content: {
      v: 1, name: launch.name, launch,
    } });
    const override = createManagedMachinePresetAcquireOverrideV1({ presetId: 'preset', mode: 'plain',
      projection: { content: sealed.content, recipientEnvelope: null }, enrollmentIdentity });
    if (!override) throw new Error('Expected private acquisition identity');
    const preset = { selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 }, ...policy,
      presetContentOverride: override };
    for (const input of [oneOff, preset]) {
      const admitted = ManagedAcquireInputV1Schema.parse(input);
      expect(resolveManagedAcquireReviewV1(admitted)).toEqual({ homeId: 'home', ...policy });
    }
    const admission = { input: oneOff, requestId: 'request', continuationPresent: false, requestEnvelopeDigest: 'a'.repeat(43) };
    expect(ManagedAdmissionInputV1Schema.parse(admission)).toEqual(admission);
    expect(ManagedAdmissionInputV1Schema.safeParse({ ...admission, requestEnvelopeDigest: 'malformed' }).success).toBe(false);
    const continuation = { managedId: 'managed', creationRequestId: 'request', expectedIntentRevision: 0,
      acquireRequestEnvelopeDigest: admission.requestEnvelopeDigest };
    expect(ExternalActionManagedContinuationV1Schema.parse(continuation)).toEqual(continuation);
    expect(ExternalActionManagedContinuationV1Schema.safeParse({ ...continuation, controller: { machineId: 'half-pair' } }).success).toBe(false);
  });
  it('retains the exact strict provisioner descriptor in a controller-free reviewed receipt', () => {
    const provisioner = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'VM', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
      launchSchema: { type: 'object', properties: {}, additionalProperties: false },
      resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
      billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
      actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } });
    const launch = { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
    const facts = { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
      retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true };
    expect(protocol.ManagedConfigurationFactsV1Schema.parse(facts)).toEqual(facts);
    expect(protocol.ManagedConfigurationFactsV1Schema.safeParse({ ...facts, provisioner: { ...provisioner, unknownAuthority: true } }).success).toBe(false);
    expect(protocol.buildManagedConfigurationFactsV1({ choicesSchema: z.strictObject({}), launch, provisioner,
      optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
      retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] } }).provisioner).toEqual(provisioner);
  });
  it('retains typed preset admission refusals at the managed controller transport', () => {
    for (const code of ['preset_not_found', 'preset_archived', 'preset_limit_reached']) {
      expect(ManagedErrorV1Schema.parse({ code })).toEqual({ code });
    }
  });
  it('admits only the reviewed Home-qualified preset revision, never caller-supplied launch or authority', () => {
    const schema: unknown = Reflect.get(protocol, 'ManagedPresetSelectionV1Schema');
    expect(schema).toBeInstanceOf(z.ZodMiniType);
    if (!(schema instanceof z.ZodMiniType)) throw new Error('The preset selection validator is missing');

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
  const choices = z.strictObject({ cores: z.number().check(z.int(), z.positive()) });
  const launch = { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
    name: 'guest', choices: { cores: 2 } };
  const controller = { machineId: 'host-a', installationId: 'installation-a' };

  it('detaches frozen contributed launch choices into a mutable wire receipt', () => {
    const nativeChoices = { sizes: [2, 4] };
    Object.freeze(nativeChoices.sizes);
    Object.freeze(nativeChoices);
    const facts = protocol.buildManagedConfigurationFactsV1({
      choicesSchema: createPluginJsonSchemaZodValueAdapter({ type: 'object',
        properties: { sizes: { type: 'array', items: { type: 'integer' } } }, required: ['sizes'], additionalProperties: false }),
      launch: { ...launch, choices: nativeChoices }, controller, optionStatus: 'current', prerequisites: [],
      billing: { location: 'cloud', stoppedBilling: 'unknown' }, retentionCapabilities: { supportedIntents: ['delete'] },
    });
    const copied = facts.launch.choices;
    if (!copied || typeof copied !== 'object' || Array.isArray(copied) || !Array.isArray(copied.sizes))
      throw new Error('Expected native sizing choices');
    copied.sizes.push(8);
    expect(copied).toEqual({ sizes: [2, 4, 8] });
    expect(nativeChoices).toEqual({ sizes: [2, 4] });
  });

  it('preserves a declared native duration in the same labelled option and immutable fact seam', () => {
    const duration = { id: 'lease-two-hours', title: '2 hours', afterMs: 7_200_000 };
    const options = MachineProvisionerOptionsResultV1Schema.parse({ base: { launch: { cores: 2 }, nativeFacts: { duration } },
      dimensions: { size: [], image: [], location: [], network: [], duration: [] } });
    const facts = protocol.buildManagedConfigurationFactsV1({ choicesSchema: choices, launch, controller,
      optionStatus: 'current', prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'unknown' },
      retentionCapabilities: { supportedIntents: ['delete'], finiteOnly: true }, nativeFacts: options.base!.nativeFacts });
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
    const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
    const options = MachineProvisionerOptionsResultV1Schema.parse({ dimensions: { ...dimensions, size: [{ id: 'native-size', title: 'Native size',
      assignments: [], prices: [price], nativeFacts: { monthlyCapStatus: 'none' } }] } });
    const selected = options.dimensions.size[0]!;
    const facts = protocol.buildManagedConfigurationFactsV1({ choicesSchema: choices, launch, controller,
      optionStatus: 'current', prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' },
      retentionCapabilities: { supportedIntents: ['delete'] }, prices: selected.prices, nativeFacts: selected.nativeFacts });
    expect(facts).toMatchObject({ prices: [price], nativeFacts: { monthlyCapStatus: 'none' } });
    expect(protocol.ManagedConfigurationFactsV1ReadSchema.parse({ ...facts,
      nativeFacts: { monthlyCapStatus: 'unknown', future: true } }).nativeFacts)
      .toEqual({ monthlyCapStatus: 'unknown' });
    expect(MachineProvisionerOptionsResultV1Schema.parse({ dimensions: { ...dimensions, size: [{ id: 'unmeasured', title: 'Unmeasured', assignments: [], prices: [price] }] } })
      .dimensions.size[0]?.nativeFacts).toBeUndefined();
    expect(MachineProvisionerOptionsResultV1Schema.safeParse({ dimensions: { ...dimensions, size: [{ id: 'invalid', title: 'Invalid', assignments: [],
      nativeFacts: { monthlyCapStatus: 'inferred-from-rate' } }] } }).success).toBe(false);
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
    const enrollmentIdentity = { kind: 'existingUser', role: 'adopted' } as const;
    const request = ManagedAcquireInputV1Schema.parse({ selection, enrollmentIdentity });
    expect(resolveManagedAcquireReviewV1(request)).toMatchObject({ homeId: selection.homeId,
      controller, retention: selection.retention, wakeOnAcceptedMessage: false });
    expect(ManagedAcquireInputV1Schema.safeParse({ selection, controller }).success).toBe(false);
    const sealed = sealManagedMachinePresetContentV1({ presetId: 'preset', mode: 'plain', content: {
      v: 1, name: launch.name, launch,
    } });
    const override = createManagedMachinePresetAcquireOverrideV1({ presetId: 'preset', mode: 'plain',
      projection: { content: sealed.content, recipientEnvelope: null }, enrollmentIdentity });
    if (!override) throw new Error('Expected private acquisition identity');
    const preset = { selection: { kind: 'preset', homeId: 'home-a', id: 'preset', revision: 4 },
      controller, retention: selection.retention, wakeOnAcceptedMessage: false, presetContentOverride: override };
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
