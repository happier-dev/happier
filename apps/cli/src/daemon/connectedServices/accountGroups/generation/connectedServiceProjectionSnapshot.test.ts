import { describe, expect, it } from 'vitest';

import {
  parseConnectedServiceProjectionSnapshot,
  publishObservedConnectedServiceProjectionThenApply,
} from './connectedServiceProjectionSnapshot';

describe('parseConnectedServiceProjectionSnapshot', () => {
  it('projects nothing for a service that has no legacy connected-service id', () => {
    // Novel qualified services have no legacy V2 projection. Their daemon consumers read
    // V4 truth directly instead of manufacturing a scalar identity here.
    const snapshot = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
    });

    expect(snapshot.groups).toEqual([]);
    expect(snapshot.credentialRevisions).toEqual([]);
    expect(snapshot.resolveCredentialPresence(
      'happier.agent.claude/anthropic',
      'external-account',
    )).toEqual({ status: 'absent' });
  });

  it('keeps credential revision separate from group generation and distinguishes absent from legacy unfenced credentials', () => {
    const snapshot = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{
        serviceId: 'anthropic',
        profiles: [
          { profileId: 'profile-a', status: 'connected' },
          { profileId: 'profile-b', status: 'connected' },
        ],
        groups: [
          { groupId: 'group-a', activeProfileId: 'profile-a', generation: 9, memberProfileIds: ['profile-a'] },
          { groupId: 'group-b', activeProfileId: 'profile-b', generation: 9, memberProfileIds: ['profile-b'] },
        ],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'anthropic',
        profileId: 'profile-a',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }],
    });

    expect(snapshot.groups).toEqual([
      { serviceId: 'happier.agent.claude/anthropic', groupId: 'group-a', activeProfileId: 'profile-a', generation: 9 },
      { serviceId: 'happier.agent.claude/anthropic', groupId: 'group-b', activeProfileId: 'profile-b', generation: 9 },
    ]);
    expect(snapshot.resolveCredentialRevision('happier.agent.claude/anthropic', 'profile-a')).toBe('csr_aaaaaaaaaaaaaaaaaaaaaa');
    expect(snapshot.resolveCredentialRevision('happier.agent.claude/anthropic', 'profile-b')).toBeNull();
    expect(snapshot.resolveCredentialPresence('happier.agent.claude/anthropic', 'profile-a')).toEqual({
      status: 'present',
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(snapshot.resolveCredentialPresence('happier.agent.claude/anthropic', 'profile-b')).toEqual({
      status: 'legacy_unfenced',
    });
    expect(snapshot.resolveCredentialPresence('happier.agent.claude/anthropic', 'deleted')).toEqual({
      status: 'absent',
    });
  });

  it('does not roll back observed credential truth when downstream runtime application fails', async () => {
    const oldProjection = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'connected' }],
        groups: [],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }],
    });
    const newProjection = parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'connected' }],
        groups: [],
      }],
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      }],
    });
    let observed = oldProjection;
    const publications: typeof newProjection[] = [];

    await expect(publishObservedConnectedServiceProjectionThenApply({
      projection: newProjection,
      publishObserved(projection) {
        observed = projection;
        publications.push(projection);
      },
      applyToRuntime: async () => {
        throw new Error('runtime_application_failed');
      },
    })).rejects.toThrow('runtime_application_failed');

    expect(observed).toBe(newProjection);
    expect(publications).toEqual([newProjection]);
    expect(observed.resolveCredentialRevision('happier.agent.codex/openai-codex', 'work'))
      .toBe('csr_bbbbbbbbbbbbbbbbbbbbbb');
  });
});
