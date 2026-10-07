import { describe, expect, it } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { readConnectedServiceCredentialApplicationState } from './credentialApplicationState';

describe('connected-service credential application admission', () => {
  it.each(['openai-codex', 'happier.agent.codex/openai-codex'])('retains the actual selected pool member and generation for %s ingress', (serviceId) => {
    const state = readConnectedServiceCredentialApplicationState({
      serviceId,
      connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'selected' },
      } },
      connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group', serviceId: 'happier.agent.codex/openai-codex', groupId: 'pool', activeProfileId: 'selected',
        fallbackProfileId: 'fallback', generation: 7, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }]) },
    });
    expect(state?.binding).toEqual({ source: 'connected', selection: 'group', groupId: 'pool', profileId: 'selected' });
    expect(state?.childSelection).toMatchObject({ kind: 'group', groupId: 'pool', activeProfileId: 'selected',
      fallbackProfileId: 'fallback', generation: 7, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' });
  });
});
