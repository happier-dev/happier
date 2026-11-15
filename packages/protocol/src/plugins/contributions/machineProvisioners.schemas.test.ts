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
import { ManagedControllerIntentReportV1Schema, ManagedControllerReportV1Schema } from '../../machines/managed/actionsV1.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from './catalog.js';

it('admits optional preparation declarations and resolves their three same-plugin roles', () => {
  const descriptor = nativeDurationManifest().contributes.machineProvisioners[0]!;
  const native = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' }).jsonSchema;
  const preparation = { inputSchema: native, artifactSchema: native, nativeOperationSchema: native, artifactLaunchPath: 'name',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } };
  const parsed = provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...descriptor, preparation });
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(provisioners.readMachineProvisionerActionRolesV1(parsed.data)).toEqual(expect.arrayContaining([
    { role: 'preparationBuild', action: 'prepare-build' },
    { role: 'preparationInspect', action: 'prepare-inspect' },
    { role: 'preparationDestroy', action: 'prepare-destroy' },
  ]));
  expect(provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...descriptor,
    preparation: { ...preparation, inputSchema: { type: 'object' } } }).success).toBe(false);
});

it('validates preparation payloads and retains native identity for every uncertain result', () => {
  const input = defineProtocolObject({ dockerfileContent: defineProtocolString() }, { policy: 'closed' });
  const artifact = defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' });
  const nativeOperation = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
  const roles = provisioners.defineMachineProvisionerPreparationSchemas({ input, artifact, nativeOperation });
  const reference = { contributionRef: { pluginId: 'test.preparation', localId: 'guest' }, schemaVersion: 1 };
  const artifactRef = { ...reference, value: { id: 'snapshot-1' } };
  const nativeOperationRef = { ...reference, value: { name: 'build-1' } };
  const cases = [
    [roles.buildInput, [{ operationId: 'operation-1', input: { dockerfileContent: 'FROM scratch' } }]],
    [roles.inspectInput, [{ nativeOperation: nativeOperationRef },
      { operationId: 'operation-1', input: { dockerfileContent: 'FROM scratch' } }]],
    [roles.destroyInput, [{ artifact: artifactRef }, { nativeOperation: nativeOperationRef },
      { artifact: artifactRef, nativeOperation: nativeOperationRef }]],
    [roles.buildResult, [{ kind: 'ready', artifact: artifactRef }, { kind: 'pending', nativeOperationRef },
      { kind: 'refused', code: 'provider_refused', status: { key: 'preparation.refused', fallback: 'Refused {scope}', params: { scope: 'build' } } },
      { kind: 'unknown', code: 'post_lost', nativeOperationRef }]],
    [roles.inspectResult, [{ kind: 'ready', artifact: artifactRef }, { kind: 'pending', nativeOperationRef },
      { kind: 'failed', code: 'build_failed', nativeOperationRef }, { kind: 'absent' },
      { kind: 'unknown', code: 'get_lost', nativeOperationRef }]],
    [roles.destroyResult, [{ kind: 'confirmed' }, { kind: 'pending', nativeOperationRef },
      { kind: 'refused', code: 'wrong_organization' }, { kind: 'unknown', code: 'delete_lost', nativeOperationRef }]],
  ] as const;
  for (const [schema, values] of cases) {
    const validate = compilePluginJsonSchema(schema.jsonSchema);
    for (const value of values) {
      expect(schema.parse(value)).toEqual(value);
      expect(validate(value)).toBe(true);
      expect(schema.safeParse({ ...value, vendorErrorReason: 'private log' }).success).toBe(false);
      expect(validate({ ...value, vendorErrorReason: 'private log' })).toBe(false);
    }
  }
  for (const schema of [roles.buildResult, roles.inspectResult, roles.destroyResult]) {
    expect(schema.safeParse({ kind: 'unknown', code: 'lost' }).success).toBe(false);
    expect(compilePluginJsonSchema(schema.jsonSchema)({ kind: 'unknown', code: 'lost' })).toBe(false);
  }
  for (const schema of [roles.buildResult, roles.destroyResult]) {
    expect(schema.safeParse({ kind: 'refused', code: 'provider_refused', status: 403 }).success).toBe(false);
    expect(compilePluginJsonSchema(schema.jsonSchema)({ kind: 'refused', code: 'provider_refused', status: 403 })).toBe(false);
  }
  for (const value of [{}, { artifact: { ...artifactRef, schemaVersion: 0 } },
    { artifact: { ...artifactRef, contributionRef: { pluginId: 'bad/id', localId: 'guest' } } },
    { nativeOperation: { ...nativeOperationRef, value: { id: 'wrong-native-shape' } } }]) {
    expect(roles.destroyInput.safeParse(value).success).toBe(false);
    expect(compilePluginJsonSchema(roles.destroyInput.jsonSchema)(value)).toBe(false);
  }
  expect(roles.buildInput.safeParse({ operationId: 'op', input: { dockerfileContent: 'FROM scratch', credential: 'forbidden' } }).success).toBe(false);
  expect(roles.buildResult.safeParse({ kind: 'ready', artifact: nativeOperationRef }).success).toBe(false);
});

