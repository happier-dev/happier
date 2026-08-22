import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import { CLAUDE_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

describe('Claude plugin manifest', () => {
  it('round-trips through canonical manifest ingestion as data only', () => {
    const objectResult = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(objectResult).toMatchObject({ ok: true });
    expect(ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST))).toEqual(objectResult);
    expect(PLUGIN_MANIFEST.contributes.settings).toEqual([
      CLAUDE_AGENT_SETTINGS_CONTRIBUTION,
    ]);
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toContainEqual({
      id: 'claude-subscription',
      title: 'Claude',
      authentication: {
        defaultModeId: 'setup-token',
        modes: [{
          id: 'setup-token',
          kind: 'manual',
          title: 'Setup token',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Claude setup token',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }, {
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          callbackUrl: 'https://platform.claude.com/oauth/code/callback',
          scopes: [
            'org:create_api_key',
            'user:profile',
            'user:inference',
            'user:sessions:claude_code',
            'user:mcp_servers',
            'user:file_upload',
          ],
          pkce: 'required',
          outcomeReconciliation: 'none',
        }],
      },
    });
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toContainEqual({
      id: 'anthropic',
      title: 'Anthropic API key',
      authentication: {
        defaultModeId: 'api-key',
        modes: [{
          id: 'api-key',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Anthropic API key',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }],
      },
    });
  });

  it('declares canonical session runtime activity snapshots', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'claude');

    expect(agent?.capabilities.sessions?.runtimeActivitySnapshots).toBe(true);
  });

  it('declares the native Claude goal work-state source', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'claude');

    expect(agent?.capabilities.sessions?.workStateSources).toEqual([
      { id: 'goals', itemKinds: ['goal'] },
    ]);
  });

  it('declares the process, terminal, and session host access consumed by the Claude runtime', () => {
    expect(PLUGIN_MANIFEST.hostAccess.required).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: 'process',
        scope: expect.objectContaining({ executables: [
          { kind: 'systemTool', id: 'claude-cli' },
          { kind: 'systemTool', id: 'macos-security' },
        ] }),
      }),
      expect.objectContaining({
        capability: 'terminal',
        scope: { operations: ['open', 'send', 'resize', 'close'] },
      }),
      expect.objectContaining({
        capability: 'sessions',
        scope: { access: ['read', 'control'] },
      }),
    ]));
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({
      id: 'claude-subscription-oauth',
      capability: 'network',
      scope: {
        targets: [
          { kind: 'fixedOrigin', origin: 'https://platform.claude.com' },
          { kind: 'connectedAccountOrigin', service: 'claude-subscription' },
        ],
        methods: ['POST'],
      },
    }));
  });
});
