import { Session } from 'node:inspector/promises';
import { expect, it, vi } from 'vitest';
import * as documents from '../actions/protocolComposableSchema.js';
import * as strictJson from './strictJsonValue.js';
import * as equality from './jsonSchemaValues.js';
import * as provisioners from './machineProvisioners.js';
import { PluginManifestV2Schema } from '../manifest/v2.js';
import { admitDecodedPluginManifestV2 } from '../manifest/ingest.js';
import * as admittedJson from '../../json/strictJsonValue.js';

function provisionerManifest() {
  const native = documents.defineProtocolObject({ name: documents.defineProtocolString() }, { policy: 'closed' });
  const roles = provisioners.defineMachineProvisionerSchemas({ launch: native, resource: native });
  const action = { title: 'Native role', scopes: ['machine'], surfaces: ['plugin'],
    execution: { target: 'daemon' }, dangerLevel: 'safe' };
  return {
    schemaVersion: 2, id: 'test.provisioner-cost', version: '1.0.0', displayName: 'Provisioner cost',
    engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.js' },
    hostAccess: { required: [], optional: [] },
    contributes: {
      machineProvisioners: [{ id: 'guest', title: 'Guest', icon: 'server', resourceKind: 'sandbox', schemaVersion: 1,
        launchSchema: native.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
        billing: { location: 'cloud', stoppedBilling: 'not-billed' },
        retention: { supportedIntents: ['delete'], finiteOnly: true },
        actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } }],
      actions: [
        { ...action, id: 'check', inputSchema: roles.checkInput.jsonSchema,
          resultSchema: provisioners.MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
        { ...action, id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
        { ...action, id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema,
          resultSchema: provisioners.MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
        { ...action, id: 'inspect', inputSchema: roles.resourceInput.jsonSchema,
          resultSchema: provisioners.MachineProvisionerObservationV1Schema.jsonSchema },
        { ...action, id: 'destroy', inputSchema: roles.resourceInput.jsonSchema,
          resultSchema: provisioners.MachineProvisionerPowerResultV1Schema.jsonSchema },
      ],
    },
  };
}

it('admits provisioner definitions without re-normalizing projected schemas or walking identical admitted results', async () => {
  const manifest = provisionerManifest();
  // Warm module-owned role envelopes before measuring a cohort of startup admissions.
  expect(PluginManifestV2Schema.safeParse(manifest).success).toBe(true);
  const clones = vi.spyOn(strictJson, 'cloneStrictPluginJsonValue');
  const normalizations = vi.spyOn(documents, 'normalizePluginJsonSchema');
  const comparisons = vi.spyOn(equality, 'pluginJsonValuesEqual');
  const inspector = new Session();
  inspector.connect();
  try {
    await inspector.post('HeapProfiler.startSampling', { samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const definitions = 40;
    for (let index = 0; index < definitions; index++) {
      expect(PluginManifestV2Schema.safeParse(manifest).success).toBe(true);
    }
    const { profile } = await inspector.post('HeapProfiler.stopSampling');
    let sampledBytes = 0;
    const pending = [profile.head];
    while (pending.length) {
      const node = pending.pop()!;
      sampledBytes += node.selfSize;
      pending.push(...node.children);
    }
    const schemaClones = clones.mock.calls.filter(([, path]) => path === 'schema').length;
    const identicalResultWalks = comparisons.mock.calls.filter(([left, right]) =>
      left === right && documents.isNormalizedPluginJsonSchema(left)).length;
    console.info('provisioner-admission-allocation', JSON.stringify({ definitions, sampledBytes,
      normalizations: normalizations.mock.calls.length, schemaClones,
      structuralComparisons: comparisons.mock.calls.length, identicalResultWalks }));
    expect(schemaClones).toBeLessThanOrEqual(definitions);
    expect(normalizations.mock.calls.length).toBeLessThanOrEqual(definitions);
    expect(comparisons.mock.calls.length).toBe(0);
    const parsed = PluginManifestV2Schema.parse(manifest);
    expect(parsed.contributes.actions?.[0]?.resultSchema).toBe(manifest.contributes.actions[0]!.resultSchema);
    // Wire documents still take the full admission path and retain the same contract.
    expect(PluginManifestV2Schema.safeParse(structuredClone(manifest)).success).toBe(true);
  } finally {
    inspector.disconnect();
    comparisons.mockRestore();
    normalizations.mockRestore();
    clones.mockRestore();
  }
});


it('normalizes each declared document once when serialized provisioners reuse role actions', () => {
  const base = provisionerManifest();
  const descriptor = base.contributes.machineProvisioners[0]!;
  const manifest = { ...base, contributes: { ...base.contributes,
    machineProvisioners: [descriptor, { ...descriptor, id: 'second-guest' }],
  } };
  // Production locators decode file JSON before reaching this exact admission owner.
  const serialized = JSON.stringify(manifest);
  expect(admitDecodedPluginManifestV2(JSON.parse(serialized), { mode: 'load' }).ok).toBe(true);
  const normalizations = vi.spyOn(documents, 'normalizePluginJsonSchema');
  const validatingComparisons = vi.spyOn(equality, 'pluginJsonValuesEqual');
  const comparisons = vi.spyOn(admittedJson, 'sameStrictJsonValue');
  try {
    const admissions = 40;
    for (let index = 0; index < admissions; index++) {
      const result = admitDecodedPluginManifestV2(JSON.parse(serialized), { mode: 'load' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.contributes.machineProvisioners).toHaveLength(2);
        expect(result.diagnostics ?? []).toEqual([]);
      }
    }
    const declaredDocuments = manifest.contributes.actions.length * 2
      + manifest.contributes.machineProvisioners.length * 2;
    const roleBindings = manifest.contributes.machineProvisioners
      .flatMap(provisioners.readMachineProvisionerActionRolesV1).length;
    console.info('serialized-provisioner-admission-cost', JSON.stringify({ admissions, declaredDocuments,
      roleBindings, normalizations: normalizations.mock.calls.length,
      validatingComparisons: validatingComparisons.mock.calls.length,
      comparisons: comparisons.mock.calls.length }));
    expect(normalizations.mock.calls.length).toBeLessThanOrEqual(admissions * declaredDocuments);
    // A total alone could hide one definition being repeated while another is
    // skipped. Each fresh serialized definition may cross normalization once.
    const normalizedDefinitions = normalizations.mock.calls.map(([definition]) => definition);
    expect(new Set(normalizedDefinitions).size).toBe(normalizedDefinitions.length);
    expect(validatingComparisons.mock.calls.length).toBe(0);
    expect(comparisons.mock.calls.length).toBeLessThanOrEqual(admissions * roleBindings * 2);
  } finally {
    comparisons.mockRestore();
    validatingComparisons.mockRestore();
    normalizations.mockRestore();
  }
});