it('admits preparation Actions only with canonical schemas, existing local references and a safe inspect role', () => {
  const manifest = nativeDurationManifest();
  const nativeValue = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
  // Portable provider declarations may use document-local references. Embedding
  // a role must keep those references scoped to the declared native value.
  const native = createProtocolComposableSchema<{ name: string }, { name: string }>({ type: 'object',
    properties: { name: { $ref: '#/definitions/name' } }, required: ['name'], additionalProperties: false,
    definitions: { name: { type: 'string' } },
  }, value => nativeValue.safeParse(value));
  const roles = provisioners.defineMachineProvisionerPreparationSchemas({ input: native, artifact: native, nativeOperation: native });
  const descriptor = manifest.contributes.machineProvisioners[0]!;
  const preparation = { inputSchema: native.jsonSchema, artifactSchema: native.jsonSchema, nativeOperationSchema: native.jsonSchema, artifactLaunchPath: 'name',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } };
  const action = manifest.contributes.actions[0]!;
  const prepared = { ...manifest, contributes: { ...manifest.contributes,
    machineProvisioners: [{ ...descriptor, preparation }], actions: [...manifest.contributes.actions,
      { ...action, id: 'prepare-build', inputSchema: roles.buildInput.jsonSchema, resultSchema: roles.buildResult.jsonSchema },
      { ...action, id: 'prepare-inspect', inputSchema: roles.inspectInput.jsonSchema, resultSchema: roles.inspectResult.jsonSchema },
      { ...action, id: 'prepare-destroy', inputSchema: roles.destroyInput.jsonSchema, resultSchema: roles.destroyResult.jsonSchema },
    ] } };
  const admitted = PluginManifestV2Schema.parse(prepared);
  const ref = { contributionRef: { pluginId: manifest.id, localId: descriptor.id }, schemaVersion: 1, value: { name: 'build-1' } };
  for (const [schema, value] of [
    [roles.buildInput, { operationId: 'operation-1', input: { name: 'build-1' } }],
    [roles.buildResult, { kind: 'unknown', code: 'post_lost', nativeOperationRef: ref }],
    [roles.inspectInput, { nativeOperation: ref }],
    [roles.inspectResult, { kind: 'ready', artifact: ref }],
    [roles.destroyInput, { artifact: ref }],
    [roles.destroyResult, { kind: 'pending', nativeOperationRef: ref }],
  ] as const) {
    expect(compilePluginJsonSchema(schema.jsonSchema)(value)).toBe(true);
  }
  const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === 'machineProvisioners');
  expect(family?.extractReferences(admitted.contributes.machineProvisioners![0]!).filter(reference =>
    typeof reference.reference === 'string' && reference.reference.startsWith('prepare-'))).toEqual([
    { targetFamily: 'actions', reference: 'prepare-build', path: ['preparation', 'actions', 'build'], allowQualifiedCrossPlugin: false },
    { targetFamily: 'actions', reference: 'prepare-inspect', path: ['preparation', 'actions', 'inspect'], allowQualifiedCrossPlugin: false },
    { targetFamily: 'actions', reference: 'prepare-destroy', path: ['preparation', 'actions', 'destroy'], allowQualifiedCrossPlugin: false },
  ]);
  expect(provisioners.isManagedProvisionerOperationActionForRootV1('machines.managed.acquire',
    { pluginId: manifest.id, localId: 'prepare-build' }, admitted)).toBe(true);
  expect(provisioners.isManagedProvisionerOperationActionForRootV1('machines.managed.acquire',
    { pluginId: 'test.other-provider', localId: 'prepare-build' }, admitted)).toBe(false);
  for (const actions of [prepared.contributes.actions.filter(candidate => candidate.id !== 'prepare-build'),
    prepared.contributes.actions.map(candidate => candidate.id === 'prepare-inspect' ? { ...candidate, dangerLevel: 'destructive' } : candidate),
    prepared.contributes.actions.map(candidate => candidate.id === 'prepare-build' ? { ...candidate, resultSchema: native.jsonSchema } : candidate)]) {
    expect(PluginManifestV2Schema.safeParse({ ...prepared, contributes: { ...prepared.contributes, actions } }).success).toBe(false);
  }
  expect(provisioners.readMachineProvisionerActionRolesV1(descriptor).some(binding => binding.role.startsWith('preparation'))).toBe(false);
});

