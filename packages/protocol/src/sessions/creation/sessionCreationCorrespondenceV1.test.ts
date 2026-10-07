import { describe, expect, it } from 'vitest';

import { deriveSessionCreationTagV1 } from './sessionCreationIdentityV1.js';
import {
  normalizeSessionCreationOrganizationPlacementV1,
  SessionCreationCorrespondenceV1Schema,
  sessionCreationCorrespondenceMatchesV1,
} from './sessionCreationCorrespondenceV1.js';

const correspondence = {
  v: 1,
  sessionCreationTag: deriveSessionCreationTagV1({
    callerCreationNamespace: 'user',
    creationKey: 'manual:attempt-1',
  }),
  recipe: {
    execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/workspace/project' } },
    organization: { folderId: null, tagIds: ['tag-a', 'tag-b'] },
    agentTarget: {
      kind: 'agent',
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    },
    modelSelection: null,
    profileId: null,
    requestedPermissionMode: null,
    agentModeId: null,
    configuration: null,
    connectedServices: null,
    mcpSelection: null,
    transcriptStorage: null,
    terminal: null,
    agentSessionStartupInstructionsMarkerV1: null,
    checkout: null,
  },
} as const;

describe('SessionCreationCorrespondenceV1', () => {
  it('matches managed retries by intent and rejects a managed versus path correspondence', () => {
    const managed = { ...correspondence, recipe: { ...correspondence.recipe,
      execution: { ...correspondence.recipe.execution, directory: { kind: 'managed' } },
    } };
    expect(sessionCreationCorrespondenceMatchesV1(managed, managed)).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(managed, correspondence)).toBe(false);
    expect(SessionCreationCorrespondenceV1Schema.safeParse({ ...managed, recipe: {
      ...managed.recipe,
      checkout: { kind: 'git_worktree', finalDirectory: '/checkout', baseRef: null, branchMode: 'new' },
    } }).success).toBe(false);
  });
  it('strictly validates one bounded immutable recipe', () => {
    expect(SessionCreationCorrespondenceV1Schema.parse(correspondence)).toEqual(correspondence);
    expect(SessionCreationCorrespondenceV1Schema.safeParse({
      ...correspondence,
      title: 'mutable presentation is excluded',
    }).success).toBe(false);
  });

  it('normalizes placement tag order before correspondence', () => {
    expect(normalizeSessionCreationOrganizationPlacementV1({
      folderId: null,
      tagIds: ['tag-b', 'tag-a'],
    })).toEqual({ folderId: null, tagIds: ['tag-a', 'tag-b'] });
  });

  it('detects a semantic mismatch without hashing the recipe', () => {
    expect(sessionCreationCorrespondenceMatchesV1(correspondence, correspondence)).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(correspondence, {
      ...correspondence,
      recipe: {
        ...correspondence.recipe,
        execution: { ...correspondence.recipe.execution, machineId: 'machine-2' },
      },
    })).toBe(false);
  });

  it('compares known retained correspondence fields without admitting unknown request fields', () => {
    const retained = {
      ...correspondence,
      futureField: true,
      recipe: { ...correspondence.recipe, execution: {
        ...correspondence.recipe.execution,
        directory: { ...correspondence.recipe.execution.directory, futureField: true },
      } },
    };
    expect(SessionCreationCorrespondenceV1Schema.safeParse(retained).success).toBe(false);
    expect(sessionCreationCorrespondenceMatchesV1(retained, correspondence)).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(retained, {
      ...correspondence,
      recipe: { ...correspondence.recipe, execution: {
        ...correspondence.recipe.execution, directory: { kind: 'managed' },
      } },
    })).toBe(false);
  });

  it('ignores only model ordering time while retaining semantic model, provider and configuration differences', () => {
    const selected = {
      ...correspondence,
      recipe: {
        ...correspondence.recipe,
        modelSelection: {
          v: 1,
          ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'model-a' },
          updatedAt: 1,
        },
      },
    };
    const retried = {
      ...selected,
      recipe: { ...selected.recipe, modelSelection: { ...selected.recipe.modelSelection, updatedAt: 2 } },
    };
    expect(SessionCreationCorrespondenceV1Schema.safeParse(selected).success).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(selected, retried)).toBe(true);
    for (const ref of [
      { ...selected.recipe.modelSelection.ref, modelId: 'model-b' },
      { ...selected.recipe.modelSelection.ref, providerConnectionId: 'pc_other' },
      { ...selected.recipe.modelSelection.ref, agentTargetKey: 'agent:happier.agent.claude/claude' },
    ]) {
      expect(sessionCreationCorrespondenceMatchesV1(selected, {
        ...retried,
        recipe: { ...retried.recipe, modelSelection: { ...retried.recipe.modelSelection, ref } },
      })).toBe(false);
    }
    expect(sessionCreationCorrespondenceMatchesV1(selected, {
      ...retried,
      recipe: { ...retried.recipe, profileId: 'profile-other' },
    })).toBe(false);
    const configuration = {
      mode: { value: null, updatedAtMs: 1 },
      model: { value: null, updatedAtMs: 1 },
      permissionIntent: { value: null, updatedAtMs: 1 },
      options: { reasoning: { value: 'medium', updatedAtMs: 1 } },
    };
    const configured = { ...selected, recipe: { ...selected.recipe, configuration } };
    expect(SessionCreationCorrespondenceV1Schema.safeParse(configured).success).toBe(true);
    expect(sessionCreationCorrespondenceMatchesV1(configured, {
      ...retried,
      recipe: {
        ...retried.recipe,
        configuration: { ...configuration, options: { reasoning: { value: 'high', updatedAtMs: 1 } } },
      },
    })).toBe(false);
  });
});
