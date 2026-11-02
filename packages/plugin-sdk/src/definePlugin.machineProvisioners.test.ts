import { describe, expect, it } from 'vitest';
import { machineProvisionerAuthorFixture, createMachineProvisionerRepairAuthorFixture, prepareMachineProvisionerAuthorStoredReaders, machineProvisionerAuthorOptions } from '../fixtures/authoring-inference/machineProvisioners.js';
import { parsePluginManifest } from './manifest.js';
import { createPluginTestkit } from './testing/host.js';
import { MachineProvisionerOptionsResultV1Schema } from './machineProvisioners.js';

describe('public machine provisioner authoring', () => {
  it('exposes labelled native options through the public neutral result schema', async () => {
    expect(MachineProvisionerOptionsResultV1Schema.parse(machineProvisionerAuthorOptions)).toEqual(machineProvisionerAuthorOptions);
    // A packaged external author can predate optional diagnostics and native facts.
    const manifest = structuredClone(machineProvisionerAuthorFixture.manifest);
    for (const action of manifest.contributes.actions ?? []) {
      const result = action.resultSchema;
      if (!result) continue;
      for (const envelope of [result, ...(result.oneOf ?? []), ...(result.anyOf ?? [])]) {
        if (!envelope.properties) continue;
        delete envelope.properties.nativeCause;
        if (action.id === 'options') delete envelope.properties.code;
      }
      if (action.id === 'options') {
        const facts = result.properties?.choices?.items?.properties?.nativeFacts;
        if (!facts?.properties?.size?.properties) throw new Error('Expected canonical native option facts');
        delete facts.properties.network;
        delete facts.properties.size.properties.memoryBytes;
      }
    }
    expect(parsePluginManifest(manifest).ok).toBe(true);
    const testkit = await createPluginTestkit({ manifest, module: machineProvisionerAuthorFixture });
    try {
      const options = MachineProvisionerOptionsResultV1Schema.parse(await testkit.invokeAction('options', {}));
      expect(options).toEqual(machineProvisionerAuthorOptions);
      expect(options.choices[0]?.nativeFacts?.size).not.toHaveProperty('memoryBytes');
      expect(machineProvisionerAuthorFixture.manifest.contributes.machineProvisioners?.[0]?.retention.finiteOnly).toBe(true);
      await expect(testkit.invokeAction('check', {})).resolves.toEqual({ available: true });
      const selected = options.choices[0]!;
      expect(selected.launch).toBeDefined();
      if (selected.launch === undefined) throw new Error('The native option must expose its launch configuration');
      await expect(testkit.invokeAction('acquire', { launch: selected.launch })).resolves.toEqual({
        kind: 'bound', resource: { contributionRef: { pluginId: machineProvisionerAuthorFixture.manifest.id, localId: 'guest' },
          schemaVersion: 1, value: selected.launch },
      });
      await expect(testkit.invokeAction('acquire', { launch: { name: 'archived-preset' } }))
        .resolves.toEqual({ kind: 'rejected', code: 'preset_archived' });
      await expect(testkit.invokeAction('acquire', { launch: { name: selected.title, extra: true } })).rejects.toThrow();
    } finally { await testkit.dispose(); }
  });
  it('checks prerequisites without repairing and invokes their declared repair through the ordinary Action ABI', async () => {
    const author = createMachineProvisionerRepairAuthorFixture();
    const testkit = await createPluginTestkit({ manifest: author.manifest, module: author });
    try {
      const check = await testkit.invokeAction('check', {});
      expect(check).toMatchObject({ available: false, prerequisites: [{ repairAction: { action: {
        pluginId: author.manifest.id, localId: 'repair',
      }, input: { machineName: 'guest' } } }] });
      await expect(testkit.invokeAction('check', {})).resolves.toEqual(check);
      await expect(testkit.invokeAction('repair', { machineName: 1 })).rejects.toThrow();
      await expect(testkit.invokeAction('check', {})).resolves.toEqual(check);
      await expect(testkit.invokeAction('repair', { machineName: 'guest' })).resolves.toEqual({ name: 'guest' });
      await expect(testkit.invokeAction('check', {})).resolves.toEqual({ available: true });
    } finally { await testkit.dispose(); }
  });
  it('admits descriptor-only provisioners and activates through the ordinary Action ABI', async () => {
    const parsed = parsePluginManifest(machineProvisionerAuthorFixture.manifest);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes.machineProvisioners).toMatchObject([{ id: 'guest', actions: { acquire: 'acquire' } }]);
    const readers = await prepareMachineProvisionerAuthorStoredReaders();
    expect(readers.resourceStored.parse({ name: 'guest', future: true })).toEqual({ name: 'guest' });
    const testkit = await createPluginTestkit({ manifest: machineProvisionerAuthorFixture.manifest, module: machineProvisionerAuthorFixture });
    try {
      expect(testkit.registrations().every(registration => registration.family === 'actions')).toBe(true);
      await expect(testkit.invokeAction('check', {})).resolves.toEqual({ available: true });
      const pending = await testkit.invokeAction('acquire', { launch: { name: 'pending-claim' } });
      expect(pending).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { claimId: 'pending-claim' } } });
      await expect(testkit.invokeAction('reconcile', { nativeOperation: { claimId: 'pending-claim' } })).resolves.toMatchObject({ kind: 'bound', resource: { value: { name: 'pending-claim' } } });
      await expect(testkit.invokeAction('reconcile', { nativeOperation: { claimId: 'pending-claim', private: true } })).rejects.toThrow();
      expect(readers.nativeOperationStored.parse({ claimId: 'pending-claim', future: true })).toEqual({ claimId: 'pending-claim' });
    } finally { await testkit.dispose(); }
  });
});
