import assert from 'node:assert/strict';
import { it } from 'vitest';

import { SessionCreationCorrespondenceV1Schema, SessionCreationCorrespondenceV1ReadSchema } from './sessionCreationCorrespondenceV1.js';
import { deriveSessionCreationTagV1 } from './sessionCreationIdentityV1.js';

const correspondence = {
  v: 1,
  sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'preset-session' }),
  recipe: {
    execution: { machineId: 'controller', directory: { kind: 'path', path: '/workspace' } },
    organization: { folderId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
    configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
    terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null,
  },
};

for (const origin of ['machine_policy', 'session_defaults']) {
  it(`retains ${origin} provenance through Session birth and stored reads`, () => {
    const selected = { ...correspondence, recipe: { ...correspondence.recipe,
      managedCreationOrigin: origin, nativeSandboxOrigin: origin } };
    for (const schema of [SessionCreationCorrespondenceV1Schema, SessionCreationCorrespondenceV1ReadSchema]) {
      const parsed = schema.parse(selected);
      assert.equal(parsed.recipe.managedCreationOrigin, origin);
      assert.equal(parsed.recipe.nativeSandboxOrigin, origin);
    }
  });
}

it('refuses unrecognized provenance at the immutable recipe boundary', () => {
  for (const field of ['managedCreationOrigin', 'nativeSandboxOrigin']) {
    assert.equal(SessionCreationCorrespondenceV1Schema.safeParse({ ...correspondence,
      recipe: { ...correspondence.recipe, [field]: 'unrecognized' } }).success, false);
  }
});
