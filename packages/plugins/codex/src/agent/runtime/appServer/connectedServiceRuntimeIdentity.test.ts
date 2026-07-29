import { describe, expect, it } from 'vitest';

import {
  buildCodexLiveAccountRuntimeIdentity,
  type CodexConnectedServiceRuntimeIdentity,
} from './connectedServiceRuntimeIdentity.js';

describe('buildCodexLiveAccountRuntimeIdentity', () => {
  it('fails closed when live account and current selection do not match the frozen applied identity', () => {
    const previousIdentity: CodexConnectedServiceRuntimeIdentity = {
      serviceId: 'openai-codex',
      providerAccountId: 'acct_stale',
      accountLabel: 'stale@example.test',
      profileId: 'stale',
      groupId: 'team',
      generation: 7,
      credentialFingerprint: 'sha256:stale001',
      credentialRevision: null,
      source: 'spawn_selection',
    };

    expect(buildCodexLiveAccountRuntimeIdentity({
      liveProviderAccount: {
        providerAccountId: 'acct_live',
        providerEmail: 'live@example.test',
      },
      currentSelection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'team',
        activeProfileId: 'current',
        fallbackProfileId: 'backup',
        generation: 12,
      },
      previousIdentity,
    })).toBeNull();
  });

  it('fails closed instead of replacing only the account on a previous identity', () => {
    const previousIdentity: CodexConnectedServiceRuntimeIdentity = {
      serviceId: 'openai-codex',
      providerAccountId: 'acct_previous',
      accountLabel: 'previous@example.test',
      profileId: 'previous',
      groupId: 'team',
      generation: 7,
      credentialFingerprint: 'sha256:prev0001',
      credentialRevision: null,
      source: 'spawn_selection',
    };

    expect(buildCodexLiveAccountRuntimeIdentity({
      liveProviderAccount: {
        providerAccountId: 'acct_live',
        providerEmail: null,
      },
      currentSelection: null,
      previousIdentity,
    })).toBeNull();
  });

  it('refreshes diagnostics only when the live account and selection match the frozen tuple', () => {
    const previousIdentity: CodexConnectedServiceRuntimeIdentity = {
      serviceId: 'openai-codex',
      providerAccountId: 'acct_live',
      accountLabel: null,
      profileId: 'current',
      groupId: 'team',
      generation: 12,
      credentialFingerprint: 'sha256:current1',
      credentialRevision: null,
      source: 'spawn_selection',
    };
    expect(buildCodexLiveAccountRuntimeIdentity({
      liveProviderAccount: { providerAccountId: 'acct_live', providerEmail: 'live@example.test' },
      currentSelection: {
        kind: 'group', serviceId: 'openai-codex', groupId: 'team', activeProfileId: 'current', generation: 12,
      },
      previousIdentity,
    })).toEqual({
      ...previousIdentity,
      accountLabel: 'live@example.test',
      source: 'live_account_read',
    });
  });
});
