import { describe, expect, it } from 'vitest';
import type { MachineSetupSourceApplyV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachinePresetContentV1Schema, type ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';

import { hydrateManagedOpaqueSetupSourcePresentationsV1, hydrateManagedOpaqueSetupSourcesV1,
  projectManagedOpaqueSetupSourcesV1 } from './setupSources.js';

type SetupSourcePair = [MachineSetupSourceApplyV1[number], MachineSetupSourceApplyV1[number]];

describe('opaque managed setup sources', () => {
  it('opens only the exact projected source locally and reprojects it without setup bytes', async () => {
    const wire = [{ kind: 'accountPresetOpaque' as const, presetId: 'preset', presetRevision: 4,
      contentEncryptionMode: 'e2ee' as const }, { kind: 'direct' as const, setup: {} }] satisfies SetupSourcePair;
    const opened = await hydrateManagedOpaqueSetupSourcesV1({ sources: wire, resolvedSources: [{ ...wire[0],
      presetContent: { content: { t: 'encrypted' as const, c: 'opaque' }, recipientEnvelope: {
        encryptedDataKey: 'key', recipientContentPublicKeyFingerprint: 'fingerprint' } } }, wire[1]],
      open: async source => source.presetId === 'preset' ? { v: 1, name: 'Private',
        setup: { scripts: [{ body: 'private setup', affects: 'none' }] } } : null });

    expect(opened).toEqual([{ kind: 'accountPreset', presetId: 'preset', presetRevision: 4,
      contentEncryptionMode: 'e2ee', setup: { scripts: [{ body: 'private setup', affects: 'none' }] } }, wire[1]]);
    expect(projectManagedOpaqueSetupSourcesV1(opened!)).toEqual(wire);
    expect(JSON.stringify(projectManagedOpaqueSetupSourcesV1(opened!))).not.toContain('private setup');
  });

  it('refuses a resolved projection whose persisted author mode or address drifted', async () => {
    const wire = [{ kind: 'accountPresetOpaque' as const, presetId: 'preset', presetRevision: 4,
      contentEncryptionMode: 'e2ee' as const }, { kind: 'direct' as const, setup: {} }] satisfies SetupSourcePair;
    await expect(hydrateManagedOpaqueSetupSourcesV1({ sources: wire, resolvedSources: [{ ...wire[0],
      contentEncryptionMode: 'plain' as const, presetContent: { content: { t: 'plain' as const, v: {
        v: 1, name: 'Private', setup: {} } }, recipientEnvelope: null } }, wire[1]],
      open: () => null })).resolves.toBeNull();
  });

  it('opens a sealed setup-only override locally and retains only its opaque carrier for Apply', async () => {
    const baseCipher = Buffer.alloc(40, 1).toString('base64');
    const overrideCipher = Buffer.alloc(40, 2).toString('base64');
    const override = { content: { t: 'encrypted' as const, c: overrideCipher } };
    const wire = [{ kind: 'accountPresetOpaque' as const, presetId: 'preset', presetRevision: 4,
      contentEncryptionMode: 'e2ee' as const, presetContentOverride: override }, { kind: 'direct' as const, setup: {} }] satisfies SetupSourcePair;
    const base = { v: 1, name: 'Private', launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' },
      schemaVersion: 1, name: 'Machine', choices: {} }, setup: { scripts: [{ body: 'base setup', affects: 'none' as const }] } } satisfies ManagedMachinePresetContentV1;
    const opened = await hydrateManagedOpaqueSetupSourcesV1({ sources: wire, resolvedSources: [{ ...wire[0],
      presetContent: { content: { t: 'encrypted' as const, c: baseCipher }, recipientEnvelope: {
        encryptedDataKey: 'key', recipientContentPublicKeyFingerprint: 'fingerprint' } } }, wire[1]],
      open: async ({ projection }) => projection.content.t === 'encrypted' && projection.content.c === overrideCipher
        ? { ...base, setup: { scripts: [{ body: 'edited setup', affects: 'none' as const }] } } : base });

    expect(opened?.[0]).toMatchObject({ kind: 'accountPreset', setup: {
      scripts: [{ body: 'edited setup' }],
    }, presetContentOverride: override });
    expect(projectManagedOpaqueSetupSourcesV1(opened!)).toEqual(wire);
    expect(JSON.stringify(projectManagedOpaqueSetupSourcesV1(opened!))).not.toContain('edited setup');
  });

  it('keeps independently readable sources visible when one opaque projection cannot open', async () => {
    const wire = [{ kind: 'accountPresetOpaque' as const, presetId: 'unavailable', presetRevision: 4,
      contentEncryptionMode: 'e2ee' as const }, { kind: 'direct' as const, setup: { scripts: [{ body: 'direct setup', affects: 'none' as const }] } }] satisfies SetupSourcePair;
    const presentation = await hydrateManagedOpaqueSetupSourcePresentationsV1({ sources: wire, resolvedSources: [{ ...wire[0],
      presetContent: { content: { t: 'encrypted' as const, c: 'opaque' }, recipientEnvelope: {
        encryptedDataKey: 'key', recipientContentPublicKeyFingerprint: 'fingerprint' } } }, wire[1]], open: () => null });

    expect(presentation).toEqual([
      { kind: 'unavailable', source: wire[0] },
      { kind: 'opened', source: wire[1] },
    ]);
  });

  it('returns the exact opened historical preset name for an attached source', async () => {
    const wire = [{ kind: 'accountPresetOpaque' as const, presetId: 'preset', presetRevision: 4,
      contentEncryptionMode: 'plain' as const }, { kind: 'direct' as const, setup: {} }] satisfies SetupSourcePair;
    const presentation = await hydrateManagedOpaqueSetupSourcePresentationsV1({ sources: wire, resolvedSources: [{ ...wire[0],
      presetContent: { content: { t: 'plain' as const, v: { v: 1, name: 'Historical preset title', setup: {} } },
        recipientEnvelope: null } }, wire[1]], open: source => source.projection.content.t === 'plain'
      ? ManagedMachinePresetContentV1Schema.parse(source.projection.content.v) : null });

    expect(presentation[0]).toEqual(expect.objectContaining({ kind: 'opened', presetName: 'Historical preset title' }));
  });
});
