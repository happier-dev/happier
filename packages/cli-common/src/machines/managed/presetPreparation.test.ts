import { describe, expect, it } from 'vitest';
import { ManagedCredentialSelectionV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createManagedMachinePresetPreparationBindingV1, readManagedMachinePresetPreparationV1 } from './presetPreparation.js';

const purpose = { consumer: { pluginId: 'test.compute', localId: 'guest' }, purpose: 'compute' };
const account = { service: { pluginId: 'test.service', localId: 'compute' }, accountId: 'provider-one' };
const content = { v: 1 as const, name: 'Preset', preparation: { enabled: true },
  launch: { provider: { pluginId: 'test.compute', localId: 'guest' }, schemaVersion: 1,
    name: 'Guest', choices: { image: 'ubuntu' }, credentials: [{ purpose, account }] },
  setup: { items: [{ kind: 'setupRecipe' as const,
    selection: { ref: { pluginId: 'test.recipes', recipeId: 'runtime', revision: '1' }, inputs: {} } }],
    scripts: [{ body: 'configure-session-credentials', affects: 'none' as const }] } };
const bakedSetup = { items: content.setup.items };
const current = { cliIdentity: 'home:0.3:payload-a',
  credentialConfigurations: [{ account, revision: 'configuration-1' }] };
const binaryPath = '/opt/happier/cli/current/happier';
const artifact = { contributionRef: content.launch.provider, schemaVersion: 1, value: { image: 'owned-image' } };

