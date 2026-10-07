import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { buildConnectedServiceCredentialRecord, type ConnectedServiceBindingsV2, QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { TrackedSession } from '@/daemon/types';
import type { Credentials, StoredCredentials } from '@/persistence';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from './materializeSessionConnectedServiceRuntimeAuthSelection';
import { resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';

function qualifiedApiForRecord(record: ReturnType<typeof buildConnectedServiceCredentialRecord>) {
  const service = resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId(record.serviceId);
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
    ref: { service, accountId: record.profileId },
    authenticationModeId: record.kind === 'oauth' ? 'oauth' : 'api-key',
    revisionSemantics: 'revisioned', credentialRevision: CREDENTIAL_REVISION,
    configurationRevision: null, content: { t: 'plain', v: record }, metadata: { scopes: [] },
  }) });
  return {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceCredentialPlain: vi.fn(async () => { throw new Error('V2 credential read forbidden'); }),
    getConnectedServiceCredentialSealed: vi.fn(async () => { throw new Error('V2 credential read forbidden'); }),
  };
}

const CREDENTIAL_REVISION = 'csr_0123456789ABCDEFGHJKMNPQRS';
const CODEX_SERVICE_KEY = 'happier.agent.codex/openai-codex';
const ANTHROPIC_SERVICE_KEY = 'happier.agent.claude/anthropic';
const CLAUDE_SUBSCRIPTION_SERVICE_KEY = 'happier.agent.claude/claude-subscription';

