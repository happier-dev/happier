import { describe, expect, it } from 'vitest';

import { deriveSessionCreationTagV1 } from './sessionCreationIdentityV1.js';
import {
  deserializeSessionCreationCorrespondenceV1,
  normalizeSessionCreationOrganizationPlacementV1,
  SessionCreationCorrespondenceV1Schema,
  serializeSessionCreationCorrespondenceV1,
  sessionCreationCorrespondenceMatchesV1,
} from './sessionCreationCorrespondenceV1.js';

const correspondence = {
  v: 1,
  sessionCreationTag: deriveSessionCreationTagV1({
    callerCreationNamespace: 'user',
    creationKey: 'manual:attempt-1',
  }),
  recipe: {
    execution: { machineId: 'machine-1', directory: '/workspace/project' },
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

  it('round-trips through the bounded daemon-to-runner carrier', () => {
    const encoded = serializeSessionCreationCorrespondenceV1(correspondence);

    expect(encoded).toMatch(/^scv1:[A-Za-z0-9_-]+$/u);
    expect(deserializeSessionCreationCorrespondenceV1(encoded)).toEqual(correspondence);
    expect(() => deserializeSessionCreationCorrespondenceV1(`${encoded}=`)).toThrow(
      'Invalid Session creation correspondence transport',
    );
  });
});
