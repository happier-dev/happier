import { describe, expect, it } from 'vitest';

import { createModelIntentMetadataCasCandidate } from './metadataWriters.js';

const selection = {
  agentTargetKey: 'backend:codex',
  providerConnectionId: null,
  modelId: 'default',
} as const;

describe('createModelIntentMetadataCasCandidate', () => {
  it('assigns owner order once and does not promote a stale retry over a newer intent', () => {
    const candidate = createModelIntentMetadataCasCandidate({
      selection,
      nowMs: () => 20,
    });
    const first = candidate.update({
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 10,
        selection: { ...selection, modelId: 'old' },
      },
    });
    expect(first.modelSelectionIntentV1).toMatchObject({
      updatedAt: 20,
      selection,
    });
    expect(candidate.readState()).toEqual({ accepted: true, updatedAt: 20 });

    const retry = candidate.update({
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 21,
        selection: { ...selection, modelId: 'newer' },
      },
    });
    expect(retry.modelSelectionIntentV1).toMatchObject({
      updatedAt: 21,
      selection: { modelId: 'newer' },
    });
    expect(candidate.readState()).toEqual({ accepted: false, updatedAt: 20 });
  });
});
