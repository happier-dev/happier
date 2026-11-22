import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { OPENCODE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { OPENCODE_PREFLIGHT_SESSION_CONTROLS } from './agent/preflight/models.js';

describe('OpenCode plugin manifest', () => {
  it('discloses every environment key requested by its managed preflight commands', () => {
    const disclosed = new Set(PLUGIN_MANIFEST.hostAccess.required.flatMap((entry) => (
      entry.capability === 'process' ? entry.scope.envKeys : []
    )));
    const undisclosed = OPENCODE_PREFLIGHT_SESSION_CONTROLS.managedServiceCommands.flatMap((command) => (
      command.environmentKeys.filter((key) => !disclosed.has(key))
    ));
    expect([...new Set(undisclosed)]).toEqual([]);
  });

  it('is a canonical data-only custom Agent declaration', () => {
    const result = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(result).toMatchObject({ ok: true });
    expect(ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST))).toEqual(result);
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({ id: 'opencode', runtime: { kind: 'custom' } }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli.auth.nonInteractiveStatusProbe).toBe(true);
    expect(PLUGIN_MANIFEST.contributes.settings).toEqual([
      OPENCODE_AGENT_SETTINGS_CONTRIBUTION,
    ]);
  });

  it('does not advertise provider runtime Activity authority', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'opencode');

    expect(agent?.capabilities.sessions?.runtimeActivitySnapshots).toBeUndefined();
  });

  it('declares the external-server password as daemon custody bound to its Account endpoint origin', () => {
    const password = OPENCODE_AGENT_SETTINGS_CONTRIBUTION.fields.find(
      (field) => field.id === 'opencodeServerPassword',
    );

    expect(password?.secret).toEqual({
      custody: 'daemon',
      managedServiceOrigin: { endpointSettingId: 'opencodeServerBaseUrl' },
    });
  });

  it('authorizes only managed-launch env and does not grant the external-attach descriptor to the child process', () => {
    const processAccess = PLUGIN_MANIFEST.hostAccess.required.find((entry) => entry.id === 'opencode-process');

    expect(processAccess).toEqual(expect.objectContaining({
      id: 'opencode-process',
      scope: expect.objectContaining({
        envKeys: expect.arrayContaining([
          'HAPPIER_OPENCODE_PROVIDER_API_KEY',
          'OPENCODE_AUTH_CONTENT',
          'OPENCODE_CONFIG_CONTENT',
          'OPENAI_API_KEY',
          'ANTHROPIC_API_KEY',
          'CLAUDE_CODE_OAUTH_TOKEN',
          'XDG_CONFIG_HOME',
          'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH',
          'OPENCODE_PERMISSION',
          'OPENCODE_DISABLE_PRUNE',
          'OPENCODE_SERVER_PASSWORD',
          'META_API_KEY',
        ]),
      }),
    }));
    expect(processAccess?.scope.envKeys).not.toContain('HAPPIER_OPENCODE_SERVER_URL');
  });

  it('declares the native session facets that the OpenCode primary consumes', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'opencode');

    expect(agent?.capabilities.sessions).toMatchObject({
      open: ['create', 'resume', 'fork'],
      delivery: ['newTurn', 'steer', 'followUp'],
      cancel: true,
      configuration: true,
      compaction: { events: true },
      catalog: { active: ['skills'] },
    });
    expect(agent?.capabilities.sessions?.compaction).not.toHaveProperty('manual');
    expect(agent?.capabilities.sessions).not.toHaveProperty('usageLimitRecovery');
  });

  it('declares native request-time auth and API-key purposes', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'opencode');

    expect(agent?.connectedAccounts?.map(row => row.purpose)).not.toContain('meta-inference');
    expect(agent?.connectedAccounts).toEqual(expect.arrayContaining([{
      purpose: 'anthropic-model-request',
      nativeModelIdPrefix: 'anthropic/',
      service: {
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      },
      materializationKinds: ['environment', 'httpHeaders'],
      credentialKinds: ['oauth', 'token'],
    }, {
      purpose: 'openai-codex-model-request',
      nativeModelIdPrefix: 'openai/',
      service: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      },
      materializationKinds: ['httpHeaders'],
      credentialKinds: ['oauth'],
    }, {
      purpose: 'openai-api-key',
      nativeModelIdPrefix: 'openai/',
      service: {
        pluginId: 'happier.voice.openai',
        localId: 'openai',
      },
      materializationKinds: ['environment'],
      credentialKinds: ['token'],
    }, {
      purpose: 'anthropic-api-key',
      nativeModelIdPrefix: 'anthropic/',
      service: {
        pluginId: 'happier.agent.claude',
        localId: 'anthropic',
      },
      materializationKinds: ['environment'],
      credentialKinds: ['token'],
    }]));
  });
});
