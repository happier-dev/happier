import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_PLUGIN, PLUGIN_MANIFEST } from './manifest.js';
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

  it('binds the Claude Agent CLI to the declared claude-cli system tool through the public catalog block', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'claude');

    expect(agent?.catalog?.agentCliSystemTool).toEqual({ toolId: 'claude-cli' });
    // The binding is only resolvable against a system tool this same plugin
    // declares and this Agent's own CLI metadata.
    expect(PLUGIN_MANIFEST.contributes.systemTools.map((tool) => tool.id))
      .toContain('claude-cli');
    expect(agent?.cli?.executable.binaryName).toBe('claude');
  });

  it('declares Claude coding-prompt behavior as ordered manifest data', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents.find((entry) => entry.id === 'claude');

    expect(agent?.catalog?.codingPromptBehavior).toEqual({
      blocks: [{
        id: 'provider.claude.ask_user_question_isolation',
        text: [
          'RELIABILITY RULES (IMPORTANT):',
          "- Tool-use sequencing is strict. If you use \"AskUserQuestion\", do NOT include any other tool_use in the same assistant turn. Wait for the user's answer before calling other tools.",
        ].join('\n'),
      }, {
        id: 'provider.claude.disable_todos',
        when: 'disableTodos',
        text: 'Do not create TODO items, TODO lists, or task lists in your output. If you would normally create TODOs, instead proceed with the work directly or ask the user for clarification.',
      }],
    });
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

  it('registers focused deferred-startup and terminal prompt-recognition callbacks', async () => {
    const register = vi.fn();
    const ignoreRegistration = vi.fn();
    const agents = new Proxy({ register }, {
      get(target, property) {
        return Reflect.get(target, property) ?? ignoreRegistration;
      },
    });
    const api = new Proxy({ agents }, {
      get(target, property) {
        return Reflect.get(target, property) ?? new Proxy({}, {
          get: () => ignoreRegistration,
        });
      },
    });

    await CLAUDE_PLUGIN.activate(api as never);

    expect(register).toHaveBeenCalledTimes(1);
    const [agentId, factory, options] = register.mock.calls[0] ?? [];
    expect(agentId).toBe('claude');
    expect(factory).toBeTypeOf('function');
    expect(options.sessionStartup.shouldUseDeferredBootstrap).toBeTypeOf('function');
    expect(options.terminalPromptSubmitVerification.shouldVerifyAfterSubmit).toBeTypeOf('function');
    expect(options.terminalPromptSubmitVerification.verifyAfterSubmit).toBeTypeOf('function');
    expect(options).not.toHaveProperty('releasedOverridesCacheV1');
    expect(options.sessionStartup).not.toHaveProperty('releasedOverridesCacheV1');
    expect(options.terminalPromptSubmitVerification.shouldVerifyAfterSubmit('continue')).toBe(true);
    expect(options.terminalPromptSubmitVerification.verifyAfterSubmit({
      promptText: 'continue',
      screenText: '❯ continue',
    })).toBe(true);
  });
});
