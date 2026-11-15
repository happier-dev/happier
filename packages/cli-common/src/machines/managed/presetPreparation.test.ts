import { describe, expect, it } from 'vitest';
import { createManagedMachinePresetPreparationBindingV1, readManagedMachinePresetPreparationV1 } from './presetPreparation.js';

const content = { v: 1 as const, name: 'Preset', preparation: { enabled: true },
  launch: { provider: { pluginId: 'test.compute', localId: 'guest' }, schemaVersion: 1,
    name: 'Guest', choices: { image: 'ubuntu' } },
  setup: { scripts: [{ body: 'echo baked', affects: 'none' as const }] } };
const current = { presetRevision: 3, cliIdentity: 'home:0.3:payload-a', credentialIdentity: 'account:one' };
const artifact = { contributionRef: content.launch.provider, schemaVersion: 1, value: { image: 'owned-image' } };

describe('preset preparation freshness', () => {
  it('matches the exact preset revision, baked configuration and actual supplier/credential identity', () => {
    const binding = createManagedMachinePresetPreparationBindingV1({ content, ...current });
    const prepared = { operationId: 'build-1', status: 'ready' as const, binding, artifact, bakedSetup: content.setup };
    const saved = { ...content, prepared };
    expect(readManagedMachinePresetPreparationV1({ content: saved, ...current }))
      .toEqual({ kind: 'warm', artifact, bakedSetup: content.setup });
    expect(readManagedMachinePresetPreparationV1({ content: { ...saved, name: 'Renamed preset',
      launch: { ...saved.launch, name: 'Per-acquire name' } }, ...current }).kind).toBe('warm');
    for (const changed of [
      { content: { ...saved, setup: { scripts: [{ body: 'echo edited', affects: 'none' as const }] } }, ...current },
      { content: { ...saved, launch: { ...saved.launch, choices: { image: 'new-image' } } }, ...current },
      { content: { ...saved, launch: { ...saved.launch, provider: { pluginId: 'other.compute', localId: 'guest' } } }, ...current },
      { content: saved, ...current, cliIdentity: 'public:0.3:newer-release' },
      { content: saved, ...current, credentialIdentity: 'account:two' },
      { content: saved, ...current, presetRevision: 4 },
    ]) expect(readManagedMachinePresetPreparationV1(changed)).toEqual({ kind: 'cold', reason: 'stale' });
  });

  it('reports only the build owner\'s actual baked setup instead of claiming all authored setup ran in the image', () => {
    const authored = { ...content, setup: { scripts: [...content.setup.scripts,
      { body: 'configure-session-credentials', affects: 'none' as const }] } };
    const binding = createManagedMachinePresetPreparationBindingV1({ content: authored, ...current });
    const prepared = { operationId: 'build-1', status: 'ready' as const, binding, artifact, bakedSetup: content.setup };
    expect(readManagedMachinePresetPreparationV1({ content: { ...authored, prepared }, ...current }))
      .toEqual({ kind: 'warm', artifact, bakedSetup: content.setup });
    expect(readManagedMachinePresetPreparationV1({ content: { ...authored,
      prepared: { operationId: 'cli-only-build', status: 'ready', binding, artifact } }, ...current }))
      .toEqual({ kind: 'warm', artifact });
  });

  it('keeps disabled, absent and all nonready build outcomes cold while retaining native identities', () => {
    const binding = createManagedMachinePresetPreparationBindingV1({ content, ...current });
    expect(readManagedMachinePresetPreparationV1({ content, ...current })).toEqual({ kind: 'cold', reason: 'unprepared' });
    for (const status of ['building', 'failed', 'cancelled', 'stale'] as const) {
      const saved = { ...content, prepared: { operationId: 'build-1', status, binding,
        artifact, nativeOperationRef: { ...artifact, value: { build: 'owned-build' } } } };
      expect(readManagedMachinePresetPreparationV1({ content: saved, ...current }))
        .toEqual({ kind: 'cold', reason: status });
      expect(saved.prepared.artifact).toEqual(artifact);
      expect(readManagedMachinePresetPreparationV1({ content: { ...saved, preparation: { enabled: false } }, ...current }))
        .toEqual({ kind: 'cold', reason: 'disabled' });
    }
  });
});
