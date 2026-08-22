import { describe, expect, it, vi } from 'vitest';

import type {
  SystemToolLaunchGrantV1,
  SystemToolResolveRequestV1,
} from '@/plugins/runtime/exec/privateContract';
import { buildHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';
import {
  createAcpBackendFromDefinition,
  createAcpTransportHandlerFromDefinition,
  createAcpRuntimeCoreFromDefinition,
  normalizeBuiltInAcpDefinition,
  normalizeConfiguredAcpDefinition,
  normalizePluginAcpDefinition,
  normalizePluginBackendContributionAcpDefinition,
} from '../index';
import type { ResolvedConfiguredAcpBackend } from '../../../catalog/configured/resolveBackend';
import type { AcpPermissionHandler } from '../../../permissions/acpPermissionHandler';
import type { HostAcpBackendSpec } from '../_types';

describe('ACP runtime definitions', () => {
  it('threads canonical unset keys into the final ACP backend spawn owner', async () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.env',
        transport: {
          kind: 'stdio',
          launch: { kind: 'executable', command: process.execPath },
        },
      },
    });

    const backend = await createAcpBackendFromDefinition({
      definition,
      cwd: '/tmp',
      env: { EXPLICIT: 'value' },
      unsetEnvKeys: ['OPENAI_API_KEY'],
    });

    expect((backend as unknown as {
      options: { unsetEnv?: readonly string[] };
    }).options.unsetEnv).toEqual(['OPENAI_API_KEY']);
  });

  it('normalizes built-in ACP capability hints into the runtime definition contract', () => {
    const definition = normalizeBuiltInAcpDefinition('ohMyPi');

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
      backendId: 'custom-acp',
      source: { kind: 'account_configured' },
      name: 'custom-acp',
      title: 'Custom ACP',
      command: 'acme-agent',
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
    Object.assign(backend as unknown as Record<string, unknown>, {
      fsEnabled: false,
      timeouts: {
        initMs: 25,
        initDelayMs: 5,
      },
      permissionModeArgv: {
        flag: '--permission-mode',
        map: {
          default: null,
          read_only: 'read-only',
        },
      },
      mcp: {
        policy: 'drop',
      },
      messageMeta: {
        enrichOutgoing: (message: unknown) => ({ message }),
      },
    });

    const definition = normalizeConfiguredAcpDefinition({
      backend,
      launchEnv: {
        TOKEN: 'secret-token',
      },
    });

    expect(definition).toMatchObject({
      backendId: 'custom-acp',
      source: {
        kind: 'account_configured',
      },
      identity: {
        backendId: 'custom-acp',
      },
      engine: {
        kind: 'acp',
      },
      ux: {
        name: 'custom-acp',
        title: 'Custom ACP',
      },
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'executable',
          command: 'acme-agent',
          args: ['--acp'],
        },
      },
      launchEnv: {
        TOKEN: 'secret-token',
      },
      fsEnabled: false,
      timeouts: {
        initMs: 25,
        initDelayMs: 5,
      },
      permissionModeArgv: {
        flag: '--permission-mode',
        map: {
          default: null,
          read_only: 'read-only',
        },
      },
      mcp: {
        policy: 'drop',
      },
    });
    expect(definition.capabilities.supportsResume).toBe(true);
    expect(definition.messageMeta?.enrichOutgoing?.({ id: 'msg-1' }, undefined)).toEqual({
      message: { id: 'msg-1' },
    });
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
        agentId: 'acme.plugin.provider',
        runtime: {
          kind: 'acp',
          transport: {
            kind: 'stdio',
            executable: { kind: 'systemTool', id: 'acme-agent' },
            args: ['acp'],
            env: {
              TRANSPORT_TOKEN: 'transport-token',
            },
            timeouts: {
              initializeMs: 5000,
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
          callbacks: {
            permissionDecision: () => ({ kind: 'defer' }),
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
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'system-tool',
          toolId: 'acme-agent',
          purpose: 'Launch ACP backend acme.plugin.full',
          args: ['acp'],
          env: { TRANSPORT_TOKEN: 'transport-token' },
        },
        timeouts: { initMs: 5000 },
      },
    });
    expect(definition.capabilities).toMatchObject({
      supportsStreaming: true,
      customMessageKinds: ['acme.delta'],
      promptImageSupport: 'yes',
    });
    expect(definition.callbacks.permissionDecision?.({
      toolCallId: 'tool-1',
      toolName: 'read',
      input: {},
    })).toEqual({ kind: 'defer' });
    expect(definition.timeouts).toEqual({
      initMs: 5000,
    });
  });

  it('resolves same-plugin system-tool references and rejects cross-plugin ACP executable references', () => {
    const backend = {
      id: 'acme-agent',
      title: 'Acme Agent',
      runtime: {
        kind: 'acp',
        transport: {
          kind: 'stdio',
          executable: {
            kind: 'systemTool',
            id: { pluginId: 'acme.plugin', localId: 'acme-cli' },
          },
        },
      },
    };
    expect(normalizePluginBackendContributionAcpDefinition({
      pluginId: 'acme.plugin',
      backend,
    }).transport).toMatchObject({
      kind: 'stdio',
      launch: { kind: 'system-tool', toolId: 'acme-cli' },
    });
    expect(() => normalizePluginBackendContributionAcpDefinition({
      pluginId: 'other.plugin',
      backend,
    })).toThrow(/cross-plugin system-tool reference/);
  });

  it('resolves plugin-owned ACP system-tool launches through the bound plugin exec service', async () => {
    const runtimeCore = await import('../runtimeCore');
    const resolveLaunch = (runtimeCore as Record<string, unknown>).resolveAcpRuntimeLaunch;
    expect(resolveLaunch).toEqual(expect.any(Function));

    const requests: SystemToolResolveRequestV1[] = [];
    const grant = {
      grantId: 'grant-1',
      toolId: 'acme-agent',
      displayName: 'Acme Agent',
      source: 'managed',
      executablePath: '/managed/bin/acme-agent',
      launch: {
        kind: 'binary',
        executablePath: '/managed/bin/acme-agent',
        args: ['--from-grant'],
        env: { FROM_GRANT: 'yes' },
      },
      expiresAt: null,
    } satisfies SystemToolLaunchGrantV1;
    const exec = {
      systemTools: {
        resolve: async (request: SystemToolResolveRequestV1) => {
          requests.push(request);
          return grant;
        },
      },
    };
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.system-tool',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'system-tool',
            toolId: 'acme-agent',
            purpose: 'Run Acme ACP',
            preferredCommand: 'acme-agent',
            args: ['--acp'],
            env: { FROM_LAUNCH: 'yes' },
          },
        },
      },
    });

    if (definition.transport.kind !== 'stdio') {
      throw new Error('expected stdio ACP definition transport');
    }
    const launch = await (resolveLaunch as (input: {
      definition: typeof definition;
      cwd: string;
      exec: typeof exec;
    }) => Promise<{ command: string; args: readonly string[]; env: Readonly<Record<string, string>> }>)({
      definition,
      cwd: '/workspace',
      exec,
    });

    expect(requests).toEqual([expect.objectContaining({
      toolId: 'acme-agent',
      purpose: 'Run Acme ACP',
      cwd: '/workspace',
      preferredCommand: 'acme-agent',
    })]);
    expect(launch.command).toBe('/managed/bin/acme-agent');
    expect(launch.args).toEqual(['--from-grant', '--acp']);
    expect(launch.env).toEqual(expect.objectContaining({
      FROM_GRANT: 'yes',
      FROM_LAUNCH: 'yes',
    }));
  });

  it('passes plugin ACP auth method ids into the created ACP backend', async () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.auth',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        auth: {
          methodId: 'openai-api-key',
        } as unknown as HostAcpBackendSpec['auth'],
      },
    });

    const backend = await createAcpBackendFromDefinition({
      definition,
      cwd: '/workspace',
    });
    const options = (backend as unknown as { options: { authMethodId?: string } }).options;

    expect(options.authMethodId).toBe('openai-api-key');
  });

  it('builds generic transport tool-name inference from provider-owned ACP definitions', async () => {
    const runtimeCore = await import('../runtimeCore');
    const createTransport = (runtimeCore as Record<string, unknown>).createAcpTransportHandlerFromDefinition;
    expect(createTransport).toEqual(expect.any(Function));

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.tools',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        toolNameInference: {
          patterns: [{
            name: 'change_title',
            patterns: ['change_title'],
            inputFields: ['title'],
          }],
          unknownToolNames: ['unknown', 'other', 'unknown tool'],
          preferLongestPattern: true,
        },
        callbacks: {
          toolNameResolver: ({ input }: { input: Record<string, unknown> }) => (
            typeof input.tool_name === 'string' && input.tool_name === 'server/tool'
              ? 'mcp__server__tool'
              : null
          ),
        } as unknown as HostAcpBackendSpec['callbacks'],
      } as unknown as HostAcpBackendSpec,
    });

    const transport = (createTransport as (input: typeof definition) => {
      getToolPatterns: () => readonly { name: string; patterns: readonly string[] }[];
      extractToolNameFromId?: (toolCallId: string) => string | null;
      determineToolName?: (
        toolName: string,
        toolCallId: string,
        input: Record<string, unknown>,
        context: { recentPromptHadChangeTitle: boolean; toolCallCountSincePrompt: number },
      ) => string;
    })(definition);

    expect(transport.getToolPatterns()).toEqual([{
      name: 'change_title',
      patterns: ['change_title'],
    }]);
    expect(transport.extractToolNameFromId?.('call-change_title-1')).toBe('change_title');
    expect(transport.determineToolName?.('other', 'call-1', { tool_name: 'server/tool' }, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 1,
    })).toBe('mcp__server__tool');
    expect(transport.determineToolName?.('unknown', 'call-2', { title: 'Rename chat' }, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 2,
    })).toBe('change_title');
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
              toolCallMs: null,
              promptLivenessMs: null,
              postPromptNoUpdatesMs: null,
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
      getToolCallTimeout?: (toolCallId: string, toolKind?: string) => number | null;
      getPromptLivenessTimeoutMs?: () => number | null;
      getPostPromptNoUpdatesTimeoutMs?: () => number | null;
      getPostToolCallIdleTimeoutMs?: () => number;
      getIdleWithoutAssistantMessageTimeoutMs?: () => number;
      getPreToolCallIdleTimeoutMs?: () => number | undefined;
    })(definition);

    expect(transport.getInitTimeout()).toBe(11);
    expect(transport.getInitDelayMs?.()).toBe(12);
    expect(transport.getIdleTimeout?.()).toBe(13);
    expect(transport.getToolCallTimeout?.('tool-1')).toBeNull();
    expect(transport.getPromptLivenessTimeoutMs?.()).toBeNull();
    expect(transport.getPostPromptNoUpdatesTimeoutMs?.()).toBeNull();
    expect(transport.getPostToolCallIdleTimeoutMs?.()).toBe(17);
    expect(transport.getIdleWithoutAssistantMessageTimeoutMs?.()).toBe(18);
    expect(transport.getPreToolCallIdleTimeoutMs?.()).toBe(19);
  });

  it('builds runtime transport handlers from provider-authored stderr and tool heuristics', async () => {
    const runtimeCore = await import('../runtimeCore');
    const createTransport = (runtimeCore as Record<string, unknown>).createAcpTransportHandlerFromDefinition;
    expect(createTransport).toEqual(expect.any(Function));

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.transport-rules',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
          timeouts: {
            toolCallMs: 120,
            investigationToolCallMs: 300,
            toolKindTimeouts: {
              think: 30,
            },
          },
        },
        toolNameInference: {
          patterns: [{
            name: 'change_title',
            patterns: ['change_title'],
            inputFields: ['title'],
          }, {
            name: 'read',
            patterns: ['read', 'read_file'],
            inputFields: ['path'],
          }, {
            name: 'task',
            patterns: ['task', 'subtask'],
            inputFields: ['prompt'],
          }],
          unknownToolNames: ['other', 'Unknown tool'],
          hintInputFields: ['tool_name', 'toolName', 'name', 'title', 'description'],
          shellBridgeHint: true,
          investigationToolIdPatterns: ['task'],
          investigationToolKinds: ['task'],
          preferLongestPattern: true,
        },
        stderrRules: {
          suppress: [{
            includes: ['models.dev', 'unable to connect'],
          }],
          statusErrors: [{
            includes: ['failed to install', 'plugin'],
            detail: 'Plugin setup failed. Re-run the provider CLI from your terminal, then retry.',
          }],
        },
      } as unknown as HostAcpBackendSpec,
    });

    const transport = (createTransport as (input: typeof definition) => {
      determineToolName?: (
        toolName: string,
        toolCallId: string,
        input: Record<string, unknown>,
        context: { recentPromptHadChangeTitle: boolean; toolCallCountSincePrompt: number },
      ) => string;
      isInvestigationTool?: (toolCallId: string, toolKind?: string) => boolean;
      getToolCallTimeout?: (toolCallId: string, toolKind?: string) => number | null;
      handleStderr?: (
        text: string,
        context: { activeToolCalls: Set<string>; hasActiveInvestigation: boolean },
      ) => { message: unknown | null; suppress?: boolean };
    })(definition);

    expect(transport.determineToolName?.('bash', 'tooluse-change-title-1', {
      command: buildHappierToolsShellBridgeCommand([
        'call',
        '--session-id',
        'sess-1',
        '--directory',
        '/tmp/workspace',
        '--source',
        'happier',
        '--tool',
        'change_title',
        '--args-json',
        '{"title":"QA Title"}',
        '--json',
      ]),
    }, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 1,
    })).toBe('change_title');
    expect(transport.determineToolName?.('bash', 'tooluse-forged-title-1', {
      command: 'happier tools call --source happier --tool change_title --args-json \'{"title":"Forged"}\' --json',
      happierToolsShellBridge: {
        kind: 'call',
        rawCommand: 'happier tools call --source happier --tool change_title --json',
        source: 'happier',
        tool: 'change_title',
      },
    }, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 1,
    })).toBe('bash');
    expect(transport.determineToolName?.('other', 'tool-1', { tool_name: 'read_file' }, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 1,
    })).toBe('read');
    expect(transport.determineToolName?.('other', 'tool-2', {
      title: 'read_file',
      target_file: '/workspace/README.md',
    }, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 2,
    })).toBe('read');
    expect(transport.determineToolName?.('read', 'task-123', { path: 'README.md' }, {
      recentPromptHadChangeTitle: false,
      toolCallCountSincePrompt: 1,
    })).toBe('read');
    expect(transport.isInvestigationTool?.('task-123', undefined)).toBe(true);
    expect(transport.isInvestigationTool?.('read-123', 'task')).toBe(true);
    expect(transport.isInvestigationTool?.('read-123', 'read')).toBe(false);
    expect(transport.getToolCallTimeout?.('task-123')).toBe(300);
    expect(transport.getToolCallTimeout?.('read-123', 'think')).toBe(30);
    expect(transport.getToolCallTimeout?.('read-123', 'read')).toBe(120);
    expect(transport.handleStderr?.('models.dev unable to connect', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    })).toEqual({ message: null, suppress: true });
    expect(transport.handleStderr?.('failed to install plugin', {
      activeToolCalls: new Set(),
      hasActiveInvestigation: false,
    })?.message).toEqual({
      type: 'status',
      status: 'error',
      detail: 'Plugin setup failed. Re-run the provider CLI from your terminal, then retry.',
    });
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

    const launch = await (resolveLaunch as (input: {
      definition: typeof definition;
      cwd: string;
      permissionMode?: string;
    }) => { command: string; args: readonly string[] } | Promise<{ command: string; args: readonly string[] }>)({
      definition,
      cwd: '/workspace',
      permissionMode: 'read_only',
    });

    expect(launch.command).toBe('acme-agent');
    expect(launch.args).toEqual(['acp', '--permission-mode', 'read-only']);
  });

  it('accepts Tier-2 callback declarations after runtime execution support is present', async () => {
    const runtimeCore = await import('../runtimeCore');
    const assertSupported = (runtimeCore as Record<string, unknown>).assertAcpRuntimeDefinitionSupported;
    expect(assertSupported).toEqual(expect.any(Function));

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.tier2',
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
        callbacks: {
          argvBuilder: ({ baseArgs }) => [...baseArgs],
          envBuilder: ({ env }) => env,
          preflight: () => undefined,
          permissionDecision: () => ({ kind: 'defer' }),
        },
      },
    });

    expect(() => (assertSupported as (input: typeof definition) => void)(definition)).not.toThrow();
  });

  it('lets argvBuilder replace final declarative launch argv without duplicating permission args', async () => {
    const runtimeCore = await import('../runtimeCore');
    const resolveLaunch = (runtimeCore as Record<string, unknown>).resolveAcpRuntimeLaunch;
    expect(resolveLaunch).toEqual(expect.any(Function));
    const observed: unknown[] = [];

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.argv',
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
            read_only: 'read-only',
          },
        },
        callbacks: {
          argvBuilder: (params) => {
            observed.push(params);
            return [
              'wrapped-agent',
              ...params.baseArgs,
              '--cwd',
              params.cwd,
              '--mode',
              params.permissionMode ?? 'none',
            ];
          },
        },
      },
    });

    const launch = await (resolveLaunch as (input: {
      definition: typeof definition;
      cwd: string;
      permissionMode?: string;
    }) => { command: string; args: readonly string[] } | Promise<{ command: string; args: readonly string[] }>)({
      definition,
      cwd: '/workspace',
      permissionMode: 'read_only',
    });

    expect(launch.command).toBe('acme-agent');
    expect(launch.args).toEqual([
      'wrapped-agent',
      'acp',
      '--permission-mode',
      'read-only',
      '--cwd',
      '/workspace',
      '--mode',
      'read_only',
    ]);
    expect(observed).toEqual([{
      baseArgs: ['acp', '--permission-mode', 'read-only'],
      cwd: '/workspace',
      env: {
        DEBUG: '',
        NODE_ENV: 'production',
      },
      permissionMode: 'read_only',
    }]);
  });

  it('passes materialized launch env to argvBuilder for env-shaped argv callbacks', async () => {
    const runtimeCore = await import('../runtimeCore');
    const resolveLaunch = (runtimeCore as Record<string, unknown>).resolveAcpRuntimeLaunch;
    expect(resolveLaunch).toEqual(expect.any(Function));
    const observed: unknown[] = [];

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.env-argv',
        launchEnv: {
          FROM_DEFINITION: 'definition',
        },
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
            args: ['acp'],
            env: {
              FROM_TRANSPORT: 'transport',
            },
          },
        },
        callbacks: {
          argvBuilder: ((params: Readonly<{
            baseArgs: readonly string[];
            cwd: string;
            env: Readonly<Record<string, string>>;
            permissionMode?: string;
          }>) => {
            observed.push(params);
            return params.env.FROM_SESSION === '1'
              ? [...params.baseArgs, '--from-session-env']
              : [...params.baseArgs];
          }) as NonNullable<HostAcpBackendSpec['callbacks']>['argvBuilder'],
        },
      },
    });

    const launch = await (resolveLaunch as (input: {
      definition: typeof definition;
      cwd: string;
      env?: Readonly<Record<string, string | undefined>>;
    }) => Promise<{ args: readonly string[]; env: Readonly<Record<string, string>> }>)({
      definition,
      cwd: '/workspace',
      env: {
        FROM_SESSION: '1',
      },
    });

    expect(launch.args).toEqual(['acp', '--from-session-env']);
    expect(observed).toEqual([expect.objectContaining({
      baseArgs: ['acp'],
      cwd: '/workspace',
      env: expect.objectContaining({
        FROM_DEFINITION: 'definition',
        FROM_TRANSPORT: 'transport',
        FROM_SESSION: '1',
        NODE_ENV: 'production',
      }),
    })]);
  });

  it('rejects empty argvBuilder output as a typed callback startup failure', async () => {
    const runtimeCore = await import('../runtimeCore');
    const resolveLaunch = (runtimeCore as Record<string, unknown>).resolveAcpRuntimeLaunch;
    expect(resolveLaunch).toEqual(expect.any(Function));

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.empty-argv',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        callbacks: {
          argvBuilder: () => [],
        },
      },
    });

    await expect((resolveLaunch as (input: {
      definition: typeof definition;
      cwd: string;
    }) => unknown)({
      definition,
      cwd: '/workspace',
    })).rejects.toMatchObject({
      code: 'HAPPIER_ACP_TIER2_CALLBACK_ERROR',
      callback: 'argvBuilder',
      backendId: 'acme.plugin.empty-argv',
      startupFailure: true,
    });
  });

  it('wraps thrown argvBuilder failures as typed callback startup failures', async () => {
    const runtimeCore = await import('../runtimeCore');
    const resolveLaunch = (runtimeCore as Record<string, unknown>).resolveAcpRuntimeLaunch;
    expect(resolveLaunch).toEqual(expect.any(Function));

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.throw-argv',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        callbacks: {
          argvBuilder: () => {
            throw new Error('plugin argv failed');
          },
        },
      },
    });

    await expect((resolveLaunch as (input: {
      definition: typeof definition;
      cwd: string;
    }) => unknown)({
      definition,
      cwd: '/workspace',
    })).rejects.toMatchObject({
      code: 'HAPPIER_ACP_TIER2_CALLBACK_ERROR',
      callback: 'argvBuilder',
      backendId: 'acme.plugin.throw-argv',
      startupFailure: true,
    });
  });

  it('supports async argvBuilder callbacks with the same launch contract', async () => {
    const runtimeCore = await import('../runtimeCore');
    const resolveLaunch = (runtimeCore as Record<string, unknown>).resolveAcpRuntimeLaunch;
    expect(resolveLaunch).toEqual(expect.any(Function));

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.async-argv',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
            args: ['acp'],
          },
        },
        callbacks: {
          argvBuilder: async ({ baseArgs }) => ['async-agent', ...baseArgs],
        },
      },
    });

    await expect((resolveLaunch as (input: {
      definition: typeof definition;
      cwd: string;
    }) => Promise<{ args: readonly string[] }>)({
      definition,
      cwd: '/workspace',
    })).resolves.toMatchObject({
      args: ['async-agent', 'acp'],
    });
  });

  it('overlays envBuilder output after host launch env materialization', async () => {
    const runtimeCore = await import('../runtimeCore');
    const resolveLaunch = (runtimeCore as Record<string, unknown>).resolveAcpRuntimeLaunch;
    expect(resolveLaunch).toEqual(expect.any(Function));
    const observedEnv: Array<Readonly<Record<string, string>>> = [];

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.env',
        launchEnv: {
          FROM_DEFINITION: 'definition',
        },
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
            env: {
              FROM_TRANSPORT: 'transport',
              DEBUG: 'transport-debug',
            },
          },
        },
        callbacks: {
          envBuilder: ({ env }) => {
            observedEnv.push(env);
            return {
              DEBUG: 'callback-debug',
              FROM_CALLBACK: 'callback',
            };
          },
        },
      },
    });

    const launch = await (resolveLaunch as (input: {
      definition: typeof definition;
      cwd: string;
    }) => Promise<{ env: Readonly<Record<string, string>> }>)({
      definition,
      cwd: '/workspace',
    });

    expect(observedEnv).toEqual([expect.objectContaining({
      FROM_DEFINITION: 'definition',
      FROM_TRANSPORT: 'transport',
      DEBUG: 'transport-debug',
      NODE_ENV: 'production',
    })]);
    expect(launch.env).toEqual(expect.objectContaining({
      FROM_DEFINITION: 'definition',
      FROM_TRANSPORT: 'transport',
      DEBUG: 'callback-debug',
      FROM_CALLBACK: 'callback',
    }));
  });

  it('passes permissionMode to envBuilder callbacks after host env materialization', async () => {
    const runtimeCore = await import('../runtimeCore');
    const resolveLaunch = (runtimeCore as Record<string, unknown>).resolveAcpRuntimeLaunch;
    expect(resolveLaunch).toEqual(expect.any(Function));

    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.permission-env',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        callbacks: {
          envBuilder: (params) => ({
            PERMISSION_MODE: 'permissionMode' in params && typeof params.permissionMode === 'string'
              ? params.permissionMode
              : 'missing',
          }),
        },
      },
    });

    const launch = await (resolveLaunch as (input: {
      definition: typeof definition;
      cwd: string;
      permissionMode?: string;
    }) => Promise<{ env: Readonly<Record<string, string>> }>)({
      definition,
      cwd: '/workspace',
      permissionMode: 'safe-yolo',
    });

    expect(launch.env.PERMISSION_MODE).toBe('safe-yolo');
  });

  it('lets plugin ACP definitions prefer session-scoped approval options without provider branches', () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.permissions',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        permissionOptionSelection: {
          approved: 'allow_always',
        },
      },
    });
    const handler = createAcpTransportHandlerFromDefinition(definition);

    expect(handler.pickPermissionOptionId?.([
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'allow-always', kind: 'allow_always' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ], 'approved', {
      toolCallId: 'tool-1',
      toolName: 'edit',
      input: {},
    })).toBe('allow-always');
  });

  it('runs preflight immediately before backend creation and blocks startup on failure', async () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.preflight',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        callbacks: {
          preflight: async ({ cwd }) => {
            expect(cwd).toBe('/workspace');
            throw new Error('preflight failed');
          },
        },
      },
    });

    await expect(createAcpBackendFromDefinition({
      definition,
      cwd: '/workspace',
    })).rejects.toMatchObject({
      code: 'HAPPIER_ACP_TIER2_CALLBACK_ERROR',
      callback: 'preflight',
      backendId: 'acme.plugin.preflight',
      startupFailure: true,
    });
  });

  it('composes permissionDecision allow, defer, and invalid outputs with the existing ACP permission handler', async () => {
    const baseHandler = {
      getImmediateDecision: vi.fn(() => null),
      handleToolCall: vi.fn(async () => ({ decision: 'denied' as const })),
    } satisfies AcpPermissionHandler;
    const permissionDecision = ((request: { toolName: string }) => {
      const { toolName } = request;
      if (toolName === 'read') {
        return {
          kind: 'allow',
          rationale: 'read-only',
          followUpPrompt: {
            prompt: 'Continue with the approved read.',
            delivery: 'followUp',
          },
          persistAllowRule: {
            scope: 'session',
            toolName: 'read',
          },
        };
      }
      if (toolName === 'write') {
        return { kind: 'defer' };
      }
      return { kind: 'invalid' };
    }) as unknown as NonNullable<ReturnType<typeof normalizePluginAcpDefinition>['callbacks']['permissionDecision']>;
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.permissions',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        callbacks: {
          // Boundary regression: unchecked plugin JavaScript can still return invalid callback output.
          permissionDecision,
        },
      },
    });

    const backend = await createAcpBackendFromDefinition({
      definition,
      cwd: '/workspace',
      permissionHandler: baseHandler,
    });
    const wrappedHandler = (backend as unknown as {
      options: {
        permissionHandler?: AcpPermissionHandler;
      };
    }).options.permissionHandler;

    expect(wrappedHandler?.getImmediateDecision?.('tool-1', 'read', {})).toEqual({
      decision: 'approved',
      rationale: 'read-only',
      followUpPrompt: {
        prompt: 'Continue with the approved read.',
        delivery: 'followUp',
      },
      persistAllowRule: {
        scope: 'session',
        toolName: 'read',
      },
    });
    await expect(wrappedHandler?.handleToolCall('tool-1', 'read', {})).resolves.toEqual({
      decision: 'approved',
      rationale: 'read-only',
      followUpPrompt: {
        prompt: 'Continue with the approved read.',
        delivery: 'followUp',
      },
      persistAllowRule: {
        scope: 'session',
        toolName: 'read',
      },
    });
    await expect(wrappedHandler?.handleToolCall('tool-2', 'write', {})).resolves.toEqual({
      decision: 'denied',
    });
    await expect(wrappedHandler?.handleToolCall('tool-3', 'unknown', {})).resolves.toEqual({
      decision: 'denied',
    });
    await expect(
      wrappedHandler?.handleToolCall('host-fs-write', 'read', {}, { origin: 'host_acp_fs_write' }),
    ).resolves.toEqual({
      decision: 'denied',
    });
    expect(baseHandler.handleToolCall).toHaveBeenCalledTimes(3);

    const fallbackWithoutPreview = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved' as const })),
    } satisfies AcpPermissionHandler;
    const backendWithoutPreview = await createAcpBackendFromDefinition({
      definition,
      cwd: '/workspace',
      permissionHandler: fallbackWithoutPreview,
    });
    const wrappedWithoutPreview = (backendWithoutPreview as unknown as {
      options: {
        permissionHandler?: AcpPermissionHandler;
      };
    }).options.permissionHandler;
    await expect(
      wrappedWithoutPreview?.handleToolCall('host-fs-write-no-preview', 'read', {}, {
        origin: 'host_acp_fs_write',
      }),
    ).resolves.toEqual({
      decision: 'approved',
    });
    expect(
      wrappedWithoutPreview?.getImmediateDecision?.('host-fs-write-no-preview', 'read', {}, {
        origin: 'host_acp_fs_write',
      }),
    ).toBeNull();
  });

  it('fails closed when permissionDecision returns invalid output without a fallback permission handler', async () => {
    const permissionDecision = (
      (() => ({ kind: 'invalid' }))
    ) as unknown as NonNullable<ReturnType<typeof normalizePluginAcpDefinition>['callbacks']['permissionDecision']>;
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.invalid-permission-no-fallback',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        callbacks: {
          permissionDecision,
        },
      },
    });

    const backend = await createAcpBackendFromDefinition({
      definition,
      cwd: '/workspace',
    });
    const wrappedHandler = (backend as unknown as {
      options: {
        permissionHandler?: AcpPermissionHandler;
      };
    }).options.permissionHandler;

    expect(wrappedHandler?.getImmediateDecision?.('tool-1', 'unknown', {})).toBeNull();
    await expect(wrappedHandler?.handleToolCall('tool-1', 'unknown', {})).resolves.toEqual({
      decision: 'denied',
      rationale: 'permissionDecision deferred without a fallback permission handler',
    });
  });

  it('fails closed when permissionDecision throws without a fallback permission handler', async () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin.throw-permission-no-fallback',
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
        callbacks: {
          permissionDecision: () => {
            throw new Error('permission callback failed');
          },
        },
      },
    });

    const backend = await createAcpBackendFromDefinition({
      definition,
      cwd: '/workspace',
    });
    const wrappedHandler = (backend as unknown as {
      options: {
        permissionHandler?: AcpPermissionHandler;
      };
    }).options.permissionHandler;

    expect(wrappedHandler?.getImmediateDecision?.('tool-1', 'unknown', {})).toBeNull();
    await expect(wrappedHandler?.handleToolCall('tool-1', 'unknown', {})).resolves.toEqual({
      decision: 'denied',
      rationale: 'permissionDecision deferred without a fallback permission handler',
    });
  });

  it('publishes configured ACP session metadata from runtime plans launched as configured targets', async () => {
    const definition = normalizePluginAcpDefinition({
      pluginId: 'acme.plugin',
      spec: {
        backendId: 'acme.plugin-backed-acp.backend',
        ux: {
          title: 'Plugin Review Bot',
        },
        transport: {
          kind: 'stdio',
          launch: {
            kind: 'executable',
            command: 'acme-agent',
          },
        },
      },
    });

    const adapter = createAcpRuntimeCoreFromDefinition(definition);
    const plan = await adapter.runtimeCore.createSessionRuntime({
      credentials: { token: 'token-only', encryption: null },
      backendTarget: {
        kind: 'backend',
        backendId: 'acme.plugin-backed-acp.backend',
        configuredBackendId: 'acme.plugin-backed-acp.backend',
        sourceKind: 'configured',
      },
    });

    expect(plan.config.flavor).toBe('acp:acme.plugin-backed-acp.backend');
    expect(plan.config.agentMessageType).toBe('acp:acme.plugin-backed-acp.backend');
    expect(plan.config.runtimeActivityApplicability).toBe('not_applicable');
    expect(plan.config.augmentSessionMetadata?.({
      path: '/workspace',
      flavor: plan.config.flavor,
    } as never)).toMatchObject({
      flavor: 'acp:acme.plugin-backed-acp.backend',
      acpConfiguredBackendV1: {
        v: 1,
        backendId: 'acme.plugin-backed-acp.backend',
        title: 'Plugin Review Bot',
      },
    });
  });

  it('rejects legacy plugin ACP wire instead of preserving a loose .acp compatibility path', () => {
    expect(() => normalizePluginBackendContributionAcpDefinition({
        pluginId: 'acme.plugin',
        backend: {
          id: 'acme.plugin.acp',
          agentId: 'acme.plugin',
          runtimeKind: 'acp',
          acp: {
            command: 'acme-agent',
          },
        },
    })).toThrow(/agents\[\]\.runtime\.kind/);
  });
});
