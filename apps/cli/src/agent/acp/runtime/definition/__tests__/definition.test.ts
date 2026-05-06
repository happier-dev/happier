import { describe, expect, it, vi } from 'vitest';

import {
  createAcpBackendFromDefinition,
  createAcpRuntimeCoreFromDefinition,
  normalizeBuiltInAcpDefinition,
  normalizeConfiguredAcpDefinition,
  normalizePluginAcpDefinition,
  normalizePluginBackendContributionAcpDefinition,
} from '../index';
import type { ResolvedConfiguredAcpBackend } from '../../../catalog/configured/resolveBackend';
import type { AcpPermissionHandler } from '../../../permissions/acpPermissionHandler';

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
      backendId: 'custom-acp',
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
      permissionMode: 'read_only',
    }]);
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
        return { kind: 'allow', rationale: 'read-only' };
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
    });
    await expect(wrappedHandler?.handleToolCall('tool-1', 'read', {})).resolves.toEqual({
      decision: 'approved',
      rationale: 'read-only',
    });
    await expect(wrappedHandler?.handleToolCall('tool-2', 'write', {})).resolves.toEqual({
      decision: 'denied',
    });
    await expect(wrappedHandler?.handleToolCall('tool-3', 'unknown', {})).resolves.toEqual({
      decision: 'denied',
    });
    expect(baseHandler.handleToolCall).toHaveBeenCalledTimes(2);
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
