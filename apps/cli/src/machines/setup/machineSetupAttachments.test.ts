import { describe, expect, it } from 'vitest';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { MachineSetupSourceV1Schema, getMachineSetupDesiredV1, type MachineSetupSourceV1, type MachineSetupSourceFactsMapV1 } from '@happier-dev/protocol';
import { prepareMachineSetupPlanV1 } from './prepareMachineSetupPlan';

const chrome = { kind: 'softwareRecipe' as const, selection: {
  ref: { pluginId: 'example.software', recipeId: 'chrome', revision: '1' }, inputs: {},
} };
const fonts = { ...chrome, selection: { ...chrome.selection, ref: { ...chrome.selection.ref, recipeId: 'fonts' } } };
const key = (item: typeof chrome) => createCanonicalJsonSigningInput(item);

async function plan(sources: MachineSetupSourceV1, proposed: MachineSetupSourceV1, sourceFacts?: MachineSetupSourceFactsMapV1,
  exclusions: import('@happier-dev/protocol').MachineSetupExclusionV1[] = []) {
  const current = await getMachineSetupDesiredV1({
    read: async () => ({ status: 'ready', metadataVersion: 1, metadata: {
      setup: { version: 1, revision: 2, sources, exclusions, ...(sourceFacts ? { sourceFacts } : {}) },
    } }),
    compareAndSwap: async () => { throw new Error('Plan cannot mutate desired setup'); },
  });
  // Retained snapshots remain usable with no live recipe catalog. Do not
  // substitute internal catalog or native-planning logic to prove that.
  return prepareMachineSetupPlanV1({ current,
    input: { homeId: 'home', machineId: 'guest', sources: proposed } });
}

describe('default attachment removal review', () => {
  it.each(['present', 'absent', 'unknown'] as const)('forgets an explicitly removed direct recipe without native removal (%s)', async presence => {
    const source = { kind: 'direct' as const, setup: { items: [chrome] } };
    const proposed = [{ kind: 'direct' as const, setup: {} }];
    expect(await plan([source], proposed, presence === 'unknown' ? undefined
      : { direct: { firstPresence: { [key(chrome)]: presence } } }))
      .toMatchObject({ sources: proposed, support: [] });
  });

  it('forgets the excluded direct recipe together with its retained exclusion', async () => {
    const proposed = [{ kind: 'direct' as const, setup: {} }];
    expect(await plan([{ kind: 'direct', setup: { items: [chrome] } }], proposed, undefined,
      [{ ref: chrome.selection.ref, reason: 'not_selected' }]))
      .toMatchObject({ sources: proposed, exclusions: [], support: [] });
  });

  it('keeps detached software in the single direct source and leaves shared software in its remaining preset', async () => {
    const direct = { kind: 'direct' as const, setup: {} };
    const a = { kind: 'accountPreset' as const, presetId: 'a', presetRevision: 1,
      setup: { items: [chrome, fonts] } };
    const b = { kind: 'accountPreset' as const, presetId: 'b', presetRevision: 1,
      setup: { items: [fonts] } };
    const sourceFacts: MachineSetupSourceFactsMapV1 = {
      'account:a': { firstPresence: { [key(chrome)]: 'absent', [key(fonts)]: 'absent' } },
      'account:b': { firstPresence: { [key(fonts)]: 'absent' } },
    };
    const current = MachineSetupSourceV1Schema.parse([a, b, direct]);
    const proposed = MachineSetupSourceV1Schema.parse([b, direct]);
    const result = await plan(current, proposed, sourceFacts);
    expect(result).toMatchObject({ sources: [b, { ...direct, setup: { items: [chrome] } }], sourceFacts });
    expect(proposed).toEqual([b, direct]);
    expect(current).toEqual([a, b, direct]);
  });

  it('keeps pre-existing and unknown-origin items when an attachment is updated', async () => {
    const direct = { kind: 'direct' as const, setup: {} };
    const source = { kind: 'accountPreset' as const, presetId: 'a', presetRevision: 1,
      setup: { items: [chrome, fonts] } };
    const sourceFacts: MachineSetupSourceFactsMapV1 = { 'account:a': { firstPresence: { [key(chrome)]: 'present' } } };
    const updated = { ...source, presetRevision: 2, setup: {} };
    expect(await plan(MachineSetupSourceV1Schema.parse([source, direct]), MachineSetupSourceV1Schema.parse([updated, direct]), sourceFacts))
      .toMatchObject({ sources: [updated, { ...direct, setup: { items: [chrome, fonts] } }], sourceFacts });
  });
});