describe('preset preparation freshness', () => {
  it('requests a rebuild only for an opted-in ready image with unchanged configuration and a changed CLI', () => {
    const binding = createManagedMachinePresetPreparationBindingV1({ content, ...current });
    const prepared = { operationId: 'build-1', status: 'ready' as const,
      binding, artifact, cliBinaryPath: binaryPath, bakedSetup };
    const saved = { ...content, preparation: { enabled: true, whenHappierUpdates: 'rebuild-automatically' as const }, prepared };
    const changedCli = { ...current, cliIdentity: 'home:0.3:payload-b' };
    const decision = readManagedMachinePresetPreparationV1({ content: saved, ...changedCli, canManagePreset: true });
    expect(decision).toMatchObject({ kind: 'rebuild', artifact, binaryPath, bakedSetup });
    expect(decision).not.toHaveProperty('updateCli');
    // An author's setting cannot lend Manage authority to the Session starter.
    for (const authority of [{}, { canManagePreset: false }]) {
      expect(readManagedMachinePresetPreparationV1({ content: saved, ...changedCli, ...authority }))
        .toMatchObject({ kind: 'warm', artifact, updateCli: true });
    }
    expect(readManagedMachinePresetPreparationV1({ content: saved, ...current, canManagePreset: true }))
      .toMatchObject({ kind: 'warm', artifact });
    expect(readManagedMachinePresetPreparationV1({ content: saved, ...current, canManagePreset: true })).not.toHaveProperty('updateCli');
    expect(readManagedMachinePresetPreparationV1({ content: { ...saved,
      preparation: { enabled: true, whenHappierUpdates: 'update-at-start' } }, ...changedCli, canManagePreset: true }))
      .toMatchObject({ kind: 'warm', artifact, updateCli: true });
    for (const changed of [
      { content: { ...saved, setup: { scripts: [{ body: 'echo changed', affects: 'none' as const }] } }, ...changedCli },
      { content: { ...saved, launch: { ...saved.launch, choices: { image: 'changed' } } }, ...changedCli },
      { content: saved, ...changedCli, credentialConfigurations: [{ account, revision: 'configuration-2' }] },
    ]) expect(readManagedMachinePresetPreparationV1(changed)).toEqual({ kind: 'cold', reason: 'stale' });
    expect(readManagedMachinePresetPreparationV1({ content: { ...saved,
      preparation: { ...saved.preparation, enabled: false } }, ...changedCli })).toEqual({ kind: 'cold', reason: 'disabled' });
    for (const status of ['building', 'failed', 'cancelled'] as const) {
      expect(readManagedMachinePresetPreparationV1({ content: { ...saved, prepared: { ...prepared, status } }, ...changedCli }))
        .toEqual({ kind: 'cold', reason: status });
    }
    expect(readManagedMachinePresetPreparationV1({ content: { ...saved, prepared: undefined }, ...changedCli }))
      .toEqual({ kind: 'cold', reason: 'unprepared' });
  });

  it('keeps renamed or operationally updated images warm and swaps only a changed CLI at start', () => {
    const binding = createManagedMachinePresetPreparationBindingV1({ content, ...current });
    const saved = { ...content, prepared: { operationId: 'build-1', status: 'ready' as const,
      binding, artifact, cliBinaryPath: binaryPath, bakedSetup } };
    expect(readManagedMachinePresetPreparationV1({ content: { ...saved, name: 'Renamed' },
      ...current })).toMatchObject({ kind: 'warm', artifact });
    expect(readManagedMachinePresetPreparationV1({ content: saved, ...current,
      cliIdentity: 'public:0.3:newer-release' })).toMatchObject({ kind: 'warm', artifact, updateCli: true });
    expect(readManagedMachinePresetPreparationV1({ content: saved, ...current })).not.toHaveProperty('updateCli');
  });
  it('retains the original preparation host without making it a freshness input', () => {
    const host = { machineId: 'original-local-image-host' };
    const binding = createManagedMachinePresetPreparationBindingV1({ content, ...current, ...host });
    expect(binding).toMatchObject(host);
    expect(readManagedMachinePresetPreparationV1({ content: { ...content,
      prepared: { operationId: 'build-1', status: 'ready', binding, artifact, cliBinaryPath: binaryPath } }, ...current }))
      .toMatchObject({ kind: 'warm' });
  });
  it('keeps an old prepared image cold after author reapproval changes the contents at the same source path', () => {
    const source = { ...content, launch: { ...content.launch,
      choices: { workspaceFolder: '/workspace', configPath: '/workspace/.devcontainer/devcontainer.json' } },
      authorEffectReview: { kind: 'devcontainer' as const, reviewedEffectDigest: 'a'.repeat(64), effects: [] } };
    const binding = createManagedMachinePresetPreparationBindingV1({ content: source, ...current });
    const ready = { ...source, prepared: { operationId: 'build-1', status: 'ready' as const,
      binding, artifact, cliBinaryPath: binaryPath } };
    expect(readManagedMachinePresetPreparationV1({ content: ready, ...current })).toMatchObject({ kind: 'warm' });
    // Keep the same path and operational revision basis: only newly approved
    // executable source contents changed, so revision equality cannot hide drift.
    const revised = { ...ready, authorEffectReview: { ...source.authorEffectReview,
      reviewedEffectDigest: 'b'.repeat(64) } };
    expect(readManagedMachinePresetPreparationV1({ content: revised, ...current }))
      .toEqual({ kind: 'cold', reason: 'stale' });
  });

  it('keeps legacy ready artifacts without an actual installed CLI path cold', () => {
    const binding = createManagedMachinePresetPreparationBindingV1({ content, ...current });
    expect(readManagedMachinePresetPreparationV1({ content: { ...content,
      prepared: { operationId: 'legacy-build', status: 'ready', binding, artifact } }, ...current }))
      .toEqual({ kind: 'cold', reason: 'unprepared' });
  });
  it('matches baked configuration and canonical Account or Team selection', () => {
    const binding = createManagedMachinePresetPreparationBindingV1({ content, ...current });
    const prepared = { operationId: 'build-1', status: 'ready' as const, binding, artifact, cliBinaryPath: binaryPath, bakedSetup };
    const saved = { ...content, prepared };
    expect(readManagedMachinePresetPreparationV1({ content: saved, ...current }))
      .toEqual({ kind: 'warm', artifact, binaryPath, bakedSetup,
        deferredSetup: { scripts: content.setup.scripts } });
    expect(readManagedMachinePresetPreparationV1({ content: { ...saved, name: 'Renamed preset',
      launch: { ...saved.launch, name: 'Per-acquire name' } }, ...current }).kind).toBe('warm');
    for (const changed of [
      { content: { ...saved, setup: { scripts: [{ body: 'echo edited', affects: 'none' as const }] } }, ...current },
      { content: { ...saved, launch: { ...saved.launch, choices: { image: 'new-image' } } }, ...current },
      { content: { ...saved, launch: { ...saved.launch, provider: { pluginId: 'other.compute', localId: 'guest' } } }, ...current },
      { content: { ...saved, launch: { ...saved.launch,
        credentials: [{ purpose, account: { ...account, accountId: 'provider-two' } }] } }, ...current },
      { content: saved, ...current, credentialConfigurations: [{ account, revision: 'configuration-2' }] },
    ]) expect(readManagedMachinePresetPreparationV1(changed)).toEqual({ kind: 'cold', reason: 'stale' });
    const team = ManagedCredentialSelectionV1Schema.parse({ purpose, teamId: 'team',
      selection: { source: 'team_resource', resourceId: 'provider-pool-one', deliveryMode: 'direct', disclosedMember: account } });
    const teamCurrent = { ...current, credentialConfigurations: [] };
    const teamContent = { ...content, launch: { ...content.launch, credentials: [team] } };
    const teamSaved = { ...teamContent, prepared: { ...prepared,
      binding: createManagedMachinePresetPreparationBindingV1({ content: teamContent, ...teamCurrent }) } };
    expect(readManagedMachinePresetPreparationV1({ content: teamSaved, ...teamCurrent }).kind).toBe('warm');
    const changedTeam = ManagedCredentialSelectionV1Schema.parse({ purpose, teamId: 'team',
      selection: { source: 'team_resource', resourceId: 'provider-pool-two', deliveryMode: 'direct', disclosedMember: account } });
    expect(readManagedMachinePresetPreparationV1({ content: { ...teamSaved,
      launch: { ...teamSaved.launch, credentials: [changedTeam] } }, ...teamCurrent }))
      .toEqual({ kind: 'cold', reason: 'stale' });
  });

  it('reports only the build owner\'s actual baked setup instead of claiming all authored setup ran in the image', () => {
    const deferredItem = { kind: 'setupRecipe' as const,
      selection: { ref: { pluginId: 'test.recipes', recipeId: 'private-service', revision: '1' }, inputs: {} } };
    const authored = { ...content, setup: { ...content.setup, items: [...content.setup.items, deferredItem],
      toolchain: { adapterId: 'mise', config: '[tools]' }, secretRefs: { v: 1 as const, bindings: {} } } };
    const deferredSetup = { ...authored.setup, items: [deferredItem] };
    const binding = createManagedMachinePresetPreparationBindingV1({ content: authored, ...current });
    const prepared = { operationId: 'build-1', status: 'ready' as const, binding, artifact, cliBinaryPath: binaryPath, bakedSetup };
    expect(readManagedMachinePresetPreparationV1({ content: { ...authored, prepared }, ...current }))
      .toEqual({ kind: 'warm', artifact, binaryPath, bakedSetup, deferredSetup });
    expect(readManagedMachinePresetPreparationV1({ content: { ...authored,
      prepared: { operationId: 'cli-only-build', status: 'ready', binding, artifact, cliBinaryPath: binaryPath } }, ...current }))
      .toEqual({ kind: 'warm', artifact, binaryPath, deferredSetup: authored.setup });
    const itemsOnly = { ...content, setup: bakedSetup };
    expect(readManagedMachinePresetPreparationV1({ content: { ...itemsOnly, prepared: { ...prepared,
      binding: createManagedMachinePresetPreparationBindingV1({ content: itemsOnly, ...current }) } }, ...current }))
      .toEqual({ kind: 'warm', artifact, binaryPath, bakedSetup });
  });

  it('keeps disabled, absent and all nonready build outcomes cold while retaining native identities', () => {
    const binding = createManagedMachinePresetPreparationBindingV1({ content, ...current });
    expect(readManagedMachinePresetPreparationV1({ content, ...current })).toEqual({ kind: 'cold', reason: 'unprepared' });
    for (const status of ['building', 'failed', 'cancelled'] as const) {
      const saved = { ...content, prepared: { operationId: 'build-1', status, binding,
        artifact, nativeOperationRef: { ...artifact, value: { build: 'owned-build' } } } };
      expect(readManagedMachinePresetPreparationV1({ content: saved, ...current }))
        .toEqual({ kind: 'cold', reason: status });
      expect(readManagedMachinePresetPreparationV1({ content: { ...saved, preparation: { enabled: false } }, ...current }))
        .toEqual({ kind: 'cold', reason: 'disabled' });
    }
  });
});
