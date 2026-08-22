import { describe, expect, it } from 'vitest';

import {
  parseConnectedServiceProjectionSnapshot,
  publishObservedConnectedServiceProjectionThenApply,
} from './connectedServiceProjectionSnapshot';

describe('parseConnectedServiceProjectionSnapshot', () => {
  it('retains novel qualified Account V4 truth without downconverting it into the legacy service projection', () => {
    const service = {
      pluginId: 'acme.connected-accounts',
      localId: 'external-service',
    } as const;
    const account = {
      ref: { service, accountId: 'external-account' },
      status: 'connected',
      authenticationModeId: 'manual',
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
      configurationReady: false,
      configurationRevision: null,
      displayName: 'External account',
      scopes: [],
    } as const;
    const group = {
      v: 1,
      ref: { service, groupId: 'external-fallbacks' },
      incarnation: 'qualified-group-row-external-fallbacks',
      displayName: null,
      policy: {},
      activeConnectedAccountId: 'external-account',
      generation: 4,
      runtimeStateRevision: 2,
      state: {},
      createdAt: 1,
      updatedAt: 1,
      members: [],
    } as const;
    const projection = {
      connectedServicesV2: [],
      connectedServiceCredentialRevisionsV1: [],
      connectedAccountsV4: [account],
      connectedAccountGroupsV4: [group],
    };

    const snapshot = parseConnectedServiceProjectionSnapshot(projection);

    expect(snapshot.groups).toEqual([]);
    expect(snapshot).toMatchObject({
      qualifiedAccounts: [account],
      qualifiedGroups: [group],
    });
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
