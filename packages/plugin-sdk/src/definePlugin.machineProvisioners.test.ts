import { describe, expect, it } from 'vitest';
import { machineProvisionerAuthorFixture, createMachineProvisionerRepairAuthorFixture, createMachineProvisionerPreparationAuthorFixture, createMachinePresetPreparationInputAuthorFixture, prepareMachineProvisionerAuthorStoredReaders, machineProvisionerAuthorOptions, machineProvisionerAuthorRefusedOptions, projectMachineProvisionerAuthorSelection } from '../fixtures/authoring-inference/machineProvisioners.js';
import { parsePluginManifest } from './manifest.js';
import { createPluginTestkit } from './testing/host.js';
import { MachineProvisionerOptionsResultV1Schema } from './machineProvisioners.js';
import type { JsonValue } from './identity.js';
import { createMachineProvisionerSpecializedPreparationAuthorFixture } from '../fixtures/authoring-inference/machineProvisioners.js';

describe('public machine provisioner authoring', () => {
  it('admits preparation roles specialized to the provider choices and rejects undeclared choices', async () => {
    const author = createMachineProvisionerSpecializedPreparationAuthorFixture();
    const testkit = await createPluginTestkit({ manifest: author.manifest, module: author });
    const launch = { provider: { pluginId: author.manifest.id, localId: 'guest' }, schemaVersion: 1, choices: { name: 'guest' } };
    const cli = { identity: 'selected-cli', versionId: 'current', binaryPath: '/opt/happier/happier',
      installScript: 'install selected payload', files: [] };
    const input = { launch, cli, setupScript: 'prepare selected tools' };
    try {
      await expect(testkit.invokeAction('prepare-build', { operationId: 'specialized-build', input }))
        .resolves.toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { claimId: 'specialized-build' } } });
      await expect(testkit.invokeAction('prepare-build', { operationId: 'specialized-build', input: {
        ...input, launch: { ...launch, choices: { name: 'guest', credential: 'undeclared' } },
      } })).rejects.toThrow();
      await expect(testkit.invokeAction('prepare-build', { operationId: 'specialized-build', input: {
        ...input, cli: { ...cli, files: [{ path: 'payload' }] },
      } })).rejects.toThrow();
    } finally { await testkit.dispose(); }
  });
  it('passes the complete validated launch and supplier CLI input through the public builder contract', async () => {
    const author = createMachinePresetPreparationInputAuthorFixture();
    const testkit = await createPluginTestkit({ manifest: author.manifest, module: author });
    const launch = { provider: { pluginId: 'examples.machine-provisioner', localId: 'guest' }, schemaVersion: 1,
      choices: { image: 'linux', size: 'small', region: 'hel1' } };
    const cli = { identity: 'home-payload:fixture', versionId: 'fixture', binaryPath: '/opt/happier/happier',
      installScript: 'install selected payload', files: [{ path: 'payload.tar.gz', contentsBase64: 'cGF5bG9hZA==' }] };
    try {
      await expect(testkit.invokeAction('build', { launch, cli })).resolves.toEqual(cli);
      await expect(testkit.invokeAction('build', { launch: { ...launch, credentials: { secret: 'selector' } }, cli })).rejects.toThrow();
      await expect(testkit.invokeAction('build', { launch, cli: { ...cli, files: [{ path: 'payload.tar.gz' }] } })).rejects.toThrow();
    } finally { await testkit.dispose(); }
  });
  it('retains an unknown preparation identity and resolves it through the public inspect and cleanup roles', async () => {
    const author = createMachineProvisionerPreparationAuthorFixture();
    const testkit = await createPluginTestkit({ manifest: author.manifest, module: author });
    const contributionRef = { pluginId: author.manifest.id, localId: 'guest' };
    try {
      await expect(testkit.invokeAction('prepare-build', { operationId: 'retained-build', input: { name: 'guest' } }))
        .resolves.toEqual({ kind: 'unknown', code: 'native_reply_lost', nativeOperationRef: {
          contributionRef, schemaVersion: 1, value: { claimId: 'retained-build' },
        } });
      await expect(testkit.invokeAction('prepare-inspect', { nativeOperation: { contributionRef, schemaVersion: 1, value: { claimId: 'retained-build' } } }))
        .resolves.toEqual({ kind: 'ready', artifact: { contributionRef, schemaVersion: 1, value: { launch: { name: 'retained-build' } } } });
      await expect(testkit.invokeAction('prepare-inspect', { operationId: 'retained-build', launch: { name: 'guest' } }))
        .resolves.toEqual({ kind: 'ready', artifact: { contributionRef, schemaVersion: 1, value: { launch: { name: 'retained-build' } } } });
      await expect(testkit.invokeAction('prepare-inspect', { operationId: 'retained-build', input: { name: 'guest' } })).rejects.toThrow();
      await expect(testkit.invokeAction('prepare-inspect', { operationId: 'retained-build', launch: { name: 'guest', credential: 'undeclared' } })).rejects.toThrow();
      await expect(testkit.invokeAction('prepare-destroy', { artifact: { contributionRef, schemaVersion: 1, value: { launch: { name: 'retained-build' } } } }))
        .resolves.toEqual({ kind: 'confirmed' });
      await expect(testkit.invokeAction('prepare-destroy', {})).rejects.toThrow();
    } finally { await testkit.dispose(); }
  });
  it('preserves native power results and recovers an unknown outcome by inspecting the same resource', async () => {
    const testkit = await createPluginTestkit({ manifest: machineProvisionerAuthorFixture.manifest, module: machineProvisionerAuthorFixture });
    try {
      await expect(testkit.invokeAction('power', { resource: { name: 'guest' }, intent: 'stop' }))
        .resolves.toEqual({ kind: 'confirmed' });
      await expect(testkit.invokeAction('power', { resource: { name: 'refused-power' }, intent: 'start' }))
        .resolves.toEqual({ kind: 'refused', code: 'native_route_unavailable' });
      const resource = { name: 'accepted-start' };
      await expect(testkit.invokeAction('power', { resource, intent: 'start' }))
        .resolves.toEqual({ kind: 'unknown', code: 'native_reply_lost' });
      await expect(testkit.invokeAction('inspect', { resource }))
        .resolves.toMatchObject({ availability: 'present', power: 'running', storage: 'retained' });
      await expect(testkit.invokeAction('power', { resource, intent: 'invented' })).rejects.toThrow();
    } finally { await testkit.dispose(); }
  });

  it('leaves an unrecoverable submission unknown through the real public-author host fixture', async () => {
    const testkit = await createPluginTestkit({ manifest: machineProvisionerAuthorFixture.manifest, module: machineProvisionerAuthorFixture });
    try {
      const inputs: readonly JsonValue[] = [{ nativeOperation: { claimId: 'lost-response' } },
        { correlation: { managedId: 'lost-response', requestId: 'original-request', launch: { name: 'lost-response' } } }];
      for (const input of inputs) {
        await expect(testkit.invokeAction('reconcile', input)).resolves.toEqual({
          kind: 'unknown', recovery: { reference: 'lost-response', reason: 'native_identity_unavailable' },
        });
      }
    } finally { await testkit.dispose(); }
  });

  it('exposes labelled native options through the public neutral result schema', async () => {
    expect(MachineProvisionerOptionsResultV1Schema.parse(machineProvisionerAuthorOptions)).toEqual(machineProvisionerAuthorOptions);
    const refused = MachineProvisionerOptionsResultV1Schema.parse(machineProvisionerAuthorRefusedOptions);
    expect(projectMachineProvisionerAuthorSelection(refused, {})).toMatchObject({ kind: 'unavailable',
      code: refused.base?.unavailableReason?.code, unavailableReason: machineProvisionerAuthorRefusedOptions.base.unavailableReason });
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
        const items = result.properties?.dimensions?.properties?.size?.items;
        if (!items || Array.isArray(items)) throw new Error('Expected canonical size item schema');
        const facts = items.properties?.nativeFacts;
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
      expect(options.dimensions.size[0]?.nativeFacts?.size).not.toHaveProperty('memoryBytes');
      expect(machineProvisionerAuthorFixture.manifest.contributes.machineProvisioners?.[0]?.retention.finiteOnly).toBe(true);
      await expect(testkit.invokeAction('check', {})).resolves.toEqual({ available: true });
      expect(projectMachineProvisionerAuthorSelection(options, { size: 'small' })).toMatchObject({ kind: 'incomplete' });
      expect(projectMachineProvisionerAuthorSelection(options, { size: 'missing', image: 'linux', location: 'hel1' })).toMatchObject({ kind: 'invalid' });
      const selected = projectMachineProvisionerAuthorSelection(options, { size: 'small', image: 'linux', location: 'hel1' });
      expect(selected.kind).toBe('ready');
      if (selected.kind !== 'ready') throw new Error('The complete public selection must expose its validated launch');
      expect(selected).toMatchObject({ guestPlatform: 'linux' });
      expect(projectMachineProvisionerAuthorSelection(options, { size: 'small', image: 'sandbox-linux', location: 'hel1' }))
        .toMatchObject({ kind: 'ready', enrollmentRole: 'sandbox', guestPlatform: 'linux' });
      await expect(testkit.invokeAction('acquire', { launch: selected.launch })).resolves.toEqual({
        kind: 'bound', resource: { contributionRef: { pluginId: machineProvisionerAuthorFixture.manifest.id, localId: 'guest' },
          schemaVersion: 1, value: selected.launch },
      });
      await expect(testkit.invokeAction('acquire', { launch: { name: 'archived-preset' } }))
        .resolves.toEqual({ kind: 'rejected', code: 'preset_archived' });
      await expect(testkit.invokeAction('acquire', { launch: { name: 'guest', extra: true } })).rejects.toThrow();
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
    expect(parsed.manifest.contributes.machineProvisioners).toMatchObject([{ id: 'guest', resourceIdPath: 'name', enrollmentRole: 'server', actions: { acquire: 'acquire' } }]);
    const readers = await prepareMachineProvisionerAuthorStoredReaders();
    expect(readers.resourceStored.parse({ name: 'guest', future: true })).toEqual({ name: 'guest' });
    const testkit = await createPluginTestkit({ manifest: machineProvisionerAuthorFixture.manifest, module: machineProvisionerAuthorFixture });
    try {
      expect(testkit.registrations().every(registration => registration.family === 'actions')).toBe(true);
      await expect(testkit.invokeAction('check', {})).resolves.toEqual({ available: true });
      const pending = await testkit.invokeAction('acquire', { launch: { name: 'pending-claim' } });
      expect(pending).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { claimId: 'pending-claim' } } });
      await expect(testkit.invokeAction('reconcile', { nativeOperation: { claimId: 'pending-claim' } })).resolves.toMatchObject({ kind: 'bound', resource: { value: { name: 'pending-claim' } } });
      const starting = await testkit.invokeAction('acquire', { launch: { name: 'accepted-start' } });
      expect(starting).toMatchObject({ kind: 'bound', startPending: true, resource: { value: { name: 'accepted-start' } } });
      await expect(testkit.invokeAction('inspect', { resource: { name: 'accepted-start' } }))
        .resolves.toMatchObject({ availability: 'present', power: 'running' });
      const recoveredStart = await testkit.invokeAction('reconcile', { nativeOperation: { claimId: 'accepted-start' } });
      expect(recoveredStart).toMatchObject({ kind: 'bound', resource: { value: { name: 'accepted-start' } } });
      expect(recoveredStart).not.toHaveProperty('startPending');
      await expect(testkit.invokeAction('destroy', { resource: { name: 'pending-delete' } })).resolves.toEqual({ kind: 'pending' });
      await expect(testkit.invokeAction('destroy', { resource: { name: 'guest' } })).resolves.toEqual({ kind: 'confirmed' });
      await expect(testkit.invokeAction('reconcile', { nativeOperation: { claimId: 'pending-claim', private: true } })).rejects.toThrow();
      expect(readers.nativeOperationStored.parse({ claimId: 'pending-claim', future: true })).toEqual({ claimId: 'pending-claim' });
    } finally { await testkit.dispose(); }
  });
});