it('admits a preparation artifact path to complete launch choices and rejects undeclared mapping paths', () => {
  const descriptor = nativeDurationManifest().contributes.machineProvisioners[0]!;
  const launch = defineProtocolObject({ timeoutMs: defineProtocolNumber({ integer: true }) }, { policy: 'closed' });
  const artifact = defineProtocolObject({ launch, id: defineProtocolString() }, { policy: 'closed' });
  const preparation = { inputSchema: launch.jsonSchema, artifactSchema: artifact.jsonSchema,
    nativeOperationSchema: launch.jsonSchema, artifactLaunchPath: 'launch',
    actions: { build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' } };
  expect(provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...descriptor, preparation }).success).toBe(true);
  expect(provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...descriptor,
    preparation: { ...preparation, artifactLaunchPath: 'missing.path' } }).success).toBe(false);
  const selected = { pluginId: 'test.preparation', localId: descriptor.id };
  const parsed = provisioners.MachineProvisionerContributionV1Schema.parse({ ...descriptor, preparation });
  const reference = { contributionRef: selected, schemaVersion: descriptor.schemaVersion,
    value: { id: 'snapshot-1', launch: { timeoutMs: 60000 } } };
  expect(provisioners.readMachineProvisionerPreparedLaunchV1({ provisioner: selected, descriptor: parsed, artifact: reference }))
    .toEqual({ success: true, data: { timeoutMs: 60000 } });
  for (const invalid of [
    { ...reference, contributionRef: { ...selected, pluginId: 'test.other' } },
    { ...reference, contributionRef: { ...selected, localId: 'other' } },
    { ...reference, schemaVersion: descriptor.schemaVersion + 1 },
    { ...reference, value: { id: 42, launch: { timeoutMs: 60000 } } },
    { ...reference, value: { id: 'snapshot-1', launch: { timeoutMs: 0 } } },
    { ...reference, value: { id: 'snapshot-1', launch: {} } },
  ]) {
    expect(provisioners.readMachineProvisionerPreparedLaunchV1({ provisioner: selected, descriptor: parsed, artifact: invalid }).success).toBe(false);
  }
  const nativeOperation = { contributionRef: selected, schemaVersion: descriptor.schemaVersion, value: { timeoutMs: 60000 } };
  expect(provisioners.readMachineProvisionerPreparationReferenceV1({ provisioner: selected, descriptor: parsed,
    reference: nativeOperation, kind: 'nativeOperation' }).success).toBe(true);
  expect(provisioners.readMachineProvisionerPreparationReferenceV1({ provisioner: selected, descriptor: parsed,
    reference: { ...nativeOperation, contributionRef: { ...selected, pluginId: 'test.other' } }, kind: 'nativeOperation' }).success).toBe(false);
  expect(provisioners.readMachineProvisionerPreparationReferenceV1({ provisioner: selected, descriptor: parsed,
    reference: { ...nativeOperation, value: { timeoutMs: 'invalid' } }, kind: 'nativeOperation' }).success).toBe(false);
});

it('resolves declared local launch variants independently of billing and native transport', () => {
  const descriptor = nativeDurationManifest().contributes.machineProvisioners[0]!;
  const local = provisioners.MachineProvisionerContributionV1Schema.parse({ ...descriptor,
    sessionPlacement: { kind: 'controller-local', when: { op: 'eq', path: 'timeoutMs', value: 60000 }, supportsAgentNativeSandbox: true },
  });
  expect(provisioners.readMachineProvisionerSessionPlacementV1(local, { timeoutMs: 60000 })?.kind).toBe('controller-local');
  expect(provisioners.readMachineProvisionerAgentNativeSandboxSupportV1(local, { timeoutMs: 60000 })).toBe(true);
  expect(provisioners.readMachineProvisionerSessionPlacementV1(local, { timeoutMs: 120000 })).toBeNull();
  expect(provisioners.readMachineProvisionerAgentNativeSandboxSupportV1(local, { timeoutMs: 120000 })).toBe(false);
  expect(provisioners.readMachineProvisionerSessionPlacementV1(descriptor, {})).toBeNull();
  const remote = provisioners.MachineProvisionerContributionV1Schema.parse({ ...descriptor,
    sessionPlacement: { kind: 'remote', supportsAgentNativeSandbox: true },
  });
  expect(provisioners.readMachineProvisionerSessionPlacementV1(remote, {})?.kind).toBe('remote');
  expect(provisioners.readMachineProvisionerAgentNativeSandboxSupportV1(remote, {})).toBe(true);
  expect(provisioners.readMachineProvisionerAgentNativeSandboxSupportV1(descriptor, {})).toBe(false);
});