describe('materializeSessionConnectedServiceRuntimeAuthSelection', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(['device', 'oauth', 'manual'])('preserves the exact native credential contract for %s mode', async (authenticationModeId) => {
    const credentialRevision = CREDENTIAL_REVISION;
    const bindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [CODEX_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
      },
    };
    const tracked = {
      startedBy: 'daemon',
      happySessionId: 'sess_revision',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: bindings,
        environmentVariables: {},
      },
    } as TrackedSession;
    const credential = { v: 1 as const, values: { accessToken: 'access', refreshToken: 'refresh', providerAccountId: 'acct-work' } };
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      expect(new URL(String(url)).pathname).toBe('/v4/connect/qualified/credential');
      return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
        authenticationModeId, revisionSemantics: 'revisioned', credentialRevision,
        configurationRevision: null, content: { t: 'plain', v: credential }, metadata: { scopes: [] },
      }) };
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => { throw new Error('V2 credential read forbidden'); }),
      getConnectedServiceCredentialSealed: vi.fn(async () => { throw new Error('V2 credential read forbidden'); }),
    };

    const credentials = {
      token: 'token',
      encryption: null,
    } satisfies StoredCredentials;

    const pendingSelection = materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_revision',
        agentId: 'codex',
        serviceId: CODEX_SERVICE_KEY,
        previous: { source: 'connected', selection: 'profile', serviceId: CODEX_SERVICE_KEY, profileId: 'work', groupId: null },
        next: { source: 'connected', selection: 'profile', serviceId: CODEX_SERVICE_KEY, profileId: 'work', groupId: null },
        previousBindings: bindings,
        normalizedBindings: bindings,
      },
    });

    if (authenticationModeId === 'manual') {
      await expect(pendingSelection).rejects.toThrow('authentication mode has no native credential projection');
      return;
    }
    const selection = await pendingSelection;
    expect(selection).toMatchObject({ credential: {
      kind: 'oauth', serviceId: 'openai-codex', profileId: 'work',
      oauth: { accessToken: 'access', refreshToken: 'refresh', raw: {
        happierQualifiedConnectedAccountCredentialV1: {
          authenticationModeId, payload: credential,
        },
      } },
    }, credentialRevision });
    expect(selection).not.toHaveProperty('targetMaterializedRoot');
  });

  it('preserves group fallback profile and generation from the current session selection env', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'backup',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = qualifiedApiForRecord(record);
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: previousBindings,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: ANTHROPIC_SERVICE_KEY,
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'fallback',
              generation: 7,
            },
          ]),
        },
      },
    };

    const normalizedBindings = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'backup' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: ANTHROPIC_SERVICE_KEY,
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
      },
    })).resolves.toMatchObject({
      serviceId: ANTHROPIC_SERVICE_KEY,
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 7,
      credential: expect.objectContaining({ serviceId: record.serviceId, profileId: record.profileId, kind: record.kind }),
    });
  });

  it('uses group metadata active profile when the normalized group binding omits optional profileId', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'backup',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = qualifiedApiForRecord(record);
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: previousBindings,
        environmentVariables: {},
      },
    };
    const normalizedBindings = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: ANTHROPIC_SERVICE_KEY,
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: null,
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 8,
        },
      },
    })).resolves.toMatchObject({
      serviceId: ANTHROPIC_SERVICE_KEY,
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 8,
      credential: expect.objectContaining({ serviceId: record.serviceId, profileId: record.profileId, kind: record.kind }),
    });
    expect(api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  it('uses the previous child group active profile when unchanged group rematerialization omits profileId', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = qualifiedApiForRecord(record);
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: previousBindings,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: ANTHROPIC_SERVICE_KEY,
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'fallback',
              generation: 7,
            },
          ]),
        },
      },
    };
    const normalizedBindings = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: ANTHROPIC_SERVICE_KEY,
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: null,
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: null,
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
      },
    })).resolves.toMatchObject({
      serviceId: ANTHROPIC_SERVICE_KEY,
      profileId: 'primary',
      groupId: 'work',
      activeProfileId: 'primary',
      fallbackProfileId: 'fallback',
      generation: 7,
      credential: expect.objectContaining({ serviceId: record.serviceId, profileId: record.profileId, kind: record.kind }),
    });
  });

  it('prefers authoritative group metadata over stale current session selection env', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'anthropic',
      profileId: 'backup',
      kind: 'token',
      token: {
        token: 'sk-ant',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const api = qualifiedApiForRecord(record);
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'primary' },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: previousBindings,
        environmentVariables: {
          [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
            {
              kind: 'group',
              serviceId: ANTHROPIC_SERVICE_KEY,
              groupId: 'work',
              activeProfileId: 'primary',
              fallbackProfileId: 'stale-fallback',
              generation: 7,
            },
          ]),
        },
      },
    };
    const normalizedBindings = {
      v: 2,
      bindingsByServiceId: {
        [ANTHROPIC_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'work', profileId: 'backup' },
      },
    } as const;

    await expect(materializeSessionConnectedServiceRuntimeAuthSelection({
      credentials,
      api: api as unknown as ApiClient,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: ANTHROPIC_SERVICE_KEY,
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: ANTHROPIC_SERVICE_KEY,
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fresh-fallback',
          generation: 8,
        },
      },
    })).resolves.toMatchObject({
      serviceId: ANTHROPIC_SERVICE_KEY,
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fresh-fallback',
      generation: 8,
      credential: expect.objectContaining({ serviceId: record.serviceId, profileId: record.profileId, kind: record.kind }),
    });
  });

  it('returns the canonical Claude selection without reviving the retired catalog side-effect materializer', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: 2_000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const api = qualifiedApiForRecord(record);
    const credentials: Credentials = {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const previousBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'primary',
        },
      },
    };
    const normalizedBindings: ConnectedServiceBindingsV2 = {
      v: 2,
      bindingsByServiceId: {
        [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: {
          source: 'connected',
          selection: 'group',
          groupId: 'work',
          profileId: 'backup',
        },
      },
    };
    const tracked: TrackedSession = {
      startedBy: 'daemon',
      happySessionId: 'sess_1',
      pid: 123,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: previousBindings,
        environmentVariables: {
          CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token-must-not-propagate',
          CLAUDE_CODE_SETUP_TOKEN: 'ambient-setup-must-not-propagate',
        },
      },
    };

    const activeServerDir = '/tmp/happier-active-server';
    const params = {
      credentials,
      api: api as unknown as ApiClient,
      activeServerDir,
      input: {
        mode: 'apply',
        tracked,
        sessionId: 'sess_1',
        agentId: 'claude',
        serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY,
        previous: {
          source: 'connected',
          selection: 'group',
          serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY,
          profileId: 'primary',
          groupId: 'work',
        },
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY,
          profileId: 'backup',
          groupId: 'work',
        },
        previousBindings,
        normalizedBindings,
        groupMetadata: {
          groupId: 'work',
          activeProfileId: 'backup',
          fallbackProfileId: 'fallback',
          generation: 3,
        },
      },
      accountSettings: null,
      processEnv: {
        CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token-must-not-propagate',
        CLAUDE_CODE_SETUP_TOKEN: 'ambient-setup-must-not-propagate',
      },
    } satisfies Parameters<typeof materializeSessionConnectedServiceRuntimeAuthSelection>[0] & {
      activeServerDir?: string;
    };

    const result = await materializeSessionConnectedServiceRuntimeAuthSelection(params);

    expect(result).toMatchObject({
      serviceId: CLAUDE_SUBSCRIPTION_SERVICE_KEY,
      profileId: 'backup',
      groupId: 'work',
      activeProfileId: 'backup',
      fallbackProfileId: 'fallback',
      generation: 3,
      credential: expect.objectContaining({ serviceId: record.serviceId, profileId: record.profileId, kind: record.kind }),
    });
    expect(result).not.toHaveProperty('targetMaterializedRoot');
    expect(result).not.toHaveProperty('targetMaterializedEnv');
  });
});
