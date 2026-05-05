import { describe, expect, it } from 'vitest';

import {
  createAcpRuntimeCoreFromDefinition,
  normalizeBuiltInAcpDefinition,
  normalizeConfiguredAcpDefinition,
  normalizePluginAcpDefinition,
  normalizePluginBackendContributionAcpDefinition,
} from '../index';
import type { ResolvedConfiguredAcpBackend } from '../../../catalog/configured/resolveBackend';

describe('ACP runtime definitions', () => {
  it('normalizes built-in ACP capability hints into the runtime definition contract', () => {
    const definition = normalizeBuiltInAcpDefinition('kiro');

    expect(definition.capabilities).toMatchObject({
      supportsResume: true,
      supportsModes: true,
      supportsModels: true,
      supportsConfigOptions: false,
      supportsPromptImages: true,
      promptImageSupport: 'yes',
      supportsToolUse: true,
      supportsPermissionRequests: true,
    });
  });

  it('normalizes configured ACP backends into a host-internal definition shape', () => {
    const backend = {
      backendId: 'custom-kiro',
      name: 'custom-kiro',
      title: 'Custom Kiro',
      command: 'kiro',
      args: ['--acp'],
      env: {
        REGION: { t: 'literal', v: 'eu' },
      },
      auth: {
        support: 'unsupported',
      },
      transportProfile: 'kiro',
      capabilities: {
        supportsLoadSession: true,
        supportsModes: 'yes',
        supportsModels: 'unknown',
        supportsConfigOptions: 'no',
        promptImageSupport: 'yes',
      },
    } satisfies ResolvedConfiguredAcpBackend;

    const definition = normalizeConfiguredAcpDefinition({
      backend,
      launchEnv: {
        TOKEN: 'secret-token',
      },
    });

    expect(definition).toMatchObject({
      backendId: 'custom-kiro',
      source: {
        kind: 'account_configured',
      },
      identity: {
        backendId: 'custom-kiro',
      },
      engine: {
        kind: 'acp',
      },
      ux: {
        name: 'custom-kiro',
        title: 'Custom Kiro',
      },
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'executable',
          command: 'kiro',
          args: ['--acp'],
        },
      },
      launchEnv: {
        TOKEN: 'secret-token',
      },
      mcp: {
        policy: 'pass_through',
      },
    });
    expect(definition.capabilities.supportsResume).toBe(true);
    expect('providerId' in definition.identity).toBe(false);
    expect('runtimeKind' in definition).toBe(false);
  });

  it('adapts ACP message meta hooks to the provider message meta contract', () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        ux: {
          title: 'Acme Agent',
        },
        messageMeta: {
          enrichOutgoing: (message, context) => ({ acpMessage: message, context }),
        },
      },
    });

    const adapter = createAcpRuntimeCoreFromDefinition(definition);

    expect(adapter.messageMeta?.buildOutgoingMessageMetaExtras?.({ id: 'msg-1' })).toEqual({
      acpMessage: { id: 'msg-1' },
      context: undefined,
    });
  });

  it('uses the backend id as plugin ACP title when ux metadata is omitted', () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.minimal',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
      },
    });

    expect(definition.ux).toEqual({
      title: 'acme.plugin.minimal',
    });
  });

  it('uses ux.name as plugin ACP title fallback when title is omitted', () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.named',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        ux: {
          name: 'Acme Named Agent',
        },
      },
    });

    expect(definition.ux).toEqual({
      name: 'Acme Named Agent',
      title: 'Acme Named Agent',
    });
  });

  it('fails closed when ACP outgoing message meta hooks return a promise', () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.async-meta',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        ux: {
          title: 'Acme Async Meta Agent',
        },
        messageMeta: {
          // @ts-expect-error Boundary regression: runtime must fail closed on unchecked async hooks.
          enrichOutgoing: async (message) => ({ acpMessage: message }),
        },
      },
    });

    const adapter = createAcpRuntimeCoreFromDefinition(definition);

    expect(() => adapter.messageMeta?.buildOutgoingMessageMetaExtras?.({ id: 'msg-1' }))
      .toThrow(/messageMeta\.enrichOutgoing returned a Promise/);
  });

  it('normalizes plugin ACP specs and preserves plugin-owned MCP policy', () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
            args: ['acp'],
          },
        },
        ux: {
          title: 'Acme Agent',
          defaultMode: 'review',
        },
        mcp: {
          policy: 'drop',
        },
        capabilities: {
          supportsResume: false,
          supportsToolUse: true,
        },
      },
    });

    expect(definition).toMatchObject({
      backendId: 'acme.plugin.acp',
      source: {
        kind: 'plugin_contributed',
        pluginId: 'acme.plugin',
      },
      engine: {
        kind: 'acp',
      },
      ux: {
        title: 'Acme Agent',
        defaultMode: 'review',
      },
      mcp: {
        policy: 'drop',
      },
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'executable',
          command: 'acme-agent',
          args: ['acp'],
        },
      },
    });
    expect(definition.capabilities.supportsResume).toBe(false);
    expect('providerId' in definition.identity).toBe(false);
    expect('runtimeKind' in definition).toBe(false);
  });

  it('normalizes final plugin manifest ACP contributions through the full runtime definition path', () => {
    const definition = normalizePluginBackendContributionAcpDefinition({
      pluginId: 'acme.plugin',
      backend: {
        id: 'acme.plugin.full',
        providerId: 'acme.plugin.provider',
        engine: {
          kind: 'acp',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
            args: ['acp'],
            env: {
              TRANSPORT_TOKEN: 'transport-token',
            },
          },
          timeouts: {
            initMs: 5000,
          },
        },
          launchEnv: {
            ENGINE_TOKEN: 'engine-token',
          },
          ux: {
            name: 'acme-full',
            title: 'Acme Full Agent',
            defaultMode: 'review',
          },
          capabilities: {
            supportsResume: true,
            supportsStreaming: true,
            supportsToolUse: true,
            supportsPermissionRequests: true,
            supportsInFlightSteer: true,
            supportsModelSwitch: true,
            customMessageKinds: ['acme.delta'],
            promptImageSupport: 'yes',
          },
          auth: {
            config: {
              support: 'manual_only',
              docsUrl: 'https://example.com/acp-auth',
            },
          },
          fsEnabled: false,
          mcp: {
            policy: 'drop',
          },
        },
      },
    });

    expect(definition).toMatchObject({
      backendId: 'acme.plugin.full',
      source: {
        kind: 'plugin_contributed',
        pluginId: 'acme.plugin',
      },
      launchEnv: {
        ENGINE_TOKEN: 'engine-token',
      },
      auth: {
        config: {
          support: 'manual_only',
        },
      },
      fsEnabled: false,
      mcp: {
        policy: 'drop',
      },
    });
    expect(definition.capabilities).toMatchObject({
      supportsStreaming: true,
      customMessageKinds: ['acme.delta'],
      promptImageSupport: 'yes',
    });
    expect(definition.timeouts).toEqual({
      initMs: 5000,
    });
  });

  it('builds runtime transport handlers from V1 T.4 timeout fields', async () => {
    const runtimeCore = await import('../runtimeCore');
    const createTransport = (runtimeCore as Record<string, unknown>).createAcpTransportHandlerFromDefinition;
    expect(createTransport).toEqual(expect.any(Function));

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.timeouts',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
          timeouts: {
            initMs: 11,
            initDelayMs: 12,
            idleMs: 13,
            toolCallMs: 14,
            promptLivenessMs: 15,
            postPromptNoUpdatesMs: 16,
            postToolCallIdleMs: 17,
            idleWithoutAssistantMessageMs: 18,
            preToolCallIdleMs: 19,
          },
        },
        ux: {
          title: 'Acme Agent',
        },
      },
    });

    const transport = (createTransport as (input: typeof definition) => {
      getInitTimeout: () => number;
      getInitDelayMs?: () => number;
      getIdleTimeout?: () => number;
      getToolCallTimeout?: (toolCallId: string, toolKind?: string) => number;
      getPromptLivenessTimeoutMs?: () => number;
      getPostPromptNoUpdatesTimeoutMs?: () => number;
      getPostToolCallIdleTimeoutMs?: () => number;
      getIdleWithoutAssistantMessageTimeoutMs?: () => number;
      getPreToolCallIdleTimeoutMs?: () => number | undefined;
    })(definition);

    expect(transport.getInitTimeout()).toBe(11);
    expect(transport.getInitDelayMs?.()).toBe(12);
    expect(transport.getIdleTimeout?.()).toBe(13);
    expect(transport.getToolCallTimeout?.('tool-1')).toBe(14);
    expect(transport.getPromptLivenessTimeoutMs?.()).toBe(15);
    expect(transport.getPostPromptNoUpdatesTimeoutMs?.()).toBe(16);
    expect(transport.getPostToolCallIdleTimeoutMs?.()).toBe(17);
    expect(transport.getIdleWithoutAssistantMessageTimeoutMs?.()).toBe(18);
    expect(transport.getPreToolCallIdleTimeoutMs?.()).toBe(19);
  });

  it('resolves runtime launch args from permission-mode argv maps without spawning ACP', async () => {
    const runtimeCore = await import('../runtimeCore');
    const resolveLaunch = (runtimeCore as Record<string, unknown>).resolveAcpRuntimeLaunch;
    expect(resolveLaunch).toEqual(expect.any(Function));

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.permissions',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
            args: ['acp'],
          },
        },
        ux: {
          title: 'Acme Agent',
        },
        permissionModeArgv: {
          flag: '--permission-mode',
          map: {
            default: null,
            read_only: 'read-only',
          },
        },
      },
    });

    const launch = (resolveLaunch as (input: {
      definition: typeof definition;
      cwd: string;
      permissionMode?: string;
    }) => { command: string; args: readonly string[] })({
      definition,
      cwd: '/workspace',
      permissionMode: 'read_only',
    });

    expect(launch.command).toBe('acme-agent');
    expect(launch.args).toEqual(['acp', '--permission-mode', 'read-only']);
  });

  it('fails closed when runtime definitions carry unsupported executable hooks', async () => {
    const runtimeCore = await import('../runtimeCore');
    const assertSupported = (runtimeCore as Record<string, unknown>).assertAcpRuntimeDefinitionSupported;
    expect(assertSupported).toEqual(expect.any(Function));

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.custom',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
          customHandler: {
            preDial: async () => undefined,
          },
        },
        ux: {
          title: 'Acme Agent',
        },
      },
    });

    expect(() => (assertSupported as (input: typeof definition) => void)(definition)).toThrow(/customHandler/);
  });

  it('rejects legacy plugin ACP wire instead of preserving a loose .acp compatibility path', () => {
    expect(() => normalizePluginBackendContributionAcpDefinition({
      pluginId: 'acme.plugin',
      backend: {
        id: 'acme.plugin.acp',
        providerId: 'acme.plugin',
        runtimeKind: 'acp',
        acp: {
          command: 'acme-agent',
        },
      },
    })).toThrow(/backends\[\]\.engine\.kind/);
  });
});
