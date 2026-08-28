import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildConnectedServiceCredentialRecord,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveExecutablePluginRuntimeRegistry,
  type ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import {
  createExactV021ConnectedServiceMaterializationOwner,
  materializeExactV021AgentLaunchProjection,
} from './exactV021ConnectedServiceMaterialization';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('exact v0.2.1 Connected Service one-shot materialization', () => {
  it('adapts a released unfenced Codex record through the current focused service codec', async () => {
    const happyHomeDir = await mkdtemp(join(
      tmpdir(),
      'happier-exact-v021-connected-service-',
    ));
    temporaryRoots.push(happyHomeDir);
    let registry: ResolvedExecutablePluginRuntimeRegistry | null = null;

    try {
      registry = await resolveExecutablePluginRuntimeRegistry({
        happyHomeDir,
        pluginIds: ['happier.agent.codex'],
      });
      const service = Object.freeze({
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      });
      const account = Object.freeze({ service, accountId: 'work' });
      const purpose = Object.freeze({
        consumer: Object.freeze({
          pluginId: 'happier.agent.codex',
          localId: 'codex',
        }),
        purpose: 'primary',
      });
      const record = buildConnectedServiceCredentialRecord({
        now: 10,
        serviceId: 'openai-codex',
        profileId: 'work',
        kind: 'oauth',
        expiresAt: null,
        oauth: {
          accessToken: 'legacy-access',
          refreshToken: 'legacy-refresh',
          idToken: 'legacy-id-token',
          scope: 'openid profile',
          tokenType: 'bearer',
          providerAccountId: 'legacy-account',
          providerEmail: null,
        },
      });

      const owner = createExactV021ConnectedServiceMaterializationOwner({
        registry,
        purposeBindings: Object.freeze([Object.freeze({
          purpose,
          target: Object.freeze({ kind: 'account' as const, account }),
        })]),
        recordsByServiceId: new Map([['openai-codex', record]]),
      });
      const materialized = await owner.materialize({
        purpose,
        serviceRefs: Object.freeze([service]),
        expectedAccount: account,
        request: Object.freeze({
          kind: 'files',
          fileIds: Object.freeze(['auth.json']),
        }),
        signal: new AbortController().signal,
      });

      expect(materialized.kind).toBe('files');
      if (materialized.kind !== 'files') {
        throw new Error('Expected Codex credential files');
      }
      const authFile = materialized.files['auth.json'];
      expect(authFile).toBeInstanceOf(Uint8Array);
      if (!authFile) throw new Error('Expected Codex auth.json');
      const auth = JSON.parse(
        new TextDecoder().decode(authFile),
      ) as Readonly<Record<string, unknown>>;
      expect(auth).toMatchObject({
        auth_mode: 'chatgpt',
        access_token: 'legacy-access',
        refresh_token: 'legacy-refresh',
        id_token: 'legacy-id-token',
        account_id: 'legacy-account',
      });
    } finally {
      await registry?.dispose();
    }
  });

  it('preserves the released OpenCode aggregate auth file and isolated XDG environment', async () => {
    const rootDir = await mkdtemp(join(
      tmpdir(),
      'happier-exact-v021-opencode-',
    ));
    temporaryRoots.push(rootDir);
    const openaiCodex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'openai-access',
        refreshToken: 'openai-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'openai-account',
        providerEmail: null,
      },
    });
    const anthropic = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'personal',
      kind: 'token',
      token: {
        token: 'anthropic-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materialized = await materializeExactV021AgentLaunchProjection({
      agentId: 'opencode',
      rootDir,
      recordsByServiceId: new Map([
        ['openai-codex', openaiCodex],
        ['anthropic', anthropic],
      ]),
    });

    expect(materialized?.env).toMatchObject({
      HOME: join(rootDir, 'home'),
      XDG_DATA_HOME: join(rootDir, 'xdg', 'data'),
      XDG_CACHE_HOME: join(rootDir, 'xdg', 'cache'),
      XDG_CONFIG_HOME: join(rootDir, 'xdg', 'config'),
      XDG_STATE_HOME: join(rootDir, 'xdg', 'state'),
      OPENCODE_TEST_HOME: join(rootDir, 'home'),
    });
    const auth = JSON.parse(await readFile(
      join(rootDir, 'xdg', 'data', 'opencode', 'auth.json'),
      'utf8',
    )) as Readonly<Record<string, unknown>>;
    expect(auth).toEqual({
      openai: {
        type: 'oauth',
        refresh: 'openai-refresh',
        access: 'openai-access',
        expires: 123,
        accountId: 'openai-account',
      },
      anthropic: { type: 'api', key: 'anthropic-key' },
    });
  });

  it('preserves the released Pi aggregate auth file and direct token environment', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-exact-v021-pi-'));
    temporaryRoots.push(rootDir);
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'openai-work',
      kind: 'token',
      token: {
        token: 'openai-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const subscription = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'claude-work',
      kind: 'token',
      token: {
        token: 'claude-setup-token',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const anthropic = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'anthropic-work',
      kind: 'token',
      token: {
        token: 'anthropic-key',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materialized = await materializeExactV021AgentLaunchProjection({
      agentId: 'pi',
      rootDir,
      recordsByServiceId: new Map([
        ['openai', openai],
        ['claude-subscription', subscription],
        ['anthropic', anthropic],
      ]),
    });

    expect(materialized?.env).toEqual({
      ANTHROPIC_OAUTH_TOKEN: 'claude-setup-token',
      ANTHROPIC_API_KEY: 'anthropic-key',
      PI_CODING_AGENT_DIR: join(rootDir, 'pi-agent-dir'),
    });
    expect(JSON.parse(await readFile(
      join(rootDir, 'pi-agent-dir', 'auth.json'),
      'utf8',
    ))).toEqual({
      openai: { type: 'api_key', key: 'openai-key' },
    });
  });

  it('preserves exact-v0.2.1 persisted Gemini OAuth without declaring a current auth mode', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-exact-v021-gemini-oauth-'));
    temporaryRoots.push(rootDir);
    const gemini = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'gemini',
      profileId: 'personal',
      kind: 'oauth',
      expiresAt: 1_000,
      oauth: {
        accessToken: 'gemini-access',
        refreshToken: 'gemini-refresh',
        idToken: 'gemini-id',
        scope: 'gemini-scope',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materialized = await materializeExactV021AgentLaunchProjection({
      agentId: 'gemini',
      rootDir,
      recordsByServiceId: new Map([['gemini', gemini]]),
    });

    expect(materialized?.env.HOME).toBe(join(rootDir, 'home'));
    expect(JSON.parse(await readFile(
      join(rootDir, 'home', '.gemini', 'oauth_creds.json'),
      'utf8',
    ))).toEqual({
      access_token: 'gemini-access',
      token_type: 'Bearer',
      scope: 'gemini-scope',
      refresh_token: 'gemini-refresh',
      id_token: 'gemini-id',
      expires_at: 1_000,
    });
  });

});
