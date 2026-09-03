import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  buildCodexConnectedServiceRuntimeAuthApplyRequest,
  parseCodexConnectedServiceRuntimeAuthApplyRequest,
} from './codexConnectedServiceRuntimeAuthContract';

describe('codexConnectedServiceRuntimeAuthContract', () => {
  it('builds and parses direct-live runtime auth apply payloads through one provider-owned contract', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_live',
        providerEmail: 'codex-user@example.test',
      },
    });

    const request = buildCodexConnectedServiceRuntimeAuthApplyRequest({
      record,
      reason: 'same_provider_account_exhausted',
      forcedWorkspaceId: 'workspace-1',
      selection: {
        groupId: 'team',
        activeProfileId: 'primary',
        fallbackProfileId: 'backup',
        generation: 4,
        forcedLoginMethod: 'chatgpt',
      },
    });

    expect(request).toEqual({
      serviceId: 'openai-codex',
      reason: 'same_provider_account_exhausted',
      expected: {
        profileId: 'primary',
        groupId: 'team',
        generation: 4,
      },
      authGeneration: {
        credential: record,
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'primary',
          fallbackProfileId: 'backup',
          generation: 4,
        },
        forcedWorkspaceId: 'workspace-1',
        forcedLoginMethod: 'chatgpt',
      },
    });
    expect(parseCodexConnectedServiceRuntimeAuthApplyRequest(request)).toEqual({
      serviceId: 'openai-codex',
      candidate: record,
      forcedWorkspaceId: 'workspace-1',
      forcedLoginMethod: 'chatgpt',
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'team',
        activeProfileId: 'primary',
        fallbackProfileId: 'backup',
        generation: 4,
      },
      expected: {
        profileId: 'primary',
        groupId: 'team',
        generation: 4,
      },
      reason: 'same_provider_account_exhausted',
    });
  });

  it('rejects malformed direct-live runtime auth apply payloads before app-server mutation', () => {
    expect(parseCodexConnectedServiceRuntimeAuthApplyRequest({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      authGeneration: {
        selection: {
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'primary',
        },
      },
    })).toBeNull();
    expect(parseCodexConnectedServiceRuntimeAuthApplyRequest({
      serviceId: 'other-service',
      reason: 'usage_limit',
      authGeneration: {
        credential: {},
      },
    })).toBeNull();
  });
});
