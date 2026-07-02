import { describe, expect, it } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceBindingsV1Schema,
} from '@happier-dev/protocol';

import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  readConnectedServiceMaterializedEnvKeysFromEnv,
  readConnectedServiceChildSelectionsFromEnv,
  resolveConnectedServiceRuntimeAuthContextFromSessionMetadata,
  resolveConnectedServiceRuntimeAuthContextFromEnv,
  resolveConnectedServiceRuntimeAuthContextFromSelection,
  serializeConnectedServiceMaterializedEnvKeys,
  serializeConnectedServiceChildSelections,
} from './connectedServiceChildEnvironment';

describe('connectedServiceChildEnvironment', () => {
  it('serializes connected-service selections without credential records', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'secret-access',
        refreshToken: 'secret-refresh',
        idToken: 'secret-id',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const serialized = serializeConnectedServiceChildSelections(new Map([
      ['openai-codex', {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        activeProfileId: 'work',
        fallbackProfileId: 'work',
        generation: 3,
        policy: { v: 1 },
        record,
      }],
    ]));

    expect(serialized).not.toBeNull();
    expect(serialized).not.toContain('secret-access');
    const selections = readConnectedServiceChildSelectionsFromEnv({
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serialized ?? undefined,
    });
    expect(selections?.get('openai-codex')).toMatchObject({
      kind: 'group',
      groupId: 'codex-main',
      activeProfileId: 'work',
      generation: 3,
    });
  });

  it('resolves runtime auth context from a selected group', () => {
    expect(resolveConnectedServiceRuntimeAuthContextFromSelection({
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'happier',
      activeProfileId: 'bot',
      fallbackProfileId: 'leeroy',
      generation: 3,
      policy: { v: 1 },
    }, 'openai-codex')).toEqual({
      serviceId: 'openai-codex',
      profileId: 'bot',
      groupId: 'happier',
    });
  });

  it('resolves runtime auth context from child process env', () => {
    expect(resolveConnectedServiceRuntimeAuthContextFromEnv({
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'leeroy',
      }]),
    }, 'openai-codex')).toEqual({
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      groupId: null,
    });
  });

  it('resolves runtime auth context from current session connected-service metadata', () => {
    const connectedServices = ConnectedServiceBindingsV1Schema.parse({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          serviceId: 'openai-codex',
          groupId: 'codex',
          profileId: 'backup',
        },
      },
    });

    expect(resolveConnectedServiceRuntimeAuthContextFromSessionMetadata({
      getMetadataSnapshot: () => ({ connectedServices }),
    }, 'openai-codex')).toEqual({
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'codex',
    });
  });

  it('serializes materialized env keys without values', () => {
    const serialized = serializeConnectedServiceMaterializedEnvKeys({
      CLAUDE_CODE_OAUTH_TOKEN: 'secret-token',
      CLAUDE_CONFIG_DIR: '/tmp/connected-claude',
    });

    expect(serialized).not.toContain('secret-token');
    expect(readConnectedServiceMaterializedEnvKeysFromEnv({
      [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: serialized ?? undefined,
    })).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']);
  });
});