it('rejects placement predicates referring to undeclared launch inputs at contribution admission', () => {
  const descriptor = nativeDurationManifest().contributes.machineProvisioners[0]!;
  expect(provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...descriptor,
    sessionPlacement: { kind: 'controller-local', when: { op: 'truthy', path: 'undeclared' } },
  }).success).toBe(false);
});

it('admits an exact snapshot operand and preserves truthful root-disk coverage through the public role', () => {
  const native = defineProtocolObject({ id: defineProtocolNumber({ integer: true, minimum: 1 }) }, { policy: 'closed' });
  const roles = provisioners.defineMachineProvisionerSchemas({ launch: native, resource: native });
  const input = { resource: { id: 42 }, expectedMachineRevision: 3, label: 'Before replacement', reason: 'Replace data disk' };
  expect(roles.snapshotInput.parse(input)).toEqual(input);
  expect(roles.snapshotInput.safeParse({ ...input, parentActionId: 'invented' }).success).toBe(false);
  const result = { kind: 'confirmed', snapshotId: 'native-7', coverage: { rootDisk: true, attachedVolumes: false },
    consistency: 'running', cost: { kind: 'billed', source: 'https://provider.example/pricing' } };
  expect(provisioners.MachineProvisionerSnapshotResultV1Schema.parse(result)).toEqual(result);
  expect(compilePluginJsonSchema(provisioners.MachineProvisionerSnapshotResultV1Schema.jsonSchema)(result)).toBe(true);
  expect(provisioners.MachineProvisionerSnapshotResultV1Schema.safeParse({ ...result,
    coverage: { rootDisk: true } }).success).toBe(false);
});

it('retains unsupported native snapshots as a typed outcome instead of success or refusal', () => {
  const result = { kind: 'unsupported', code: 'native_snapshot_unsupported' };
  const schema = provisioners.MachineProvisionerSnapshotResultV1Schema;
  expect(schema.parse(result)).toEqual(result);
  expect(compilePluginJsonSchema(schema.jsonSchema)(result)).toBe(true);
  expect(schema.safeParse({ ...result, snapshotId: 'invented' }).success).toBe(false);
});

it('carries configuration-specific prerequisites through the closed options read and authored role', () => {
  const prerequisite = { requirement: { kind: 'systemTool', id: 'devcontainer' }, status: 'unavailable',
    repairAction: { action: { pluginId: 'fixture.compute', localId: 'install' }, input: { tool: 'devcontainer' } } };
  const result = { code: 'provider_unavailable', base: { launch: {}, available: false, prerequisites: [prerequisite] },
    dimensions: { size: [], image: [], location: [], network: [], duration: [] } };
  expect(provisioners.MachineProvisionerOptionsResultV1Schema.parse(result)).toEqual(result);
  const schema = provisioners.MachineProvisionerOptionsResultProtocolV1Schema;
  expect(schema.parse(result)).toEqual(result);
  expect(compilePluginJsonSchema(schema.jsonSchema)(result)).toBe(true);
  expect(provisioners.MachineProvisionerOptionsResultV1Schema.safeParse({ ...result,
    base: { ...result.base, prerequisites: [{ ...prerequisite, secret: 'forbidden' }] } }).success).toBe(false);
  expect(provisioners.MachineProvisionerOptionsResultV1Schema.safeParse({ dimensions: result.dimensions }).success).toBe(true);
});

it('replaces discovery prerequisites with the complete selected runtime snapshot and permits explicit clearance', () => {
  const check = provisioners.MachineProvisionerCheckResultV1Schema.parse({ available: false,
    prerequisites: [{ requirement: { kind: 'systemTool', id: 'docker' }, status: 'unavailable' }] });
  const options = provisioners.MachineProvisionerOptionsResultV1Schema.parse({ base: { launch: {}, available: false,
    prerequisites: [{ requirement: { kind: 'systemTool', id: 'podman' }, status: 'unavailable' }] },
    dimensions: { size: [], image: [], location: [], network: [], duration: [] } });
  expect(provisioners.readMachineProvisionerPrerequisitesV1(check, options)).toEqual(options.base?.prerequisites);
  expect(provisioners.readMachineProvisionerPrerequisitesV1(check, { ...options, base: { launch: {}, prerequisites: [] } })).toEqual([]);
  expect(provisioners.readMachineProvisionerPrerequisitesV1(check, { ...options, base: { launch: {} } })).toEqual(check.prerequisites);
});

