import { describe, expect, it } from 'vitest';

import {
  parseConnectedServiceProjectionSnapshot,
  publishObservedConnectedServiceProjectionThenApply,
} from './connectedServiceProjectionSnapshot';

describe('parseConnectedServiceProjectionSnapshot', () => {
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
      { serviceId: 'anthropic', groupId: 'group-a', activeProfileId: 'profile-a', generation: 9 },
      { serviceId: 'anthropic', groupId: 'group-b', activeProfileId: 'profile-b', generation: 9 },
    ]);
    expect(snapshot.resolveCredentialRevision('anthropic', 'profile-a')).toBe('csr_aaaaaaaaaaaaaaaaaaaaaa');
    expect(snapshot.resolveCredentialRevision('anthropic', 'profile-b')).toBeNull();
    expect(snapshot.resolveCredentialPresence('anthropic', 'profile-a')).toEqual({
      status: 'present',
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(snapshot.resolveCredentialPresence('anthropic', 'profile-b')).toEqual({
      status: 'legacy_unfenced',
    });
    expect(snapshot.resolveCredentialPresence('anthropic', 'deleted')).toEqual({
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
    expect(observed.resolveCredentialRevision('openai-codex', 'work'))
      .toBe('csr_bbbbbbbbbbbbbbbbbbbbbb');
  });
});
