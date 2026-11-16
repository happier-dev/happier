import { describe, expect, it } from 'vitest';
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { readSessionSandboxPlacement } from './useSessionSandboxPlacement';

const managedCreation = { homeId: 'home', managedId: 'sandbox',
  controller: { machineId: 'controller', installationId: 'installation' } };
const correspondence = buildSessionCreationCorrespondence({
  identity: { callerCreationNamespace: 'account', creationKey: 'retained-session' },
  recipe: {
    execution: { machineId: 'controller', directory: { kind: 'managed' } },
    organization: { folderId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'fixture.agent', localId: 'coder' } },
    managedCreation, managedCreationOrigin: 'machine_policy',
  },
});

describe('Session sandbox placement', () => {
  it.each([0, 1])('reads the admitted retained sandbox reference from owner metadata layout %s', metadataLayoutVersion => {
    const metadata = { sessionCreationCorrespondenceV1: correspondence };
    expect(readSessionSandboxPlacement({ metadataLayoutVersion, metadata,
      ...(metadataLayoutVersion === 1 ? { ownerMetadataView: metadata } : {}) })).toEqual(managedCreation);
  });

  it('does not classify an explicitly created remote Machine as a policy sandbox', () => {
    const { managedCreationOrigin: _origin, ...recipe } = correspondence.recipe;
    expect(readSessionSandboxPlacement({ metadata: { sessionCreationCorrespondenceV1: { ...correspondence, recipe } } })).toBeNull();
  });

  it('does not borrow a shared metadata reference when its owner view is unavailable', () => {
    const metadata = { sessionCreationCorrespondenceV1: correspondence };
    expect(readSessionSandboxPlacement({ metadataLayoutVersion: 1, metadata, ownerMetadataView: null })).toBeNull();
  });

  it('leaves corrupt retained correspondence unavailable', () => {
    expect(readSessionSandboxPlacement({ metadata: { sessionCreationCorrespondenceV1: { ...correspondence,
      recipe: { ...correspondence.recipe, managedCreation: { ...managedCreation, managedId: 42 } } } } })).toBeNull();
  });
});
