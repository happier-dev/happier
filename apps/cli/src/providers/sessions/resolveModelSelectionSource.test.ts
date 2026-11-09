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
