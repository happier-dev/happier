import { describe, expect, it } from 'vitest';

import {
  buildCodexLiveAccountRuntimeIdentity,
  type CodexConnectedServiceRuntimeIdentity,
} from './connectedServiceRuntimeIdentity.js';

describe('buildCodexLiveAccountRuntimeIdentity', () => {
  it('uses current connected-service selection instead of preserving stale cached identity metadata', () => {
    const previousIdentity: CodexConnectedServiceRuntimeIdentity = {
      serviceId: 'openai-codex',
      providerAccountId: 'acct_stale',
      accountLabel: 'stale@example.test',
      profileId: 'stale',
      groupId: 'team',
      generation: 7,
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
    })).toEqual({
      serviceId: 'openai-codex',
      providerAccountId: 'acct_live',
      accountLabel: 'live@example.test',
      profileId: 'current',
      groupId: 'team',
      generation: 12,
      source: 'live_account_read',
    });
  });

  it('falls back to previous identity metadata when no current selection is available', () => {
    const previousIdentity: CodexConnectedServiceRuntimeIdentity = {
      serviceId: 'openai-codex',
      providerAccountId: 'acct_previous',
      accountLabel: 'previous@example.test',
      profileId: 'previous',
      groupId: 'team',
      generation: 7,
      source: 'spawn_selection',
    };

    expect(buildCodexLiveAccountRuntimeIdentity({
      liveProviderAccount: {
        providerAccountId: 'acct_live',
        providerEmail: null,
      },
      currentSelection: null,
      previousIdentity,
    })).toEqual({
      serviceId: 'openai-codex',
      providerAccountId: 'acct_live',
      accountLabel: 'previous@example.test',
      profileId: 'previous',
      groupId: 'team',
      generation: 7,
      source: 'live_account_read',
    });
  });
});