it('carries only the generated guest public host key through closed acquire and bootstrap roles', () => {
  const native = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
  const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
  const guestHostPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const acquireWithPin = { launch: { name: 'guest' }, guestHostPublicKey };
  const bootstrapWithPin = { resource: { name: 'guest' }, guestHostPublicKey };
  expect(roles.acquireInput.parse(acquireWithPin)).toEqual(acquireWithPin);
  expect(compilePluginJsonSchema(roles.acquireInput.jsonSchema)(acquireWithPin)).toBe(true);
  expect(roles.bootstrapInput.parse(bootstrapWithPin)).toEqual(bootstrapWithPin);
  expect(compilePluginJsonSchema(roles.bootstrapInput.jsonSchema)(bootstrapWithPin)).toBe(true);
  expect(roles.acquireInput.safeParse({ ...acquireWithPin, guestHostPrivateKey: 'private' }).success).toBe(false);
  expect(roles.bootstrapInput.safeParse({ ...bootstrapWithPin, guestHostPublicKey: `${guestHostPublicKey}\nruncmd: injected` }).success).toBe(false);
});

it('carries closed pending deletion through authored roles and the strict Home intent report', () => {
  const empty = defineProtocolObject({}, { policy: 'closed' });
  const roles = provisioners.defineMachineProvisionerReconciliationSchemas({ launch: empty, resource: empty, nativeOperation: empty });
  const result = roles.destroyResult.parse({ kind: 'pending' });
  expect(compilePluginJsonSchema(roles.destroyResult.jsonSchema)(result)).toBe(true);
  expect(provisioners.MachineProvisionerDestroyResultV1Schema.parse(result)).toEqual({ kind: 'pending' });
  expect(ManagedControllerIntentReportV1Schema.parse({ homeId: 'home', managedId: 'managed', requestId: 'delete',
    expectedIntentRevision: 1, controller: { machineId: 'controller', installationId: 'installation' }, result }).result).toEqual(result);
  for (const invalid of [{ kind: 'pending', code: 'provider_unavailable' },
    { kind: 'pending', nativeCause: { httpStatusClass: '5xx' } }]) {
    expect(roles.destroyResult.safeParse(invalid).success).toBe(false);
    expect(compilePluginJsonSchema(roles.destroyResult.jsonSchema)(invalid)).toBe(false);
  }
  expect(provisioners.MachineProvisionerPowerResultV1Schema.safeParse(result).success).toBe(false);
});

it('carries positive accepted startup from the authored acquisition result through the strict Home report reader', () => {
  const roles = defineMachineProvisionerSchemas({ launch: defineProtocolObject({}, { policy: 'closed' }),
    resource: defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' }) });
  const result = { kind: 'bound', resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'guest' },
    schemaVersion: 1, value: { name: 'accepted-start' } }, startPending: true };
  const produced = roles.acquireResult.parse(result);
  expect(produced).toEqual(result);
  expect(compilePluginJsonSchema(roles.acquireResult.jsonSchema)(produced)).toBe(true);
  const report = ManagedControllerReportV1Schema.parse({ homeId: 'home', managedId: 'managed', requestId: 'creation',
    expectedIntentRevision: 1, controller: { machineId: 'controller', installationId: 'installation' }, result: produced });
  expect(report.result).toEqual(result);
  expect(roles.acquireResult.safeParse({ ...result, startPending: false }).success).toBe(false);
  expect(roles.acquireResult.safeParse({ ...result, startPending: { nativeMessage: 'private' } }).success).toBe(false);
});

it('admits declared native header delivery and demanded qualification without granting undeclared roles', () => {
  const descriptor = nativeDurationManifest().contributes.machineProvisioners[0]!;
  const native = { ...descriptor, nativeCredentialDelivery: {
    apply: 'native-apply', transports: ['https_headers'], preservesEndpoint: true, perBindingMatching: true,
  } };
  const parsed = provisioners.MachineProvisionerContributionV1Schema.safeParse(native);
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(provisioners.readMachineProvisionerActionRolesV1(parsed.data))
    .toContainEqual({ role: 'nativeCredentialApply', action: 'native-apply' });
  expect(provisioners.MachineProvisionerCheckResultV1Schema.safeParse({ available: true,
    nativeCredentialDelivery: { status: 'supported' } }).success).toBe(true);
  expect(provisioners.MachineProvisionerCheckResultV1Schema.safeParse({ available: true,
    nativeCredentialDelivery: { status: 'supported', credential: 'forbidden' } }).success).toBe(false);
  expect(provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...native,
    nativeCredentialDelivery: { ...native.nativeCredentialDelivery, arbitraryPolicy: true } }).success).toBe(false);
});

