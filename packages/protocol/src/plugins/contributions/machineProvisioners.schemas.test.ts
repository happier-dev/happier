import { describe, expect, it } from 'vitest';
import {
  createProtocolComposableSchema,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '../actions/protocolComposableSchema.js';
import {
  defineMachineProvisionerSchemas,
  MachineProvisionerAcquireResultV1Schema,
  MachineProvisionerBootstrapCarrierV1Schema,
} from './machineProvisioners.js';
import { prepareMachineProvisionerStoredSchemas } from './machineProvisionerStoredSchemas.js';
import * as provisioners from './machineProvisioners.js';
import { RetentionCapabilitiesV1Schema } from '../../machines/managed/providerFactsV1.js';
import { PluginManifestV2Schema } from '../manifest/v2.js';
import { PluginContributesV2Schema } from './v2.js';
import { compilePluginJsonSchema } from '../actions/jsonSchemaValidation.js';

function nativeDurationManifest() {
  const timeout = defineProtocolNumber({
    integer: true,
    minimum: 1000,
    maximum: 86400000,
    multipleOf: 1000,
  });
  const launch = defineProtocolObject(
    { timeoutMs: timeout },
    { policy: 'closed' },
  );
  const resource = defineProtocolObject(
    { name: defineProtocolString() },
    { policy: 'closed' },
  );
  const roles = defineMachineProvisionerSchemas({ launch, resource });
  const query = defineProtocolObject(
    {
      timeoutMs: timeout.optional(),
      imageReference: defineProtocolString().optional(),
    },
    { policy: 'closed' },
  );
  const action = {
    title: 'Native role',
    scopes: ['machine'],
    surfaces: ['plugin'],
    execution: { target: 'daemon' },
    dangerLevel: 'safe',
  };
  return {
    schemaVersion: 2,
    id: 'test.native-duration',
    version: '1.0.0',
    displayName: 'Native duration',
    engines: { happier: '^0.0.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.js' },
    hostAccess: { required: [], optional: [] },
    contributes: {
      machineProvisioners: [
        {
          id: 'guest',
          title: 'Native guest',
          icon: 'server',
          resourceKind: 'sandbox',
          schemaVersion: 1,
          launchSchema: launch.jsonSchema,
          resourceSchema: resource.jsonSchema,
          platforms: ['linux'],
          prerequisites: [],
          billing: { location: 'cloud', stoppedBilling: 'not-billed' },
          retention: { supportedIntents: ['delete'], finiteOnly: true },
          actions: {
            check: 'check',
            options: 'options',
            acquire: 'acquire',
            bootstrap: 'bootstrap',
            inspect: 'inspect',
            destroy: 'destroy',
          },
          nativeDurationInput: { path: 'timeoutMs', unit: 'milliseconds' },
        },
      ],
      actions: [
        {
          ...action,
          id: 'check',
          inputSchema: roles.checkInput.jsonSchema,
          resultSchema:
            provisioners.MachineProvisionerCheckResultProtocolV1Schema
              .jsonSchema,
        },
        {
          ...action,
          id: 'options',
          inputSchema: query.jsonSchema,
          resultSchema:
            provisioners.MachineProvisionerOptionsResultProtocolV1Schema
              .jsonSchema,
          inputHints: {
            fields: [
              { path: 'timeoutMs', title: 'Native timeout', widget: 'integer' },
              { path: 'imageReference', title: 'Image', widget: 'text' },
            ],
          },
        },
        {
          ...action,
          id: 'acquire',
          inputSchema: roles.acquireInput.jsonSchema,
          resultSchema: roles.acquireResult.jsonSchema,
        },
        {
          ...action,
          id: 'bootstrap',
          inputSchema: roles.bootstrapInput.jsonSchema,
          resultSchema:
            provisioners.MachineProvisionerBootstrapCarrierV1Schema.jsonSchema,
        },
        {
          ...action,
          id: 'inspect',
          inputSchema: roles.resourceInput.jsonSchema,
          resultSchema:
            provisioners.MachineProvisionerObservationV1Schema.jsonSchema,
        },
        {
          ...action,
          id: 'destroy',
          inputSchema: roles.resourceInput.jsonSchema,
          resultSchema:
            provisioners.MachineProvisionerPowerResultV1Schema.jsonSchema,
        },
      ],
    },
  };
}

describe('public machine provisioner role schemas', () => {
  it('retains optional declared enrollment roles through strict manifest admission', () => {
    const manifest = nativeDurationManifest();
    expect(PluginManifestV2Schema.parse(manifest).contributes.machineProvisioners[0]).not.toHaveProperty('enrollmentRole');
    for (const enrollmentRole of ['server', 'personal', 'sandbox']) {
      const declared = { ...manifest, contributes: { ...manifest.contributes,
        machineProvisioners: [{ ...manifest.contributes.machineProvisioners[0], enrollmentRole }] } };
      expect(PluginManifestV2Schema.parse(declared).contributes.machineProvisioners[0]).toHaveProperty('enrollmentRole', enrollmentRole);
    }
    expect(provisioners.MachineProvisionerContributionV1Schema.safeParse({
      ...manifest.contributes.machineProvisioners[0], enrollmentRole: 'guessed',
    }).success).toBe(false);
  });
  it('admits Account and native provisioner roles through the same strict contribution owner', () => {
    const base = nativeDurationManifest().contributes;
    const portable = { ...base,
      machineProvisioners: base.machineProvisioners.map(descriptor => ({ ...descriptor, browserReachable: true })),
      actions: base.actions.map(action => ({ ...action, execution: action.id === 'inspect'
        ? action.execution : { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } })),
    };
    const admitted = PluginContributesV2Schema.safeParse(portable);
    expect(admitted.success, admitted.success ? '' : JSON.stringify(admitted.error.issues)).toBe(true);
    if (admitted.success) expect(admitted.data.machineProvisioners?.[0]?.browserReachable).toBe(true);
    expect(PluginContributesV2Schema.safeParse(base).success).toBe(true);
    expect(PluginContributesV2Schema.safeParse({ ...portable, actions: portable.actions.map(action => action.id === 'acquire'
      ? { ...action, execution: { target: 'client', client: { artifactId: 'portable', exportName: 'activate' }, platforms: ['web'] } }
      : action) }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ ...portable,
      machineProvisioners: portable.machineProvisioners.map(descriptor => ({ ...descriptor, browserReachable: 'yes' })),
    }).success).toBe(false);
  });

  it('carries selected Account credential choices without inventing a controller', () => {
    const descriptor = nativeDurationManifest().contributes.machineProvisioners[0]!;
    const contribution = { pluginId: 'fixture.cloud', localId: descriptor.id };
    const entry = { contribution, occurrenceId: 'bundled-cloud', descriptor, acquireExecutionTarget: 'daemon',
      credentialPurposes: [{ purpose: { consumer: contribution, purpose: 'cloud-api' }, options: [{
        value: { service: { pluginId: 'fixture.cloud', localId: 'account' }, accountId: 'selected' }, label: 'My cloud account',
      }] }] };
    expect(provisioners.MachineProvisionersListResultV1Schema.parse({ provisioners: [entry] })).toEqual({ provisioners: [entry] });
    expect(provisioners.MachineProvisionersListResultV1Schema.safeParse({ provisioners: [{ ...entry,
      credentialPurposes: [{ ...entry.credentialPurposes[0], purpose: { consumer: { ...contribution, pluginId: 'other.plugin' }, purpose: 'cloud-api' } }],
    }] }).success).toBe(false);
  });


  it('retains older optional result snapshots while rejecting changed retained fields and native values', () => {
    const manifest = nativeDurationManifest();
    const snapshot = structuredClone(manifest);
    const check = snapshot.contributes.actions.find(action => action.id === 'check')!;
    delete check.resultSchema.properties!.nativeCredentialDelivery;
    const inspect = snapshot.contributes.actions.find(action => action.id === 'inspect')!;
    delete inspect.resultSchema.properties!.nativeCause;
    const olderBound = snapshot.contributes.actions.find(action => action.id === 'acquire')!.resultSchema.oneOf!
      .find(arm => arm.properties?.kind?.const === 'bound')!;
    delete olderBound.properties!.startPending;
    expect(PluginManifestV2Schema.safeParse(snapshot).success).toBe(true);
    const changed = structuredClone(snapshot);
    changed.contributes.actions.find(action => action.id === 'check')!.resultSchema.properties!.available = { type: 'string' };
    expect(PluginManifestV2Schema.safeParse(changed).success).toBe(false);
    const changedNative = structuredClone(snapshot);
    const acquire = changedNative.contributes.actions.find(action => action.id === 'acquire')!;
    const bound = acquire.resultSchema.oneOf!.find(arm => arm.properties?.kind?.const === 'bound')!;
    bound.properties!.resource!.properties!.value = { type: 'object', properties: {}, additionalProperties: false };
    expect(PluginManifestV2Schema.safeParse(changedNative).success).toBe(false);
    // Structural manifest parsing admits the array shape; the role admission
    // must still apply the normalizer's semantic checks to declared documents.
    const invalid = structuredClone(snapshot);
    const input = invalid.contributes.actions.find(action => action.id === 'acquire')!.inputSchema;
    input.required!.push(input.required![0]!);
    expect(() => PluginManifestV2Schema.safeParse(invalid)).toThrow(Error);
  });

  it('admits independent option facts and refuses the retired Cartesian catalog', () => {
    const options = {
      base: { launch: {} },
      dimensions: {
        size: [{ id: 'small', title: 'Small', assignments: [{ path: 'size', value: 'small' }],
          prices: [{ amount: '1', currency: 'EUR', unit: 'hour', source: 'native', observedAt: 1,
            when: [{ dimension: 'location', optionIds: ['hel1'] }] }] }],
        image: [], location: [{ id: 'hel1', title: 'Helsinki', assignments: [{ path: 'location', value: 'hel1' }] }],
        network: [], duration: [],
      },
      constraints: [{ when: { dimension: 'size', optionIds: ['small'] }, requires: { dimension: 'location', optionIds: ['hel1'] } }],
    };
    expect(provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse(options)).toEqual(options);
    expect(provisioners.MachineProvisionerOptionsResultProtocolV1Schema.safeParse({ choices: [] }).success).toBe(false);
    expect(provisioners.MachineProvisionerOptionsResultProtocolV1Schema.safeParse({ ...options,
      dimensions: { ...options.dimensions, size: [{ ...options.dimensions.size[0], launch: {} }] } }).success).toBe(false);
    expect(provisioners.MachineProvisionerOptionsResultProtocolV1Schema.safeParse({ ...options,
      constraints: [{ when: { dimension: 'size', optionIds: ['unknown'] }, requires: { dimension: 'location', optionIds: ['hel1'] } }] }).success).toBe(false);
    const manifest = nativeDurationManifest();
    const optionAction = manifest.contributes.actions.find(action => action.id === 'options')!;
    optionAction.resultSchema = { type: 'object', properties: { choices: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: false } } }, required: ['choices'], additionalProperties: false };
    expect(PluginManifestV2Schema.safeParse(manifest).success).toBe(false);
  });
  it('projects selected native facts and applicable prices into one closed validated launch', () => {
    const launch = defineProtocolObject({
      size: defineProtocolString(), image: defineProtocolString(), location: defineProtocolString(),
      network: defineProtocolObject({ ipv6: defineProtocolLiteral(true) }, { policy: 'closed' }),
    }, { policy: 'closed' });
    const price = { amount: '1', currency: 'EUR', unit: 'hour', source: 'native', observedAt: 1 };
    const options = provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse({
      base: { launch: {}, nativeFacts: { size: { id: 'small', title: 'Small', cpuCores: 2 } } },
      dimensions: {
        size: [{ id: 'small', title: 'Small', assignments: [{ path: 'size', value: 'small' }], prices: [price] }],
        image: [{ id: 'arm', title: 'ARM', assignments: [{ path: 'image', value: 'arm' }],
          nativeFacts: { size: { id: 'small', title: 'Small', diskBytes: 100 } } }],
        location: ['hel1', 'fsn1'].map(id => ({ id, title: id, assignments: [{ path: 'location', value: id }] })),
        network: [{ id: 'dual', title: 'Dual stack', assignments: [{ path: 'network.ipv6', value: true }],
          prices: [{ ...price, amount: '2', when: [{ dimension: 'location', optionIds: ['hel1'] }] }] }], duration: [],
      }, constraints: [{ when: { dimension: 'image', optionIds: ['arm'] }, requires: { dimension: 'location', optionIds: ['hel1'] } }],
    });
    const selection = { size: 'small', image: 'arm', location: 'hel1', network: 'dual' };
    const project = (value: provisioners.MachineProvisionerSelectionV1) => provisioners.projectMachineProvisionerSelectionV1({ options, selection: value, launchSchema: launch.jsonSchema });
    expect(project(selection)).toMatchObject({ kind: 'ready', launch: { size: 'small', image: 'arm', location: 'hel1', network: { ipv6: true } },
      prices: [price, { ...price, amount: '2' }], nativeFacts: { size: { id: 'small', title: 'Small', cpuCores: 2, diskBytes: 100 } } });
    expect(project({ size: 'small' })).toMatchObject({ kind: 'incomplete', prices: [price] });
    expect(project({ ...selection, location: 'fsn1' })).toMatchObject({ kind: 'unavailable', prices: [price] });
    expect(project({ ...selection, image: 'unknown' })).toMatchObject({ kind: 'invalid', code: 'unknown_option' });
    const unavailable = structuredClone(options);
    unavailable.dimensions.network[0]!.available = false;
    expect(provisioners.projectMachineProvisionerSelectionV1({ options: unavailable, selection, launchSchema: launch.jsonSchema }).kind).toBe('unavailable');
    const malformed = structuredClone(options);
    malformed.dimensions.network[0]!.assignments[0]!.value = false;
    expect(provisioners.projectMachineProvisionerSelectionV1({ options: malformed, selection, launchSchema: launch.jsonSchema })).toMatchObject({ kind: 'invalid', code: 'invalid_launch' });
  });
  it('refuses projection bypasses, contradictory selectors and detached reviewed effects', () => {
    const launch = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
    const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
    const project = (options: provisioners.MachineProvisionerOptionsResultV1, selection: provisioners.MachineProvisionerSelectionV1 = {}) =>
      provisioners.projectMachineProvisionerSelectionV1({ options, selection, launchSchema: launch.jsonSchema });
    expect(project({ dimensions })).toMatchObject({ kind: 'incomplete' });
    expect(project({ base: { launch: {} }, dimensions })).toMatchObject({ kind: 'invalid', code: 'invalid_launch' });
    const reviewed = { base: { launch: { name: 'reviewed' }, effectReview: { kind: 'devcontainer' as const, reviewedEffectDigest: 'a'.repeat(64), effects: [] } }, dimensions };
    expect(project(reviewed)).toMatchObject({ kind: 'ready', launch: { name: 'reviewed' }, effectReview: reviewed.base.effectReview });
    const option = (path: string, value: string) => ({ id: 'one', title: 'One', assignments: [{ path, value }] });
    expect(project({ ...reviewed, dimensions: { ...dimensions, size: [option('name', 'changed')] } }, { size: 'one' }))
      .toMatchObject({ kind: 'invalid', code: 'effect_review_mismatch' });
    expect(project({ base: { launch: {} }, dimensions: { ...dimensions, size: [option('secret', 'x')] } }, { size: 'one' }))
      .toMatchObject({ kind: 'invalid', code: 'undeclared_selector' });
    expect(project({ base: { launch: {} }, dimensions: { ...dimensions, size: [option('name', 'x')], image: [option('name', 'y')] } }, { size: 'one', image: 'one' }))
      .toMatchObject({ kind: 'invalid', code: 'conflicting_selectors' });
    const retained = { ...option('name', 'x'), retention: { supportedIntents: ['delete' as const], finiteOnly: true } };
    const conflict = { ...option('name', 'x'), assignments: [], retention: { supportedIntents: ['delete' as const], finiteOnly: false } };
    expect(project({ base: { launch: {} }, dimensions: { ...dimensions, size: [retained], image: [conflict] } }, { size: 'one', image: 'one' }))
      .toMatchObject({ kind: 'invalid', code: 'conflicting_retention' });
  });
  it('retains localized provisioner identity and native check vocabulary through the public schemas', () => {
    const descriptor = {
      ...nativeDurationManifest().contributes.machineProvisioners[0],
      kindTitle: { key: 'native.kind', fallback: 'Sandbox' },
      description: {
        key: 'native.description',
        fallback: 'An isolated machine for coding.',
      },
    };
    expect(
      provisioners.MachineProvisionerContributionV1Schema.safeParse(descriptor)
        .success,
    ).toBe(true);
    const check = {
      available: false,
      code: 'native_license_required',
      status: { key: 'native.license', fallback: 'License required' },
    };
    expect(
      provisioners.MachineProvisionerCheckResultProtocolV1Schema.safeParse(
        check,
      ).success,
    ).toBe(true);
    expect(
      provisioners.MachineProvisionerCheckResultProtocolV1Schema.parse(check),
    ).toEqual(check);
    expect(
      provisioners.MachineProvisionerContributionV1Schema.safeParse({
        ...descriptor,
        kindTitle: { arbitrary: true },
      }).success,
    ).toBe(false);
  });
  it('admits an exact pending-cleanup observation role and rejects effectful or mismatched cleanup declarations', () => {
    const manifest = nativeDurationManifest();
    const descriptor = manifest.contributes.machineProvisioners[0];
    const nativeOperation = defineProtocolObject(
      { claimId: defineProtocolString() },
      { policy: 'closed' },
    );
    const native = defineProtocolObject(
      { name: defineProtocolString() },
      { policy: 'closed' },
    );
    const reconciliation =
      provisioners.defineMachineProvisionerReconciliationSchemas({
        launch: native,
        resource: native,
        nativeOperation,
      });
    const cleanupResult = defineProtocolUnion([
      defineProtocolObject(
        { kind: defineProtocolLiteral('confirmed') },
        { policy: 'closed' },
      ),
      defineProtocolObject(
        { kind: defineProtocolLiteral('retryable') },
        { policy: 'closed' },
      ),
      defineProtocolObject(
        {
          kind: defineProtocolLiteral('unknown'),
          code: defineProtocolString({ minLength: 1 }).optional(),
        },
        { policy: 'closed' },
      ),
    ]);
    const cleanup = {
      ...manifest.contributes.actions[0],
      id: 'observe-cleanup',
      inputSchema: defineProtocolObject(
        { nativeOperation },
        { policy: 'closed' },
      ).jsonSchema,
      resultSchema: cleanupResult.jsonSchema,
    };
    const actions = manifest.contributes.actions.map((action) =>
      action.id === 'acquire'
        ? { ...action, resultSchema: reconciliation.result.jsonSchema }
        : action.id === 'destroy'
          ? { ...action, inputSchema: reconciliation.destroyInput.jsonSchema }
          : action,
    );
    const pending = {
      ...manifest,
      contributes: {
        ...manifest.contributes,
        machineProvisioners: [
          {
            ...descriptor,
            launchSchema: native.jsonSchema,
            reconciliation: {
              nativeOperationSchema: nativeOperation.jsonSchema,
              action: 'reconcile',
              cleanup: 'observe-cleanup',
            },
          },
        ],
        actions: [
          ...actions.map((action) =>
            action.id === 'acquire'
              ? {
                  ...action,
                  inputSchema: defineMachineProvisionerSchemas({
                    launch: native,
                    resource: native,
                  }).acquireInput.jsonSchema,
                }
              : action,
          ),
          {
            ...cleanup,
            id: 'reconcile',
            inputSchema: reconciliation.input.jsonSchema,
            resultSchema: reconciliation.result.jsonSchema,
          },
          cleanup,
        ],
      },
    };
    const { cleanup: _cleanup, ...lookup } =
      pending.contributes.machineProvisioners[0].reconciliation;
    expect(
      PluginManifestV2Schema.safeParse({
        ...pending,
        contributes: {
          ...pending.contributes,
          machineProvisioners: [
            {
              ...pending.contributes.machineProvisioners[0],
              reconciliation: lookup,
            },
          ],
          actions: pending.contributes.actions.filter(
            (action) => action.id !== cleanup.id,
          ),
        },
      }).success,
    ).toBe(true);
    expect(PluginManifestV2Schema.safeParse(pending).success).toBe(true);
    for (const invalid of [
      {
        ...cleanup,
        dangerLevel: 'writesRemote',
        confirmation: { title: 'Cleanup', body: 'Delete' },
      },
      {
        ...cleanup,
        inputSchema: defineProtocolObject(
          { resource: native },
          { policy: 'closed' },
        ).jsonSchema,
      },
      { ...cleanup, resultSchema: reconciliation.result.jsonSchema },
    ]) {
      expect(
        PluginManifestV2Schema.safeParse({
          ...pending,
          contributes: {
            ...pending.contributes,
            actions: pending.contributes.actions.map((action) =>
              action.id === cleanup.id ? invalid : action,
            ),
          },
        }).success,
      ).toBe(false);
    }
  });
  it('admits a native duration binding to the real numeric options field in a complete cold manifest', () => {
    const manifest = nativeDurationManifest();
    const { nativeDurationInput: _binding, ...unbound } =
      manifest.contributes.machineProvisioners[0];
    // Distinguish a missing duration contract from a broken complete-role fixture.
    expect(
      PluginManifestV2Schema.safeParse({
        ...manifest,
        contributes: {
          ...manifest.contributes,
          machineProvisioners: [unbound],
        },
      }).success,
    ).toBe(true);
    const parsed = PluginManifestV2Schema.safeParse(manifest);
    expect(parsed.success).toBe(true);
    if (!parsed.success)
      throw new Error('Declared native duration field was refused');
    expect(parsed.data.contributes.machineProvisioners[0]).toHaveProperty(
      'nativeDurationInput',
      { path: 'timeoutMs', unit: 'milliseconds' },
    );
    expect(
      parsed.data.contributes.machineProvisioners[0].retention,
    ).not.toHaveProperty('nativeExpiry');
  });

  it('admits a native resource id path only where the declared resource carries it', () => {
    const manifest = nativeDurationManifest();
    const descriptor = manifest.contributes.machineProvisioners[0];
    const withDescriptor = (replacement: unknown) => ({
      ...manifest,
      contributes: {
        ...manifest.contributes,
        machineProvisioners: [replacement],
      },
    });
    const parsed = PluginManifestV2Schema.safeParse(
      withDescriptor({ ...descriptor, resourceIdPath: 'name' }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success)
      throw new Error('Declared native resource id was refused');
    expect(parsed.data.contributes.machineProvisioners[0]).toHaveProperty(
      'resourceIdPath',
      'name',
    );
    expect(
      PluginManifestV2Schema.safeParse(
        withDescriptor({ ...descriptor, resourceIdPath: 'serverId' }),
      ).success,
    ).toBe(false);
  });

  it('rejects missing, nonnumeric and ambiguous native duration field bindings without relaxing ordinary hints', () => {
    const manifest = nativeDurationManifest();
    const descriptor = manifest.contributes.machineProvisioners[0];
    const withDescriptor = (replacement: unknown) => ({
      ...manifest,
      contributes: {
        ...manifest.contributes,
        machineProvisioners: [replacement],
      },
    });
    const { options: _options, ...withoutOptions } = descriptor.actions;
    expect(
      PluginManifestV2Schema.safeParse(
        withDescriptor({ ...descriptor, actions: withoutOptions }),
      ).success,
    ).toBe(false);
    for (const path of ['missingTimeout', 'imageReference']) {
      expect(
        PluginManifestV2Schema.safeParse(
          withDescriptor({
            ...descriptor,
            nativeDurationInput: { path, unit: 'milliseconds' },
          }),
        ).success,
      ).toBe(false);
    }
    const options = manifest.contributes.actions.find(
      (candidate) => candidate.id === 'options',
    )!;
    const withOptions = (
      replacement: unknown,
      provisioner: unknown = descriptor,
    ) => ({
      ...manifest,
      contributes: {
        ...manifest.contributes,
        machineProvisioners: [provisioner],
        actions: manifest.contributes.actions.map((candidate) =>
          candidate.id === 'options' ? replacement : candidate,
        ),
      },
    });
    const fields = options.inputHints!.fields;
    expect(
      PluginManifestV2Schema.safeParse(
        withOptions({
          ...options,
          inputHints: { fields: [...fields, fields[0]] },
        }),
      ).success,
    ).toBe(false);
    const ambiguous = defineProtocolUnion([
      defineProtocolObject(
        {
          mode: defineProtocolLiteral('short'),
          timeoutMs: defineProtocolNumber({ integer: true, minimum: 1000 }),
        },
        { policy: 'closed' },
      ),
      defineProtocolObject(
        {
          mode: defineProtocolLiteral('long'),
          timeoutMs: defineProtocolNumber({ integer: true, minimum: 60000 }),
        },
        { policy: 'closed' },
      ),
    ]);
    const ambiguousOptions = {
      ...options,
      inputSchema: ambiguous.jsonSchema,
      inputHints: { fields: [fields[0]] },
    };
    const { nativeDurationInput: _binding, ...unbound } = descriptor;
    // Ordinary numeric hints may cover different numeric branches. A duration
    // binding must nevertheless identify one unambiguous declared native field.
    expect(
      PluginManifestV2Schema.safeParse(withOptions(ambiguousOptions, unbound))
        .success,
    ).toBe(true);
    expect(
      PluginManifestV2Schema.safeParse(withOptions(ambiguousOptions)).success,
    ).toBe(false);
  });

  it('admits explicit native guest homes and process configuration without confusing it with process termination', () => {
    const native = defineProtocolObject(
      { name: defineProtocolString() },
      { policy: 'closed' },
    );
    const roles = defineMachineProvisionerSchemas({
      launch: native,
      resource: native,
    });
    const carrier = {
      kind: 'native',
      transport: {
        contributionRef: { pluginId: 'test.native', localId: 'guest' },
        schemaVersion: 1,
      },
      guestHome: {
        homeDir: '/volume/home',
        happyHomeDir: '/volume/home/.happier',
        daemonStartup: 'native-process',
      },
    };
    expect(MachineProvisionerBootstrapCarrierV1Schema.parse(carrier)).toEqual(
      carrier,
    );
    const validate = compilePluginJsonSchema(MachineProvisionerBootstrapCarrierV1Schema.jsonSchema);
    expect(validate(carrier)).toBe(true);
    expect(validate({ ...carrier, guestHome: { ...carrier.guestHome, homeDir: 'relative/home' } })).toBe(false);
    expect(validate({ ...carrier, guestHome: { ...carrier.guestHome, happyHomeDir: 'relative/state' } })).toBe(false);
    expect(
      MachineProvisionerBootstrapCarrierV1Schema.safeParse({
        ...carrier,
        guestHome: { ...carrier.guestHome, extra: true },
      }).success,
    ).toBe(false);
    const request = {
      resource: { name: 'guest' },
      argv: [
        '/volume/home/.happier/cli/current/happier',
        'daemon',
        'start-sync',
      ],
      processConfig: {
        environment: {
          HOME: '/volume/home',
          HAPPIER_HOME_DIR: '/volume/home/.happier',
        },
        detachedDaemonStartArgv: ['/volume/home/.happier/cli/current/happier', 'daemon', 'start', '--json'],
      },
    };
    expect(roles.execInput.parse(request)).toEqual(request);
    expect(
      roles.execInput.safeParse({
        ...request,
        processConfig: { ...request.processConfig, extra: true },
      }).success,
    ).toBe(false);
    expect(
      provisioners.MachineProvisionerNativeExecResultV1Schema.parse({
        kind: 'process-configured',
      }),
    ).toEqual({ kind: 'process-configured' });
    expect(
      provisioners.MachineProvisionerNativeExecResultV1Schema.safeParse({
        kind: 'process-configured',
        machineId: 'invented',
      }).success,
    ).toBe(false);
  });
  it('admits binary native bootstrap payloads through executable and portable role schemas', () => {
    const native = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
    const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
    // A file fragment is binary data, not a small control message.
    const bytesBase64 = Buffer.alloc(8 * 1024 * 1024, 0xa5).toString('base64');
    const request = { resource: { name: 'guest' }, guestPath: '/tmp/happier.tar.gz', bytesBase64 };
    expect(roles.putFileInput.safeParse(request).success).toBe(true);
    expect(compilePluginJsonSchema(roles.putFileInput.jsonSchema)(request)).toBe(true);
    const exec = { resource: request.resource, argv: ['cat'], inputBase64: bytesBase64 };
    expect(roles.execInput.safeParse(exec).success).toBe(true);
    expect(compilePluginJsonSchema(roles.execInput.jsonSchema)(exec)).toBe(true);
    for (const invalid of ['A', 'AAA', 'A===', 'AA=A', 'AA==\n', 'AA-_']) {
      const malformed = { ...request, bytesBase64: invalid };
      expect(roles.putFileInput.safeParse(malformed).success).toBe(false);
      expect(compilePluginJsonSchema(roles.putFileInput.jsonSchema)(malformed)).toBe(false);
    }
    const maximum = provisioners.MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1;
    const boundary = { ...request, bytesBase64: 'A'.repeat(maximum) };
    expect(roles.putFileInput.safeParse(boundary).success).toBe(true);
    expect(compilePluginJsonSchema(roles.putFileInput.jsonSchema)(boundary)).toBe(true);
    const oversized = { ...request, bytesBase64: `${boundary.bytesBase64}AAAA` };
    expect(roles.putFileInput.safeParse(oversized).success).toBe(false);
    expect(compilePluginJsonSchema(roles.putFileInput.jsonSchema)(oversized)).toBe(false);
  });
  it('accepts an explicit native bootstrap credential without publishing private material', () => {
    const native = defineProtocolObject({}, { policy: 'closed' });
    const descriptor = {
      id: 'vm',
      title: 'Virtual machine',
      icon: 'server',
      resourceKind: 'virtual-machine',
      schemaVersion: 1,
      platforms: ['darwin', 'linux', 'win32'],
      prerequisites: [],
      launchSchema: native.jsonSchema,
      resourceSchema: native.jsonSchema,
      billing: { location: 'cloud', stoppedBilling: 'unknown' },
      retention: { supportedIntents: ['delete'] },
      actions: {
        check: 'check',
        acquire: 'acquire',
        bootstrap: 'bootstrap',
        inspect: 'inspect',
        destroy: 'destroy',
      },
      bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
    };
    const parsed =
      provisioners.MachineProvisionerContributionV1Schema.safeParse({
        ...descriptor,
        bootstrapCredential: { kind: 'native-token' },
      });
    expect(parsed.success).toBe(true);
    if (!parsed.success)
      throw new Error('Native bootstrap credential declaration was refused');
    expect(parsed.data).toHaveProperty('bootstrapCredential', {
      kind: 'native-token',
    });
    expect(
      provisioners.MachineProvisionerContributionV1Schema.safeParse({
        ...descriptor,
        bootstrapCredential: {
          kind: 'native-token',
          value: 'must-not-be-public',
        },
      }).success,
    ).toBe(false);
    expect(
      provisioners.MachineProvisionerContributionV1Schema.parse(descriptor),
    ).not.toHaveProperty('bootstrapCredential');
    const { bootstrapTransport: _nativeTransport, ...sshOnly } = descriptor;
    expect(
      provisioners.MachineProvisionerContributionV1Schema.safeParse({
        ...sshOnly,
        bootstrapCredential: { kind: 'native-token' },
      }).success,
    ).toBe(false);
    expect(
      provisioners.MachineProvisionerContributionV1Schema.safeParse({
        ...descriptor,
        bootstrapCredential: { kind: 'ssh' },
      }).success,
    ).toBe(true);
  });

  it('retains labelled native choice dimensions without inventing unobserved resources', () => {
    const nativeFacts = {
      size: {
        id: 'small',
        title: 'Shared small',
        cpuCores: 0.5,
        memoryBytes: 1024,
      },
      image: {
        id: 'image-1',
        title: { key: 'images.linux', fallback: 'Linux' },
      },
      location: { id: 'region-1', title: 'Native region' },
    };
    const choice = {
      launch: { nativeSizeId: 'small' },
      nativeFacts,
    };
    const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
    expect(
      provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse({
        base: choice, dimensions,
      }),
    ).toEqual({ base: choice, dimensions });
    const qualified = {
      ...choice,
      retention: { supportedIntents: ['delete'], finiteOnly: true },
    };
    expect(
      provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse({
        base: qualified, dimensions,
      }),
    ).toEqual({ base: qualified, dimensions });
    for (const retention of [
      { ...qualified.retention, finiteOnly: 'yes' },
      { ...qualified.retention, token: 'private' },
    ]) {
      expect(
        provisioners.MachineProvisionerOptionsResultV1Schema.safeParse({
          base: { ...choice, retention }, dimensions,
        }).success,
      ).toBe(false);
    }
    expect(
      provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse({
        base: choice, dimensions,
      }).base?.nativeFacts?.size,
    ).not.toHaveProperty('diskBytes');
    for (const size of [
      { ...nativeFacts.size, memoryBytes: '1024' },
      { ...nativeFacts.size, token: 'private' },
    ]) {
      expect(
        provisioners.MachineProvisionerOptionsResultProtocolV1Schema.safeParse({
          base: { ...choice, nativeFacts: { ...nativeFacts, size } }, dimensions,
        }).success,
      ).toBe(false);
    }
  });
  it('declares finite-only retention separately from native expiry and unsupported power', () => {
    const finite = { supportedIntents: ['delete'], finiteOnly: true };
    expect(RetentionCapabilitiesV1Schema.parse(finite)).toEqual(finite);
    expect(
      RetentionCapabilitiesV1Schema.parse({ ...finite, finiteOnly: false }),
    ).toEqual({ ...finite, finiteOnly: false });
    const unknown = {
      supportedIntents: ['delete'],
      nativeExpiry: { kind: 'deadline', at: 9000 },
    };
    expect(RetentionCapabilitiesV1Schema.parse(unknown)).toEqual(unknown);
    expect(RetentionCapabilitiesV1Schema.parse(unknown)).not.toHaveProperty(
      'finiteOnly',
    );
    expect(
      RetentionCapabilitiesV1Schema.safeParse({ ...finite, finiteOnly: 'yes' })
        .success,
    ).toBe(false);
  });
  it('admits only a closed replacement resource result for rebuild and validates the declared native identity', () => {
    const native = defineProtocolObject(
      { name: defineProtocolString() },
      { policy: 'closed' },
    );
    const roles = defineMachineProvisionerSchemas({
      launch: native,
      resource: native,
    });
    const resource = {
      contributionRef: { pluginId: 'happier.machine-test', localId: 'guest' },
      schemaVersion: 1,
      value: { name: 'replacement' },
    };
    expect(
      roles.rebuildInput.parse({
        resource: { name: 'old' },
        reviewedEffectDigest: 'reviewed-config',
      }),
    ).toEqual({
      resource: { name: 'old' },
      reviewedEffectDigest: 'reviewed-config',
    });
    expect(
      roles.rebuildInput.safeParse({
        resource: { name: 'old' },
        reviewedEffectDigest: 'reviewed-config',
        token: 'private',
      }).success,
    ).toBe(false);
    expect(roles.rebuildResult.parse({ kind: 'bound', resource })).toEqual({
      kind: 'bound',
      resource,
    });
    expect(
      roles.rebuildResult.safeParse({
        kind: 'bound',
        resource: { ...resource, value: { wrong: true } },
      }).success,
    ).toBe(false);
    expect(roles.rebuildResult.safeParse({ kind: 'confirmed' }).success).toBe(
      false,
    );
    expect(
      roles.rebuildResult.safeParse({
        kind: 'refused',
        code: 'resource_mismatch',
      }).success,
    ).toBe(true);
    expect(
      roles.rebuildResult.safeParse({
        kind: 'unknown',
        recovery: { reference: 'old', reason: 'native_rebuild_unknown' },
      }).success,
    ).toBe(true);
  });
  it('returns a qualified descriptive prerequisite repair without treating it as installation authority', () => {
    const prerequisite = {
      requirement: {
        kind: 'systemTool',
        id: { pluginId: 'happier.machine-test', localId: 'native-tool' },
      },
      status: 'unavailable',
      repairAction: {
        action: { pluginId: 'happier.machine-test', localId: 'repair' },
        input: { machineName: 'guest' },
      },
    };
    const result =
      provisioners.MachineProvisionerCheckResultProtocolV1Schema.parse({
        available: false,
        prerequisites: [prerequisite],
      });
    expect(result).toEqual({ available: false, prerequisites: [prerequisite] });
    expect(
      provisioners.MachineProvisionerCheckResultProtocolV1Schema.safeParse({
        available: false,
        prerequisites: [
          { ...prerequisite, repairAction: { action: 'repair', input: {} } },
        ],
      }).success,
    ).toBe(false);
    expect(
      provisioners.MachineProvisionerCheckResultProtocolV1Schema.safeParse({
        available: false,
        prerequisites: [
          {
            ...prerequisite,
            repairAction: {
              ...prerequisite.repairAction,
              input: { invalid: undefined },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('reconciles retained handles or row correlation and validates eventual bound identity and exact cleanup inputs', async () => {
    const resource = defineProtocolObject(
      { name: defineProtocolString() },
      { policy: 'closed' },
    );
    const handle = defineProtocolObject(
      { claimId: defineProtocolString() },
      { policy: 'closed' },
    );
    const normalized = createProtocolComposableSchema(
      handle.jsonSchema,
      (value) => {
        const parsed = handle.safeParse(value);
        return parsed.success
          ? {
              success: true,
              data: { claimId: parsed.data.claimId.toLowerCase() },
            }
          : parsed;
      },
    );
    const reconciliation =
      provisioners.defineMachineProvisionerReconciliationSchemas({
        launch: resource,
        resource,
        nativeOperation: normalized,
      });
    const reference = {
      contributionRef: { pluginId: 'happier.machine-test', localId: 'guest' },
      schemaVersion: 1,
    };
    expect(
      reconciliation.input.parse({ nativeOperation: { claimId: 'CLAIM' } }),
    ).toEqual({ nativeOperation: { claimId: 'claim' } });
    const correlation = {
      managedId: 'managed',
      requestId: 'creation',
      launch: { name: 'guest' },
    };
    expect(reconciliation.input.safeParse({ correlation }).success).toBe(true);
    expect(
      reconciliation.input.safeParse({
        correlation: {
          ...correlation,
          launch: { name: 'guest', private: true },
        },
      }).success,
    ).toBe(false);
    expect(
      reconciliation.input.safeParse({
        correlation: { ...correlation, requestId: '' },
      }).success,
    ).toBe(false);
    expect(
      reconciliation.input.safeParse({
        nativeOperation: { claimId: 'claim' },
        correlation,
      }).success,
    ).toBe(false);
    expect(
      reconciliation.input.safeParse({
        nativeOperation: { claimId: 'claim', token: 'private' },
      }).success,
    ).toBe(false);
    expect(
      reconciliation.input.safeParse({ resource: { name: 'guest' } }).success,
    ).toBe(false);
    expect(
      reconciliation.destroyInput.parse({
        nativeOperation: { claimId: 'CLAIM' },
      }),
    ).toEqual({ nativeOperation: { claimId: 'claim' } });
    expect(
      reconciliation.destroyInput.parse({ resource: { name: 'guest' } }),
    ).toEqual({ resource: { name: 'guest' } });
    expect(
      reconciliation.destroyInput.safeParse({
        nativeOperation: { claimId: 'claim' },
        resource: { name: 'guest' },
      }).success,
    ).toBe(false);
    expect(
      reconciliation.destroyInput.safeParse({
        nativeOperation: { claimId: 'claim', token: 'private' },
      }).success,
    ).toBe(false);
    const pending = reconciliation.result.parse({
      kind: 'pending',
      nativeOperationRef: { ...reference, value: { claimId: 'CLAIM' } },
    });
    expect(
      pending.kind === 'pending' && pending.nativeOperationRef.value,
    ).toEqual({ claimId: 'claim' });
    expect(
      reconciliation.result.safeParse({
        kind: 'pending',
        nativeOperationRef: { ...reference, value: { wrong: true } },
      }).success,
    ).toBe(false);
    expect(
      reconciliation.result.parse({
        kind: 'bound',
        resource: { ...reference, value: { name: 'guest' } },
      }),
    ).toMatchObject({ resource: { value: { name: 'guest' } } });
    expect(
      reconciliation.result.safeParse({
        kind: 'bound',
        resource: { ...reference, value: { wrong: true } },
      }).success,
    ).toBe(false);
    expect(
      defineMachineProvisionerSchemas({
        launch: resource,
        resource,
      }).acquireResult.safeParse({
        kind: 'pending',
        nativeOperationRef: { ...reference, value: { claimId: 'claim' } },
      }).success,
    ).toBe(false);
    const readers = await prepareMachineProvisionerStoredSchemas({
      launch: resource,
      resource,
      nativeOperation: normalized,
    });
    expect(
      readers.nativeOperationStored.parse({ claimId: 'CLAIM', future: true }),
    ).toEqual({ claimId: 'claim' });
    expect(
      readers.nativeOperationStored.safeParse({ claimId: 1 }).success,
    ).toBe(false);
  });
  it('uses raw declared native values and canonical closed result envelopes', () => {
    const native = defineProtocolObject(
      { name: defineProtocolString() },
      { policy: 'closed' },
    );
    const roles = defineMachineProvisionerSchemas({
      launch: native,
      resource: native,
    });
    expect(roles.acquireInput.parse({ launch: { name: 'guest' } })).toEqual({
      launch: { name: 'guest' },
    });
    expect(
      roles.acquireInput.parse({
        launch: { name: 'guest' },
        managedId: 'managed-row',
      }),
    ).toEqual({ launch: { name: 'guest' }, managedId: 'managed-row' });
    expect(
      roles.acquireInput.safeParse({ launch: { name: 'guest' }, managedId: 1 })
        .success,
    ).toBe(false);
    expect(
      roles.bootstrapInput.parse({
        resource: { name: 'guest' },
        bootstrapPublicKey: 'ssh-rsa public-key',
      }),
    ).toEqual({
      resource: { name: 'guest' },
      bootstrapPublicKey: 'ssh-rsa public-key',
    });
    expect(
      roles.resourceInput.safeParse({ resource: { value: { name: 'guest' } } })
        .success,
    ).toBe(false);
    expect(
      roles.execInput.safeParse({
        resource: { name: 'guest' },
        argv: ['true'],
        unauthorized: true,
      }).success,
    ).toBe(false);
    expect(
      roles.acquireResult.safeParse({
        kind: 'bound',
        resource: {
          contributionRef: {
            pluginId: 'happier.machine-test',
            localId: 'guest',
          },
          schemaVersion: 1,
          value: { wrong: true },
        },
      }).success,
    ).toBe(false);
    expect(
      MachineProvisionerAcquireResultV1Schema.safeParse({
        kind: 'bound',
        resource: {
          contributionRef: {
            pluginId: 'happier.machine-test',
            localId: 'guest',
          },
          schemaVersion: 1,
          value: { name: 'guest' },
        },
      }).success,
    ).toBe(true);
    expect(
      MachineProvisionerBootstrapCarrierV1Schema.safeParse({
        kind: 'native',
        transport: {
          contributionRef: {
            pluginId: 'happier.machine-test',
            localId: 'guest',
          },
          schemaVersion: 1,
        },
        resource: {},
      }).success,
    ).toBe(false);
  });
  it('retains declared native normalization and drops only stored extras', async () => {
    const native = defineProtocolObject(
      {
        name: defineProtocolString(),
        nested: defineProtocolObject(
          { image: defineProtocolString() },
          { policy: 'closed' },
        ),
      },
      { policy: 'closed' },
    );
    const normalized = createProtocolComposableSchema(
      native.jsonSchema,
      (value) => {
        const parsed = native.safeParse(value);
        return parsed.success
          ? {
              success: true,
              data: { ...parsed.data, name: parsed.data.name.toLowerCase() },
            }
          : parsed;
      },
    );
    const roles = defineMachineProvisionerSchemas({
      launch: native,
      resource: normalized,
    });
    const result = roles.acquireResult.parse({
      kind: 'bound',
      resource: {
        contributionRef: { pluginId: 'happier.machine-test', localId: 'guest' },
        schemaVersion: 1,
        value: { name: 'GUEST', nested: { image: 'linux' } },
      },
    });
    expect(result.kind === 'bound' && result.resource.value).toEqual({
      name: 'guest',
      nested: { image: 'linux' },
    });
    const stored = await prepareMachineProvisionerStoredSchemas({
      launch: native,
      resource: normalized,
    });
    const extra = {
      name: 'GUEST',
      nested: { image: 'linux', future: true },
      future: true,
    };
    expect(roles.resourceInput.safeParse({ resource: extra }).success).toBe(
      false,
    );
    expect(stored.resourceStored.parse(extra)).toEqual({
      name: 'guest',
      nested: { image: 'linux' },
    });
    expect(
      stored.launchStored.safeParse({ name: 'guest', nested: { image: 1 } })
        .success,
    ).toBe(false);
  });

  it('admits strict accepted destroy custody only through the declared native operation schema', () => {
    const native = defineProtocolObject(
      { id: defineProtocolString({ minLength: 1 }) },
      { policy: 'closed' },
    );
    const reconciliation =
      provisioners.defineMachineProvisionerReconciliationSchemas({
        launch: native,
        resource: native,
        nativeOperation: native,
      });
    const accepted = {
      kind: 'accepted',
      nativeOperationRef: {
        contributionRef: {
          pluginId: 'happier.machine-test',
          localId: 'guest',
        },
        schemaVersion: 1,
        value: { id: 'delete-operation-1' },
      },
    };

    expect(reconciliation.destroyResult.parse(accepted)).toEqual(accepted);
    expect(
      reconciliation.destroyResult.safeParse({
        ...accepted,
        nativeOperationRef: {
          ...accepted.nativeOperationRef,
          value: { id: 'delete-operation-1', future: true },
        },
      }).success,
    ).toBe(false);
    expect(
      reconciliation.destroyResult.safeParse({
        ...accepted,
        nativeOperationRef: {
          ...accepted.nativeOperationRef,
          value: { id: 1 },
        },
      }).success,
    ).toBe(false);
  });

});
