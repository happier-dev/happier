import { describe, expect, it } from 'vitest';
import { createProtocolComposableSchema, defineProtocolObject, defineProtocolString } from '../actions/protocolComposableSchema.js';
import { defineMachineProvisionerSchemas, MachineProvisionerAcquireResultV1Schema, MachineProvisionerBootstrapCarrierV1Schema } from './machineProvisioners.js';
import { prepareMachineProvisionerStoredSchemas } from './machineProvisionerStoredSchemas.js';
import * as provisioners from './machineProvisioners.js';
import { RetentionCapabilitiesV1Schema } from '../../machines/managed/providerFactsV1.js';

describe('public machine provisioner role schemas', () => {
  it('admits explicit native guest homes and process configuration without confusing it with process termination', () => {
    const native = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
    const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
    const carrier = { kind: 'native', transport: { contributionRef: { pluginId: 'test.native', localId: 'guest' }, schemaVersion: 1 },
      guestHome: { homeDir: '/volume/home', happyHomeDir: '/volume/home/.happier', daemonStartup: 'native-process' } };
    expect(MachineProvisionerBootstrapCarrierV1Schema.parse(carrier)).toEqual(carrier);
    expect(MachineProvisionerBootstrapCarrierV1Schema.safeParse({ ...carrier, guestHome: { ...carrier.guestHome, extra: true } }).success).toBe(false);
    const request = { resource: { name: 'guest' }, argv: ['/volume/home/.happier/cli/current/happier', 'daemon', 'start-sync'],
      processConfig: { environment: { HOME: '/volume/home', HAPPIER_HOME_DIR: '/volume/home/.happier' } } };
    expect(roles.execInput.parse(request)).toEqual(request);
    expect(roles.execInput.safeParse({ ...request, processConfig: { ...request.processConfig, extra: true } }).success).toBe(false);
    expect(provisioners.MachineProvisionerNativeExecResultV1Schema.parse({ kind: 'process-configured' })).toEqual({ kind: 'process-configured' });
    expect(provisioners.MachineProvisionerNativeExecResultV1Schema.safeParse({ kind: 'process-configured', machineId: 'invented' }).success).toBe(false);
  });
  it('accepts an explicit native bootstrap credential without publishing private material', () => {
    const native = defineProtocolObject({}, { policy: 'closed' });
    const descriptor = {
      id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'virtual-machine',
      schemaVersion: 1, platforms: ['darwin', 'linux', 'win32'], prerequisites: [],
      launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema,
      billing: { location: 'cloud', stoppedBilling: 'unknown' }, retention: { supportedIntents: ['delete'] },
      actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
      bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
    };
    const parsed = provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...descriptor, bootstrapCredential: { kind: 'native-token' } });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('Native bootstrap credential declaration was refused');
    expect(parsed.data).toHaveProperty('bootstrapCredential', { kind: 'native-token' });
    expect(provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...descriptor,
      bootstrapCredential: { kind: 'native-token', value: 'must-not-be-public' },
    }).success).toBe(false);
    expect(provisioners.MachineProvisionerContributionV1Schema.parse(descriptor)).not.toHaveProperty('bootstrapCredential');
    const { bootstrapTransport: _nativeTransport, ...sshOnly } = descriptor;
    expect(provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...sshOnly,
      bootstrapCredential: { kind: 'native-token' },
    }).success).toBe(false);
    expect(provisioners.MachineProvisionerContributionV1Schema.safeParse({ ...descriptor,
      bootstrapCredential: { kind: 'ssh' },
    }).success).toBe(true);
  });

  it('retains labelled native choice dimensions without inventing unobserved resources', () => {
    const nativeFacts = {
      size: { id: 'small', title: 'Shared small', cpuCores: 0.5, memoryBytes: 1024 },
      image: { id: 'image-1', title: { key: 'images.linux', fallback: 'Linux' } },
      location: { id: 'region-1', title: 'Native region' },
    };
    const choice = { id: 'selected', title: 'Selected configuration', launch: { nativeSizeId: 'small' }, nativeFacts };
    expect(provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse({ choices: [choice] })).toEqual({ choices: [choice] });
    expect(provisioners.MachineProvisionerOptionsResultProtocolV1Schema.parse({ choices: [choice] }).choices[0]?.nativeFacts?.size).not.toHaveProperty('diskBytes');
    for (const size of [{ ...nativeFacts.size, memoryBytes: '1024' }, { ...nativeFacts.size, token: 'private' }]) {
      expect(provisioners.MachineProvisionerOptionsResultProtocolV1Schema.safeParse({ choices: [{ ...choice, nativeFacts: { ...nativeFacts, size } }] }).success).toBe(false);
    }
  });
  it('declares finite-only retention separately from native expiry and unsupported power', () => {
    const finite = { supportedIntents: ['delete'], finiteOnly: true };
    expect(RetentionCapabilitiesV1Schema.parse(finite)).toEqual(finite);
    expect(RetentionCapabilitiesV1Schema.parse({ ...finite, finiteOnly: false })).toEqual({ ...finite, finiteOnly: false });
    const unknown = { supportedIntents: ['delete'], nativeExpiry: { kind: 'deadline', at: 9000 } };
    expect(RetentionCapabilitiesV1Schema.parse(unknown)).toEqual(unknown);
    expect(RetentionCapabilitiesV1Schema.parse(unknown)).not.toHaveProperty('finiteOnly');
    expect(RetentionCapabilitiesV1Schema.safeParse({ ...finite, finiteOnly: 'yes' }).success).toBe(false);
  });
  it('admits only a closed replacement resource result for rebuild and validates the declared native identity', () => {
    const native = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
    const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
    const resource = { contributionRef: { pluginId: 'happier.machine-test', localId: 'guest' }, schemaVersion: 1, value: { name: 'replacement' } };
    expect(roles.rebuildInput.parse({ resource: { name: 'old' }, reviewedEffectDigest: 'reviewed-config' })).toEqual({ resource: { name: 'old' }, reviewedEffectDigest: 'reviewed-config' });
    expect(roles.rebuildInput.safeParse({ resource: { name: 'old' }, reviewedEffectDigest: 'reviewed-config', token: 'private' }).success).toBe(false);
    expect(roles.rebuildResult.parse({ kind: 'bound', resource })).toEqual({ kind: 'bound', resource });
    expect(roles.rebuildResult.safeParse({ kind: 'bound', resource: { ...resource, value: { wrong: true } } }).success).toBe(false);
    expect(roles.rebuildResult.safeParse({ kind: 'confirmed' }).success).toBe(false);
    expect(roles.rebuildResult.safeParse({ kind: 'refused', code: 'resource_mismatch' }).success).toBe(true);
    expect(roles.rebuildResult.safeParse({ kind: 'unknown', recovery: { reference: 'old', reason: 'native_rebuild_unknown' } }).success).toBe(true);
  });
  it('returns a qualified descriptive prerequisite repair without treating it as installation authority', () => {
    const prerequisite = { requirement: { kind: 'systemTool', id: { pluginId: 'happier.machine-test', localId: 'native-tool' } },
      status: 'unavailable', repairAction: { action: { pluginId: 'happier.machine-test', localId: 'repair' }, input: { machineName: 'guest' } } };
    const result = provisioners.MachineProvisionerCheckResultProtocolV1Schema.parse({ available: false, prerequisites: [prerequisite] });
    expect(result).toEqual({ available: false, prerequisites: [prerequisite] });
    expect(provisioners.MachineProvisionerCheckResultProtocolV1Schema.safeParse({ available: false, prerequisites: [{ ...prerequisite,
      repairAction: { action: 'repair', input: {} },
    }] }).success).toBe(false);
    expect(provisioners.MachineProvisionerCheckResultProtocolV1Schema.safeParse({ available: false, prerequisites: [{ ...prerequisite,
      repairAction: { ...prerequisite.repairAction, input: { invalid: undefined } },
    }] }).success).toBe(false);
  });
  it('reconciles retained handles or row correlation and validates eventual bound identity and exact cleanup inputs', async () => {
    const resource = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
    const handle = defineProtocolObject({ claimId: defineProtocolString() }, { policy: 'closed' });
    const normalized = createProtocolComposableSchema(handle.jsonSchema, value => {
      const parsed = handle.safeParse(value);
      return parsed.success ? { success: true, data: { claimId: parsed.data.claimId.toLowerCase() } } : parsed;
    });
    const reconciliation = provisioners.defineMachineProvisionerReconciliationSchemas({ launch: resource, resource, nativeOperation: normalized });
    const reference = { contributionRef: { pluginId: 'happier.machine-test', localId: 'guest' }, schemaVersion: 1 };
    expect(reconciliation.input.parse({ nativeOperation: { claimId: 'CLAIM' } })).toEqual({ nativeOperation: { claimId: 'claim' } });
    const correlation = { managedId: 'managed', requestId: 'creation', launch: { name: 'guest' } };
    expect(reconciliation.input.safeParse({ correlation }).success).toBe(true);
    expect(reconciliation.input.safeParse({ correlation: { ...correlation, launch: { name: 'guest', private: true } } }).success).toBe(false);
    expect(reconciliation.input.safeParse({ correlation: { ...correlation, requestId: '' } }).success).toBe(false);
    expect(reconciliation.input.safeParse({ nativeOperation: { claimId: 'claim' }, correlation }).success).toBe(false);
    expect(reconciliation.input.safeParse({ nativeOperation: { claimId: 'claim', token: 'private' } }).success).toBe(false);
    expect(reconciliation.input.safeParse({ resource: { name: 'guest' } }).success).toBe(false);
    expect(reconciliation.destroyInput.parse({ nativeOperation: { claimId: 'CLAIM' } })).toEqual({ nativeOperation: { claimId: 'claim' } });
    expect(reconciliation.destroyInput.parse({ resource: { name: 'guest' } })).toEqual({ resource: { name: 'guest' } });
    expect(reconciliation.destroyInput.safeParse({ nativeOperation: { claimId: 'claim' }, resource: { name: 'guest' } }).success).toBe(false);
    expect(reconciliation.destroyInput.safeParse({ nativeOperation: { claimId: 'claim', token: 'private' } }).success).toBe(false);
    const pending = reconciliation.result.parse({ kind: 'pending', nativeOperationRef: { ...reference, value: { claimId: 'CLAIM' } } });
    expect(pending.kind === 'pending' && pending.nativeOperationRef.value).toEqual({ claimId: 'claim' });
    expect(reconciliation.result.safeParse({ kind: 'pending', nativeOperationRef: { ...reference, value: { wrong: true } } }).success).toBe(false);
    expect(reconciliation.result.parse({ kind: 'bound', resource: { ...reference, value: { name: 'guest' } } })).toMatchObject({ resource: { value: { name: 'guest' } } });
    expect(reconciliation.result.safeParse({ kind: 'bound', resource: { ...reference, value: { wrong: true } } }).success).toBe(false);
    expect(defineMachineProvisionerSchemas({ launch: resource, resource }).acquireResult.safeParse({ kind: 'pending', nativeOperationRef: { ...reference, value: { claimId: 'claim' } } }).success).toBe(false);
    const readers = await prepareMachineProvisionerStoredSchemas({ launch: resource, resource, nativeOperation: normalized });
    expect(readers.nativeOperationStored.parse({ claimId: 'CLAIM', future: true })).toEqual({ claimId: 'claim' });
    expect(readers.nativeOperationStored.safeParse({ claimId: 1 }).success).toBe(false);
  });
  it('uses raw declared native values and canonical closed result envelopes', () => {
    const native = defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' });
    const roles = defineMachineProvisionerSchemas({ launch: native, resource: native });
    expect(roles.acquireInput.parse({ launch: { name: 'guest' } })).toEqual({ launch: { name: 'guest' } });
    expect(roles.acquireInput.parse({ launch: { name: 'guest' }, managedId: 'managed-row' })).toEqual({ launch: { name: 'guest' }, managedId: 'managed-row' });
    expect(roles.acquireInput.safeParse({ launch: { name: 'guest' }, managedId: 1 }).success).toBe(false);
    expect(roles.bootstrapInput.parse({ resource: { name: 'guest' }, bootstrapPublicKey: 'ssh-rsa public-key' })).toEqual({ resource: { name: 'guest' }, bootstrapPublicKey: 'ssh-rsa public-key' });
    expect(roles.resourceInput.safeParse({ resource: { value: { name: 'guest' } } }).success).toBe(false);
    expect(roles.execInput.safeParse({ resource: { name: 'guest' }, argv: ['true'], unauthorized: true }).success).toBe(false);
    expect(roles.acquireResult.safeParse({ kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine-test', localId: 'guest' }, schemaVersion: 1, value: { wrong: true } } }).success).toBe(false);
    expect(MachineProvisionerAcquireResultV1Schema.safeParse({ kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine-test', localId: 'guest' }, schemaVersion: 1, value: { name: 'guest' } } }).success).toBe(true);
    expect(MachineProvisionerBootstrapCarrierV1Schema.safeParse({ kind: 'native', transport: { contributionRef: { pluginId: 'happier.machine-test', localId: 'guest' }, schemaVersion: 1 }, resource: {} }).success).toBe(false);
  });
  it('retains declared native normalization and drops only stored extras', async () => {
    const native = defineProtocolObject({ name: defineProtocolString(), nested: defineProtocolObject({ image: defineProtocolString() }, { policy: 'closed' }) }, { policy: 'closed' });
    const normalized = createProtocolComposableSchema(native.jsonSchema, value => {
      const parsed = native.safeParse(value);
      return parsed.success ? { success: true, data: { ...parsed.data, name: parsed.data.name.toLowerCase() } } : parsed;
    });
    const roles = defineMachineProvisionerSchemas({ launch: native, resource: normalized });
    const result = roles.acquireResult.parse({ kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine-test', localId: 'guest' }, schemaVersion: 1, value: { name: 'GUEST', nested: { image: 'linux' } } } });
    expect(result.kind === 'bound' && result.resource.value).toEqual({ name: 'guest', nested: { image: 'linux' } });
    const stored = await prepareMachineProvisionerStoredSchemas({ launch: native, resource: normalized });
    const extra = { name: 'GUEST', nested: { image: 'linux', future: true }, future: true };
    expect(roles.resourceInput.safeParse({ resource: extra }).success).toBe(false);
    expect(stored.resourceStored.parse(extra)).toEqual({ name: 'guest', nested: { image: 'linux' } });
    expect(stored.launchStored.safeParse({ name: 'guest', nested: { image: 1 } }).success).toBe(false);
  });
});
