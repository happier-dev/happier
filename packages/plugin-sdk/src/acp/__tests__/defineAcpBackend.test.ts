import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  autoRegisterAcpBackend,
  defineAcpBackend,
  isAcpBackendEngine,
  readAcpBackendSpec,
} from '../index.js';
import type { AcpAuthoringServiceV1 } from '../../context.js';
import type { PluginApiV1 } from '../../api.js';
import type { PluginContextV1 } from '../../context.js';
import type { AcpBackendSpecV1 } from '../types.js';

describe('defineAcpBackend', () => {
  it('marks the returned engine with the ACP backend spec', () => {
    const spec = {
      backendId: 'acme.review.acp',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'executable',
          command: 'acme-agent',
          args: ['acp'],
        },
      },
      ux: {
        title: 'Acme Review',
      },
      mcp: {
        policy: 'drop',
      },
    } as const;

    const engine = defineAcpBackend(spec);

    expect(isAcpBackendEngine(engine)).toBe(true);
    expect(readAcpBackendSpec(engine)).toEqual(spec);
  });

  it('accepts the locked Q-4 ACP authoring shape without dropping declared fields', () => {
    const preDial = vi.fn(async () => undefined);
    const spec = {
      backendId: 'acme.full.acp',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'executable',
          command: 'acme-agent',
          args: ['acp'],
        },
        customHandler: {
          preDial,
          onMessage: (message, ctx) => ctx.phase === 'incoming'
            ? { kind: 'replace', message }
            : 'pass',
        },
        timeouts: {
          initMs: 20,
          initDelayMs: 10,
          idleMs: 30,
          toolCallMs: 40,
          promptLivenessMs: 50,
          postPromptNoUpdatesMs: 60,
          postToolCallIdleMs: 70,
          idleWithoutAssistantMessageMs: 80,
          preToolCallIdleMs: 90,
        },
      },
      ux: {
        title: 'Acme Full Agent',
        defaultMode: 'review',
      },
      capabilities: {
        supportsResume: true,
        supportsStreaming: true,
        supportsToolUse: true,
        supportsPermissionRequests: true,
        supportsInFlightSteer: false,
        supportsModelSwitch: true,
        customMessageKinds: ['acme.delta'],
        supportsLoadSession: true,
        supportsModes: 'yes',
        supportsModels: 'unknown',
        supportsConfigOptions: 'no',
        promptImageSupport: 'yes',
      },
      auth: {
        config: {
          support: 'manual_only',
          docsUrl: 'https://example.com/acp-auth',
        },
        methodId: 'acme-api-key',
        resolveMethodId: (_ctx, { env }) => env.ACME_VERTEX === '1' ? 'acme-vertex' : 'acme-api-key',
        detectAuthStatus: async () => 'logged_in',
        buildAuthEnv: () => ({ ACME_TOKEN: 'redacted' }),
      },
      permissionModeArgv: {
        flag: '--permission',
        map: {
          default: null,
          plan: 'plan',
        },
      },
      bootstrap: {
        preStart: async () => undefined,
        postReady: async () => undefined,
      },
      messageMeta: {
        enrichOutgoing: (message) => ({ message }),
        enrichIncoming: (message) => ({ message }),
      },
      fsEnabled: true,
    } satisfies AcpBackendSpecV1;

    const engine = defineAcpBackend(spec);

    expect(readAcpBackendSpec(engine)).toEqual(spec);
  });

  it('accepts minimal T.4 ACP specs without requiring ux metadata', () => {
    const spec = {
      backendId: 'acme.minimal.acp',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'executable',
          command: 'acme-agent',
        },
      },
    } satisfies AcpBackendSpecV1;

    const engine = defineAcpBackend(spec);

    expect(readAcpBackendSpec(engine)).toEqual(spec);
  });

  it('accepts T.4 websocket URL resolver functions', () => {
    const spec = {
      backendId: 'acme.ws.acp',
      transport: {
        kind: 'ws',
        url: ({ sessionId }) => `wss://example.test/acp/${sessionId}`,
      },
    } satisfies AcpBackendSpecV1;

    const engine = defineAcpBackend(spec);

    expect(readAcpBackendSpec(engine)).toEqual(spec);
  });

  it('keeps Tier-2 callbacks on the ACP backend definition surface', async () => {
    const spec = {
      backendId: 'acme.tier2.acp',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'executable',
          command: 'acme-agent',
          args: ['acp'],
        },
      },
      callbacks: {
        argvBuilder: ({ baseArgs, cwd, permissionMode }) => [
          'acme-agent',
          ...baseArgs,
          '--cwd',
          cwd,
          ...(permissionMode ? ['--mode', permissionMode] : []),
        ],
        envBuilder: ({ env }) => ({
          ...env,
          ACME_TIER2: '1',
        }),
        preflight: async ({ cwd }) => {
          expect(cwd).toBe('/workspace');
        },
        permissionDecision: ({ toolName }) => (
          toolName === 'read'
            ? { kind: 'allow', rationale: 'read-only tool' }
            : { kind: 'defer' }
        ),
      },
    } satisfies AcpBackendSpecV1;

    const engine = defineAcpBackend(spec);

    expect(readAcpBackendSpec(engine)).toEqual(spec);
    expect(await spec.callbacks.argvBuilder({
      baseArgs: ['acp', '--permission-mode', 'read-only'],
      cwd: '/workspace',
      permissionMode: 'read_only',
    })).toEqual([
      'acme-agent',
      'acp',
      '--permission-mode',
      'read-only',
      '--cwd',
      '/workspace',
      '--mode',
      'read_only',
    ]);
    expect(await spec.callbacks.permissionDecision({
      toolCallId: 'tool-1',
      toolName: 'read',
      input: { path: 'README.md' },
    })).toEqual({
      kind: 'allow',
      rationale: 'read-only tool',
    });
  });

  it('does not expose a parallel ACP activate hook API', () => {
    const api = {
      registerAgentRuntime: vi.fn(),
    } satisfies Pick<PluginApiV1, 'registerAgentRuntime'>;
    const rejectedApiName = ['registerAcp', 'ActivateHook'].join('');

    expect(rejectedApiName in api).toBe(false);
    expect((api as Readonly<Record<string, unknown>>)[rejectedApiName]).toBeUndefined();
  });

  it('keeps ACP message meta hooks sync-only in public SDK types', () => {
    const spec = {
      backendId: 'acme.sync-meta.acp',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'executable',
          command: 'acme-agent',
        },
      },
      messageMeta: {
        // @ts-expect-error A.15.2 exposes only sync T.4 message-meta hooks.
        enrichOutgoing: async (message) => ({ message }),
      },
    } satisfies AcpBackendSpecV1;

    expect(spec.backendId).toBe('acme.sync-meta.acp');
  });

  it('exposes the full ctx.agentRuntime.acp service contract for Tier 3 composition callers', async () => {
    const spec = {
      backendId: 'acme.runtime.acp',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'executable',
          command: 'acme-agent',
        },
      },
      ux: {
        title: 'Acme Runtime',
      },
    } satisfies AcpBackendSpecV1;
    const handle = {
      runtime: { ok: true },
      dispose: vi.fn(async () => undefined),
    };
    const service = {
      defineAcpBackend,
      createRuntime: vi.fn(async () => handle),
    } satisfies AcpAuthoringServiceV1;

    await expect(service.createRuntime(spec, {
      sessionId: 'session-1',
      cwd: '/workspace',
      permissionMode: 'read-only',
    })).resolves.toBe(handle);
  });

  it('registers agent/acp.js definitions as agent runtimes that use ctx.agentRuntime.acp', async () => {
    const registerAgentRuntime = vi.fn();
    const api = {
      registerAgentRuntime,
    } as unknown as PluginApiV1;
    const spec = {
      backendId: 'acme.agent.acp',
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
    } as const;

    await expect(
      autoRegisterAcpBackend('/plugins/acme', api, {
        moduleExists: () => true,
        importModule: async (modulePath) => {
          expect(modulePath).toBe('/plugins/acme/agent/acp.js');
          return {
            ACP_BACKEND_DEFINITION: spec,
          };
        },
      }),
    ).resolves.toBe(true);

    expect(registerAgentRuntime).toHaveBeenCalledWith({
      agentId: 'acme.agent.acp',
      create: expect.any(Function),
    });

    const registration = registerAgentRuntime.mock.calls[0]?.[0] as {
      create: (ctx: PluginContextV1) => unknown;
    };
    const expectedEngine = defineAcpBackend(spec);
    const ctx = {
      agentRuntime: {
        acp: {
          defineAcpBackend: vi.fn(() => expectedEngine),
        },
      },
    } as unknown as PluginContextV1;

    expect(registration.create(ctx)).toBe(expectedEngine);
    expect(ctx.agentRuntime.acp.defineAcpBackend).toHaveBeenCalledWith(spec);
  });

  it('skips auto-registration without importing when agent/acp.js is absent', async () => {
    const importModule = vi.fn(async () => ({}));
    const api = {
      registerAgentRuntime: vi.fn(),
    } as unknown as PluginApiV1;
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-missing-'));

    try {
      await expect(
        autoRegisterAcpBackend(dir, api, { importModule }),
      ).resolves.toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(importModule).not.toHaveBeenCalled();
    expect(api.registerAgentRuntime).not.toHaveBeenCalled();
  });

  it('rethrows import failures when agent/acp.js exists but its dependencies fail', async () => {
    const importFailure = Object.assign(new Error('Cannot find package acme-missing-dep'), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const importModule = vi.fn(async () => {
      throw importFailure;
    });
    const api = {
      registerAgentRuntime: vi.fn(),
    } as unknown as PluginApiV1;
    const dir = mkdtempSync(join(tmpdir(), 'happier-acp-existing-'));
    writeFileSync(join(dir, 'agent-acp.js'), 'export {};');

    try {
      await expect(
        autoRegisterAcpBackend(dir, api, {
          importModule,
          resolveModulePath: () => join(dir, 'agent-acp.js'),
        }),
      ).rejects.toBe(importFailure);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(api.registerAgentRuntime).not.toHaveBeenCalled();
  });
});
