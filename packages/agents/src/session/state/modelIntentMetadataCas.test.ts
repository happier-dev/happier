import { describe, expect, it } from 'vitest';

import {
  createModelIntentMetadataCasCandidate,
  createModelIntentV2MetadataCasCandidate,
} from './metadataWriters.js';

const selection = {
  agentTargetKey: 'backend:codex',
  providerConnectionId: null,
  modelId: 'default',
} as const;
const scope = { serverId: 'home', accountId: 'account-1', sessionId: 'session-1' };
const teamRef = {
  source: 'team_resource' as const,
  resourceId: 'resource-1',
  teamId: 'team-1',
  expectedResourceRevision: 7,
  deliveryMode: 'brokered' as const,
  agentTargetKey: 'backend:codex',
  modelId: 'model-a',
};

describe('createModelIntentMetadataCasCandidate', () => {
  it('refuses capture of a canonical null intent without inventing a default inverse', () => {
    const metadata = { modelSelectionIntentV1: { v: 1 as const, updatedAt: 20, selection: null } };
    const candidate = createModelIntentMetadataCasCandidate({ selection, captureBefore: true, ownerScope: scope });
    expect(candidate.update(metadata)).toBe(metadata);
    expect(candidate.readState()).toMatchObject({ accepted: false, refusal: 'unsupported' });
    const ordinary = createModelIntentMetadataCasCandidate({ selection, nowMs: () => 21 });
    expect(ordinary.update(metadata).modelSelectionIntentV1).toMatchObject({ selection });
    expect(ordinary.readState()).toMatchObject({ accepted: true });
  });
  it('refuses capture when a prior Agent selection cannot be restored by the current Session setter', () => {
    const metadata = { modelSelectionIntentV1: { v: 1 as const, updatedAt: 20,
      selection: { ...selection, agentTargetKey: 'backend:claude' } } };
    const candidate = createModelIntentMetadataCasCandidate({ selection, captureBefore: true, ownerScope: scope });
    expect(candidate.update(metadata)).toBe(metadata);
    expect(candidate.readState()).toMatchObject({ accepted: false, refusal: 'unsupported' });
  });
  it('refuses conditional restore when Session target resolution would change the captured Agent tuple', () => {
    const metadata = { modelSelectionIntentV1: { v: 1 as const, updatedAt: 20, selection } };
    const candidate = createModelIntentMetadataCasCandidate({ selection: { ...selection, agentTargetKey: 'backend:claude' }, ownerScope: scope,
      expected: { owner: 'inactive', scope, selection, updatedAt: 20 } });
    expect(candidate.update(metadata)).toBe(metadata);
    expect(candidate.readState()).toMatchObject({ accepted: false, refusal: 'conflict' });
  });
  it('refuses a retained conditional receipt from another Home before metadata mutation', () => {
    const metadata = { modelSelectionIntentV1: { v: 1 as const, updatedAt: 20, selection } };
    const candidate = createModelIntentMetadataCasCandidate({ selection: { ...selection, modelId: 'old' }, ownerScope: scope,
      expected: { owner: 'inactive', scope: { ...scope, serverId: 'other-home' }, selection, updatedAt: 20 } });
    expect(candidate.update(metadata)).toBe(metadata);
    expect(candidate.readState()).toMatchObject({ accepted: false, refusal: 'conflict' });
  });
  it('captures only the committed candidate and refuses an intervening intent on a CAS retry', () => {
    const before = { ...selection, modelId: 'old' };
    const candidate = createModelIntentMetadataCasCandidate({ selection, captureBefore: true, ownerScope: scope, nowMs: () => 20 });
    const first = candidate.update({ modelSelectionIntentV1: { v: 1, updatedAt: 10, selection: before } });
    expect(candidate.readState()).toMatchObject({ accepted: true, reversal: {
      owner: 'inactive', scope, before, applied: selection, updatedAt: 20,
    } });
    const undo = createModelIntentMetadataCasCandidate({ selection: before, ownerScope: scope,
      expected: { owner: 'inactive', scope, selection, updatedAt: 20 }, nowMs: () => 30 });
    expect(undo.update(first).modelSelectionIntentV1).toMatchObject({ selection: before });
    const intervening = { modelSelectionIntentV1: { v: 1, updatedAt: 31, selection: { ...selection, modelId: 'newer' } } };
    expect(undo.update(intervening)).toBe(intervening);
    expect(undo.readState()).toMatchObject({ accepted: false, refusal: 'conflict' });
  });

  it('refuses capture before writing when exact canonical prior model intent is unavailable', () => {
    const candidate = createModelIntentMetadataCasCandidate({ selection, captureBefore: true, ownerScope: scope });
    const metadata = { modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'old' } };
    expect(candidate.update(metadata)).toBe(metadata);
    expect(candidate.readState()).toMatchObject({ accepted: false, refusal: 'unsupported' });
  });

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

describe('createModelIntentV2MetadataCasCandidate', () => {
  it('persists an exact Team resource selection without projecting a native Provider identity', () => {
    const candidate = createModelIntentV2MetadataCasCandidate({
      selection: {
        v: 2,
        updatedAt: 20,
        ref: teamRef,
      },
      nowMs: () => 20,
    });

    const next = candidate.update({
      modelSelectionIntentV1: { v: 1, updatedAt: 10, selection },
      modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'default' },
    });

    expect(next).toMatchObject({
      modelSelectionIntentV2: {
        v: 2,
        updatedAt: 20,
        ref: teamRef,
      },
    });
    expect(next).not.toHaveProperty('modelSelectionIntentV1');
    expect(next).not.toHaveProperty('modelOverrideV1');
    expect(candidate.readState()).toEqual({ accepted: true, updatedAt: 20 });
  });

  it('does not let a lost-response retry overwrite a newer V2 intent', () => {
    const candidate = createModelIntentV2MetadataCasCandidate({
      selection: {
        v: 2,
        updatedAt: 20,
        ref: teamRef,
      },
      nowMs: () => 20,
    });
    candidate.update({});
    const retry = candidate.update({
      modelSelectionIntentV2: {
        v: 2,
        updatedAt: 21,
        ref: { ...teamRef, resourceId: 'resource-2', modelId: 'model-b' },
      },
    });

    expect(retry).toMatchObject({
      modelSelectionIntentV2: { updatedAt: 21, ref: { resourceId: 'resource-2' } },
    });
    expect(candidate.readState()).toEqual({ accepted: false, updatedAt: 20 });
  });
});
