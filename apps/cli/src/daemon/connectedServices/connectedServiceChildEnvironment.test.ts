import { describe, expect, it } from 'vitest';

import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol';

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
    const serialized = serializeConnectedServiceChildSelections(new Map([
      ['happier.agent.codex/openai-codex', {
        kind: 'group',
        serviceId: 'happier.agent.codex/openai-codex',
        groupId: 'codex-main',
        activeProfileId: 'work',
        fallbackProfileId: 'work',
        generation: 3,
        policy: { v: 1 },
        // Persist only the explicit non-secret selection projection even if a
        // predecessor/in-memory producer supplies an extra credential-shaped
        // property at this serialization boundary.
        record: { accessToken: 'secret-access', refreshToken: 'secret-refresh' },
      }],
    ] as unknown as Parameters<typeof serializeConnectedServiceChildSelections>[0]));

    expect(serialized).not.toBeNull();
    expect(serialized).not.toContain('secret-access');
    expect(serialized).not.toContain('secret-refresh');
    const selections = readConnectedServiceChildSelectionsFromEnv({
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serialized ?? undefined,
    });
    expect(selections?.get('happier.agent.codex/openai-codex')).toMatchObject({
      kind: 'group',
      groupId: 'codex-main',
      activeProfileId: 'work',
      generation: 3,
    });
  });

  it('resolves runtime auth context from a selected group', () => {
    expect(resolveConnectedServiceRuntimeAuthContextFromSelection({
      kind: 'group',
      serviceId: 'happier.agent.codex/openai-codex',
      groupId: 'happier',
      activeProfileId: 'bot',
      fallbackProfileId: 'leeroy',
      generation: 3,
      policy: { v: 1 },
    }, 'happier.agent.codex/openai-codex')).toEqual({
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'bot',
      groupId: 'happier',
      groupGeneration: 3,
    });
  });

  it('resolves runtime auth context from child process env', () => {
    expect(resolveConnectedServiceRuntimeAuthContextFromEnv({
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'profile',
        serviceId: 'happier.agent.codex/openai-codex',
        profileId: 'leeroy',
      }]),
    }, 'happier.agent.codex/openai-codex')).toEqual({
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'leeroy',
      groupId: null,
    });
  });

  it('resolves runtime auth context from current session connected-service metadata', () => {
    const connectedServices = ConnectedServiceBindingsV1Schema.parse({
      v: 1,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': {
          source: 'connected',
          selection: 'group',
          serviceId: 'happier.agent.codex/openai-codex',
          groupId: 'codex',
          profileId: 'backup',
          groupGeneration: 7,
        },
      },
    });

    expect(resolveConnectedServiceRuntimeAuthContextFromSessionMetadata({
      getMetadataSnapshot: () => ({ connectedServices }),
    }, 'happier.agent.codex/openai-codex')).toEqual({
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'backup',
      groupId: 'codex',
      groupGeneration: 7,
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