it('admits the native apply role only with its exact closed resource value schema', () => {
  const base = nativeDurationManifest();
  const descriptor = base.contributes.machineProvisioners[0]!;
  const authored = defineMachineProvisionerSchemas({
    launch: defineProtocolObject({}, { policy: 'closed' }),
    resource: defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' }),
  }).nativeCredentialApplyInput;
  const inputSchema = authored.jsonSchema;
  const manifest = { ...base, contributes: { ...base.contributes,
    machineProvisioners: [{ ...descriptor, nativeCredentialDelivery: {
      apply: 'native-apply', transports: ['https_headers'], preservesEndpoint: true, perBindingMatching: true,
    } }],
    actions: [...base.contributes.actions, { ...base.contributes.actions[0], id: 'native-apply',
      dangerLevel: 'externalSideEffect', inputSchema,
      resultSchema: provisioners.MachineProvisionerNativeCredentialApplyResultV1Schema.jsonSchema,
    }],
  } };
  const result = PluginManifestV2Schema.safeParse(manifest);
  expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  const validate = compilePluginJsonSchema(authored.jsonSchema);
  const input = { resource: { contributionRef: { pluginId: base.id, localId: descriptor.id },
    schemaVersion: 1, value: { name: 'guest' } }, baseline: { kind: 'allow-all' }, bindings: [] };
  expect(validate(input)).toBe(true);
  expect(authored.safeParse(input).success).toBe(true);
  expect(authored.safeParse({ ...input, resource: { ...input.resource, value: { name: 'guest', policy: 'unadmitted' } } }).success).toBe(false);
  expect(validate({ ...input, resource: { ...input.resource, value: { name: 'guest', policy: 'unadmitted' } } })).toBe(false);
});

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
  it('retains older optional result snapshots while rejecting changed retained fields and native values', () => {
    const manifest = nativeDurationManifest();
    const snapshot = structuredClone(manifest);
    const check = snapshot.contributes.actions.find(action => action.id === 'check')!;
    delete check.resultSchema.properties!.nativeCredentialDelivery;
    const inspect = snapshot.contributes.actions.find(action => action.id === 'inspect')!;
    delete inspect.resultSchema.properties!.nativeCause;
    const options = snapshot.contributes.actions.find(action => action.id === 'options')!.resultSchema;
    delete options.properties!.base!.properties!.billing;
    for (const dimension of Object.values(options.properties!.dimensions!.properties!)) delete dimension.items!.properties!.billing;
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

  it('admits conditional credential routing without acquisition hostAccess permission proof', () => {
    const base = nativeDurationManifest();
    const requirement = { purpose: 'native-auth', optionalWhen: { op: 'eq' as const, path: 'timeoutMs', value: 1000 } };
    const manifest = { ...base, contributes: { ...base.contributes,
      machineProvisioners: [{ ...base.contributes.machineProvisioners[0], credentialPurposeRequirements: [requirement] }],
    } };
    const parsed = PluginManifestV2Schema.safeParse(manifest);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    const descriptor = provisioners.MachineProvisionerContributionV1Schema.parse(manifest.contributes.machineProvisioners[0]);
    expect(provisioners.isMachineProvisionerCredentialPurposeRequiredV1(descriptor, 'native-auth', { timeoutMs: 1000 })).toBe(false);
    expect(provisioners.isMachineProvisionerCredentialPurposeRequiredV1(descriptor, 'native-auth', { timeoutMs: 2000 })).toBe(true);
    expect(provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...descriptor,
      credentialPurposeRequirements: [{ ...requirement, optionalWhen: { ...requirement.optionalWhen, path: 'missing' } }],
    }).success).toBe(false);
  });

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
  it('admits guest platforms on base and dimension facts through both public options readers', () => {
    for (const guestPlatform of ['linux', 'darwin', 'windows']) {
      const options = { base: { launch: {}, guestPlatform }, dimensions: {
        size: [{ id: 'small', title: 'Small', assignments: [], guestPlatform }],
        image: [{ id: 'native', title: 'Native', assignments: [], guestPlatform }],
        location: [], network: [], duration: [],
      } };
      expect(provisioners.MachineProvisionerOptionsResultV1Schema.parse(options)).toEqual(options);
      expect(provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse(options)).toEqual(options);
    }
    expect(provisioners.MachineProvisionerOptionsResultV1Schema.safeParse({ base: { launch: {}, guestPlatform: 'win32' },
      dimensions: { size: [], image: [], location: [], network: [], duration: [] } }).success).toBe(false);
  });
  it('admits optional enrollment roles on base and dimension facts through both public options readers', () => {
    for (const enrollmentRole of ['server', 'personal', 'sandbox']) {
      const options = { base: { launch: {}, enrollmentRole }, dimensions: {
        size: [{ id: 'small', title: 'Small', assignments: [], enrollmentRole }],
        image: [{ id: 'native', title: 'Native', assignments: [], enrollmentRole }],
        location: [], network: [], duration: [],
      } };
      expect(provisioners.MachineProvisionerOptionsResultV1Schema.parse(options)).toEqual(options);
      expect(provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse(options)).toEqual(options);
    }
    expect(provisioners.MachineProvisionerOptionsResultV1Schema.safeParse({ base: { launch: {}, enrollmentRole: 'guessed' },
      dimensions: { size: [], image: [], location: [], network: [], duration: [] } }).success).toBe(false);
  });
  it('projects only declared enrollment role facts and refuses contradictory selected declarations without an ambiguous role', () => {
    const launch = defineProtocolObject({}, { policy: 'closed' });
    const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
    const project = (options: provisioners.MachineProvisionerOptionsResultV1, selection: provisioners.MachineProvisionerSelectionV1 = {}) =>
      provisioners.projectMachineProvisionerSelectionV1({ options, selection, launchSchema: launch.jsonSchema });
    expect(project({ base: { launch: {} }, dimensions })).not.toHaveProperty('enrollmentRole');
    const server = { base: { launch: {}, enrollmentRole: 'server' as const }, dimensions };
    expect(project(server)).toMatchObject({ kind: 'ready', enrollmentRole: 'server' });
    const sandbox = { id: 'sandbox', title: 'Sandbox', assignments: [], enrollmentRole: 'sandbox' as const };
    const personal = { ...sandbox, id: 'personal', enrollmentRole: 'personal' as const };
    const selected = { base: { launch: {} }, dimensions: { ...dimensions, image: [sandbox, personal] } };
    expect(project(selected)).not.toHaveProperty('enrollmentRole');
    expect(project(selected, { image: 'sandbox' })).toMatchObject({ kind: 'ready', enrollmentRole: 'sandbox' });
    expect(project(selected, { image: 'personal' })).toMatchObject({ kind: 'ready', enrollmentRole: 'personal' });
    const baseConflict = project({ ...server, dimensions: selected.dimensions }, { image: 'sandbox' });
    expect(baseConflict).toMatchObject({ kind: 'invalid', code: 'conflicting_enrollment_role' });
    expect(baseConflict).not.toHaveProperty('enrollmentRole');
    const optionConflict = project({ ...selected, dimensions: { ...selected.dimensions, size: [personal] } },
      { size: 'personal', image: 'sandbox' });
    expect(optionConflict).toMatchObject({ kind: 'invalid', code: 'conflicting_enrollment_role' });
    expect(optionConflict).not.toHaveProperty('enrollmentRole');
    const matching = { ...sandbox, enrollmentRole: 'server' as const };
    expect(project({ ...server, dimensions: { ...dimensions, image: [matching] } }, { image: 'sandbox' }))
      .toMatchObject({ kind: 'ready', enrollmentRole: 'server' });
    const retainedConflict = project({ ...server, dimensions: { ...dimensions, size: [sandbox], image: [matching] } },
      { size: 'sandbox', image: 'sandbox' });
    expect(retainedConflict).toMatchObject({ kind: 'invalid', code: 'conflicting_enrollment_role' });
    expect(retainedConflict).not.toHaveProperty('enrollmentRole');
  });
  it('projects only declared guest platform facts and refuses contradictory selected declarations', () => {
    const launch = defineProtocolObject({}, { policy: 'closed' });
    const dimensions = { size: [], image: [], location: [], network: [], duration: [] };
    const project = (options: provisioners.MachineProvisionerOptionsResultV1, selection: provisioners.MachineProvisionerSelectionV1 = {}) =>
      provisioners.projectMachineProvisionerSelectionV1({ options, selection, launchSchema: launch.jsonSchema });
    expect(project({ base: { launch: {} }, dimensions })).not.toHaveProperty('guestPlatform');
    const linux = { base: { launch: {}, guestPlatform: 'linux' as const }, dimensions };
    expect(project(linux)).toMatchObject({ kind: 'ready', guestPlatform: 'linux' });
    const image = { id: 'native', title: 'Native', assignments: [], guestPlatform: 'darwin' as const };
    const selected = { base: { launch: {} }, dimensions: { ...dimensions, image: [image] } };
    expect(project(selected)).not.toHaveProperty('guestPlatform');
    expect(project(selected, { image: 'native' })).toMatchObject({ kind: 'ready', guestPlatform: 'darwin' });
    expect(project({ ...linux, dimensions: selected.dimensions }, { image: 'native' }))
      .toMatchObject({ kind: 'invalid', code: 'conflicting_guest_platform' });
    expect(project({ ...selected, dimensions: { ...selected.dimensions, size: [
      { id: 'small', title: 'Small', assignments: [], guestPlatform: 'windows' as const },
    ] } }, { size: 'small', image: 'native' })).toMatchObject({ kind: 'invalid', code: 'conflicting_guest_platform' });
    expect(project({ ...linux, dimensions: { ...dimensions, image: [{ ...image, guestPlatform: 'linux' as const }] } }, { image: 'native' }))
      .toMatchObject({ kind: 'ready', guestPlatform: 'linux' });
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
  it('preserves a native refusal and its field through incomplete and invalid launch projections', () => {
    const launch = defineProtocolObject({ image: defineProtocolString() }, { policy: 'closed' });
    const unavailableReason = { code: 'vz_driver_unavailable', status: { key: 'native.vz', fallback: 'VZ unavailable' }, fieldPath: 'vmType' };
    const options = provisioners.MachineProvisionerOptionsResultV1Schema.parse({
      base: { launch: {}, available: false, unavailableReason },
      dimensions: { size: [], image: [], location: [], network: [], duration: [] },
    });
    const project = (value: provisioners.MachineProvisionerOptionsResultV1, selection: provisioners.MachineProvisionerSelectionV1 = {}) => provisioners.projectMachineProvisionerSelectionV1({
      options: value, selection, launchSchema: launch.jsonSchema,
    });
    expect(project(options)).toMatchObject({ kind: 'unavailable', code: unavailableReason.code, unavailableReason });
    expect(provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse(options)).toEqual(options);
    const dimensionRefusal = { ...options, base: { launch: { image: 'valid' } }, dimensions: { ...options.dimensions,
      size: [{ id: 'refused', title: 'Refused', assignments: [], available: false, unavailableReason }] } };
    expect(project(dimensionRefusal, { size: 'refused' })).toMatchObject({ kind: 'unavailable', code: unavailableReason.code, unavailableReason });
    expect(project(dimensionRefusal)).not.toHaveProperty('unavailableReason');
    expect(project({ ...options, base: { ...options.base!, launch: [] },
      dimensions: { ...options.dimensions, size: [{ id: 'bad', title: 'Bad', assignments: [{ path: 'image', value: 'image' }] }] } },
      { size: 'bad' })).toMatchObject({ kind: 'invalid', code: 'invalid_launch', unavailableReason });
    expect(provisioners.MachineProvisionerOptionsResultV1Schema.safeParse({ ...options,
      base: { ...options.base, unavailableReason: { ...unavailableReason, content: 'forbidden' } } }).success).toBe(false);
  });
  it('projects selected compute and storage billing without conflating a retained disk with stopped compute', () => {
    const launch = defineProtocolObject({ kind: defineProtocolString() }, { policy: 'closed' });
    const billed = { location: 'cloud', stoppedBilling: 'billed' } as const;
    const storageOnly = { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [
      { amount: '0.08', currency: 'USD', unit: 'GB-month', source: 'https://native.example/pricing', observedAt: 1 },
    ] } as const;
    const options = provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse({
      base: { launch: {}, billing: { location: 'cloud', stoppedBilling: 'unknown' } },
      dimensions: { size: [], image: [
        { id: 'box', title: 'Box', assignments: [{ path: 'kind', value: 'box' }], billing: billed },
        { id: 'computer', title: 'Computer', assignments: [{ path: 'kind', value: 'computer' }], billing: storageOnly },
      ], location: [], network: [], duration: [] },
    });
    const project = (selection: provisioners.MachineProvisionerSelectionV1) => provisioners.projectMachineProvisionerSelectionV1({
      options, selection, launchSchema: launch.jsonSchema,
    });
    expect(project({})).toMatchObject({ kind: 'incomplete', billing: { stoppedBilling: 'unknown' } });
    expect(project({ image: 'box' })).toMatchObject({ kind: 'ready', billing: billed });
    expect(project({ image: 'computer' })).toMatchObject({ kind: 'ready', billing: storageOnly });
    const conflicting = { ...options, dimensions: { ...options.dimensions,
      size: [{ id: 'billed', title: 'Billed', assignments: [], billing: billed }] } };
    const conflict = provisioners.projectMachineProvisionerSelectionV1({ options: conflicting,
      selection: { image: 'computer', size: 'billed' }, launchSchema: launch.jsonSchema });
    expect(conflict).toMatchObject({ kind: 'invalid', code: 'conflicting_billing' });
    expect(conflict).not.toHaveProperty('billing');
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
