import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { OPENCODE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('OpenCode plugin manifest', () => {
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
        envKeys: [
          'HAPPIER_OPENCODE_PROVIDER_API_KEY',
          'OPENCODE_AUTH_CONTENT',
          'OPENCODE_CONFIG_CONTENT',
          'OPENAI_API_KEY',
          'ANTHROPIC_API_KEY',
          'CLAUDE_CODE_OAUTH_TOKEN',
          'XDG_CONFIG_HOME',
          'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH',
          'OPENCODE_PERMISSION',
          'OPENCODE_SERVER_PASSWORD',
        ],
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
      compaction: { events: true, manual: true },
      catalog: { active: ['skills'] },
      usageLimitRecovery: {
        active: ['checkNow'],
        inactive: ['checkNow'],
      },
    });
  });

  it('declares the exact qualified purposes consumed by request-time and direct OpenCode auth', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'opencode');

    expect(agent?.connectedAccounts).toEqual([{
      purpose: 'anthropic-model-request',
      service: {
        pluginId: 'happier.agent.claude',
        localId: 'claude-subscription',
      },
      materializationKinds: ['environment', 'httpHeaders'],
    }, {
      purpose: 'openai-codex-model-request',
      service: {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      },
      materializationKinds: ['httpHeaders'],
    }, {
      purpose: 'openai-api-key',
      service: {
        pluginId: 'happier.voice.openai',
        localId: 'openai',
      },
      materializationKinds: ['environment'],
    }, {
      purpose: 'anthropic-api-key',
      service: {
        pluginId: 'happier.agent.claude',
        localId: 'anthropic',
      },
      materializationKinds: ['environment'],
    }]);
  });
});
