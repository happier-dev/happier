import { expect, it } from 'vitest';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol';

import { resolveModelSelectionSource } from './resolveModelSelectionSource';

const launchSelection = SessionModelSelectionV1Schema.parse({
  v: 1,
  ref: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'selected-model' },
  updatedAt: 1,
});

it('preserves launch provenance when the Session metadata snapshot is absent', () => {
  expect(resolveModelSelectionSource({ selection: launchSelection.ref, metadata: null, launchSelection }))
    .toBe('explicit');
  expect(resolveModelSelectionSource({ selection: { ...launchSelection.ref, modelId: 'other-model' }, metadata: null, launchSelection }))
    .toBe('inherited');
});

it('keeps a model inherited when both metadata and launch selection are absent', () => {
  expect(resolveModelSelectionSource({ selection: launchSelection.ref, metadata: null, launchSelection: null }))
    .toBe('inherited');
});

it('uses typed model intent before a retained older tuple for provenance', () => {
  expect(resolveModelSelectionSource({ selection: launchSelection.ref, metadata: {
    modelSelectionIntentV2: { v: 2, updatedAt: 2, ref: { source: 'native',
      agentTargetKey: launchSelection.ref.agentTargetKey, modelId: launchSelection.ref.modelId } },
    modelSelectionIntentV1: { v: 1, updatedAt: 1, selection: { ...launchSelection.ref, modelId: 'older-model' } },
  } })).toBe('explicit');
});

it('does not attribute a historical V2 tuple to a newer explicit legacy model override', () => {
  expect(resolveModelSelectionSource({ selection: launchSelection.ref, metadata: {
    modelSelectionIntentV2: { v: 2, updatedAt: 2, ref: { source: 'native',
      agentTargetKey: launchSelection.ref.agentTargetKey, modelId: launchSelection.ref.modelId } },
    modelOverrideV1: { v: 1, updatedAt: 3, modelId: 'newer-model' },
  } })).toBe('inherited');
});
