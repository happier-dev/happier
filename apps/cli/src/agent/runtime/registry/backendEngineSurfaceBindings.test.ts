import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';

import type { ResolvedAgentRuntimeContribution } from '../../../plugins/projection/registry/types';
import { HostTerminalModelSelectionBlockedError } from '../session/terminal/contract';
import { createHostTerminalTranscriptFollowService } from '../session/terminal/transcriptFollow';
import { resolveBackendExecutionSurfacesFromNativeAgentRuntime } from './backendEngineSurfaceBindings';

type AgentRuntimeForkRequest = Parameters<
  NonNullable<NonNullable<NonNullable<AgentRuntime['surfaces']>['fork']>['fork']>
>[0];

function createBackend(): ResolvedAgentRuntimeContribution {
  return {
    id: 'acme.runtime.backend',
    agentId: 'acme.runtime.provider',
    provenance: 'external',
    source: { kind: 'path' },
    definition: {
      kindVersion: 1,
      id: 'acme.runtime.backend',
      agentId: 'acme.runtime.provider',
    },
    runtimeKind: 'custom',
    capabilities: {
      executionRun: { supported: false },
        session: {
          media: {
            acceptsImageInput: { supported: false },
            emitsSessionMedia: { supported: false },
            nativeImageGeneration: { supported: false },
          },
          contextCompaction: {
            events: { supported: false },
            manualTrigger: { supported: false },
            transcriptInference: { supported: false },
          },
        },
      },
    surfaceHandlers: [],
    pluginId: 'acme.runtime',
    manifestPath: '/plugins/acme.runtime/.happier-plugin/plugin.json',
    daemonEntryPath: '/plugins/acme.runtime/daemon.mjs',
  };
}

async function allowCurrentPublisherEffect<T>(
  localEffect: () => Promise<T>,
): Promise<Readonly<{ status: 'completed'; value: T }>> {
  return {
    status: 'completed',
    value: await localEffect(),
  };
}

describe('resolveBackendExecutionSurfacesFromNativeAgentRuntime', () => {
  function createNativeRuntime(
    resolveLaunch: NonNullable<NonNullable<AgentRuntime['surfaces']>['terminal']>['resolveLaunch'],
  ): AgentRuntime {
    return {
      executionRuns: {
        open: async () => ({
          send: async () => ({ status: 'admitted' }),
          stop: async () => ({ status: 'requested' }),
          watch: () => ({ dispose: () => undefined }),
          dispose: async () => undefined,
        }),
      },
      surfaces: { terminal: { resolveLaunch } },
    };
  }

  it('projects runtime-provided attach and checkpoint surfaces without requiring terminal support', async () => {
    const attach = {
      attach: vi.fn(async () => ({ ok: true as const, value: { exitCode: 0 } })),
    } satisfies NonNullable<NonNullable<AgentRuntime['surfaces']>['attach']>;
    const checkpoint = {
      checkpoint: vi.fn(async () => ({
        id: 'checkpoint-1',
        target: { kind: 'provider_checkpoint' as const, checkpointId: 'provider-checkpoint-1' },
        timing: 'idle' as const,
        checkpointScopes: ['conversation' as const],
        restoreScopes: ['conversation' as const],
      })),
    } satisfies NonNullable<NonNullable<AgentRuntime['surfaces']>['checkpoint']>;
    const runtime: AgentRuntime = {
      executionRuns: {
        open: async () => ({
          send: async () => ({ status: 'admitted' }),
          stop: async () => ({ status: 'requested' }),
          watch: () => ({ dispose: () => undefined }),
          dispose: async () => undefined,
        }),
      },
      surfaces: { attach, checkpoint },
    };

    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime,
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(),
      diagnostics: [],
    });

    await expect(surfaces.attach!.attach({ sessionId: 'session-1', metadata: {} }))
      .resolves.toEqual({ ok: true, value: { exitCode: 0 } });
    expect(attach.attach).toHaveBeenCalledWith({ sessionId: 'session-1', metadata: {} });
    expect(surfaces.checkpoint).toBe(checkpoint);
    expect(surfaces.terminalRuntime).toBeNull();
  });

  it('binds author-owned handoff and replay fork operations to one host-approved invocation context', async () => {
    const services = { exec: { source: 'host-approved' } };
    const createAgentRuntimeSurfaceInvocationContext = vi.fn(async (request: Readonly<{
      cwd: string;
      happierSessionId?: string;
    }>) => {
      return {
        plugin: { id: 'acme.runtime', version: '1.0.0' },
        contribution: {
          id: 'acme.runtime.provider',
          qualifiedId: 'acme.runtime/agents/acme.runtime.provider',
        },
        surface: 'agent' as const,
        ...(request.happierSessionId ? { session: { id: request.happierSessionId } } : {}),
        signal: new AbortController().signal,
        services,
      } as unknown as import('@happier-dev/plugin-sdk').PluginInvocationContext;
    });
    const exportBundle = vi.fn(async (
      request: Readonly<{ sessionId: string }>,
      context: import('@happier-dev/plugin-sdk').PluginInvocationContext,
    ) => {
      expect(request.sessionId).toBe('vendor-session-1');
      expect(context.session).toBeUndefined();
      expect(context.services).toBe(services);
      return { ok: true as const, value: { bundle: { agentId: 'acme.runtime' } } };
    });
    const resolveReplayChildLaunch = vi.fn(async (
      _request: unknown,
      context: import('@happier-dev/plugin-sdk').PluginInvocationContext,
    ) => {
      expect(context.session?.id).toBe('happier-parent-session-1');
      expect(context.services).toBe(services);
      return { environmentVariables: { ACME_REPLAY: '1' } };
    });
    const runtime = {
      executionRuns: {
        open: async () => ({
          send: async () => ({ status: 'admitted' as const }),
          stop: async () => ({ status: 'requested' as const }),
          watch: () => ({ dispose: () => undefined }),
          dispose: async () => undefined,
        }),
      },
      surfaces: {
        handoff: {
          exportBundle,
          importBundle: async () => ({
            ok: false as const,
            code: 'bundle_invalid' as const,
            message: 'not exercised',
          }),
        },
        fork: { resolveReplayChildLaunch },
      },
    } satisfies AgentRuntime;

    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime,
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(),
      diagnostics: [],
      createAgentRuntimeSurfaceInvocationContext,
    });

    expect(surfaces.handoff).not.toBeNull();
    await expect(surfaces.handoff!.exportBundle({
      sessionId: 'vendor-session-1',
      metadata: {},
      directory: '/repo',
    })).resolves.toEqual({
      ok: true,
      value: { bundle: { agentId: 'acme.runtime' } },
    });
    expect(surfaces.fork).not.toBeNull();
    await expect(surfaces.fork!.resolveReplayChildLaunch!({
      parentSessionId: 'happier-parent-session-1',
      parentMetadata: {},
      directory: '/repo',
      forkPoint: { kind: 'latest' },
    })).resolves.toEqual({ environmentVariables: { ACME_REPLAY: '1' } });
    expect(exportBundle).toHaveBeenCalledOnce();
    expect(resolveReplayChildLaunch).toHaveBeenCalledOnce();
    expect(createAgentRuntimeSurfaceInvocationContext).toHaveBeenNthCalledWith(1, { cwd: '/repo' });
    expect(createAgentRuntimeSurfaceInvocationContext).toHaveBeenNthCalledWith(2, {
      cwd: '/repo',
      happierSessionId: 'happier-parent-session-1',
    });
  });

  it('projects host ACP fork operations through the author-owned fork boundary', async () => {
    const signal = new AbortController().signal;
    const fork = vi.fn(async (request: AgentRuntimeForkRequest) => {
      const loaded = await request.acp?.loadSession({
        backendId: 'acme.runtime.backend',
        directory: '/repo',
        providerSessionId: 'parent-provider-session',
      });
      const forked = await request.acp?.forkSession({
        backendId: 'acme.runtime.backend',
        directory: '/repo',
        sourceProviderSessionId: 'parent-provider-session',
      });

      expect(loaded).toEqual({
        ok: true,
        value: { providerSessionId: 'parent-provider-session' },
      });
      expect(forked).toEqual({
        ok: true,
        value: { providerSessionId: 'child-provider-session' },
      });

      return {
        providerSessionId: 'child-provider-session',
        launch: {
          sessionStateUpdates: [{
            fieldId: 'identity.providerSessionId' as const,
            value: 'child-provider-session',
          }],
        },
      };
    });
    const runtime = {
      executionRuns: {
        open: async () => ({
          send: async () => ({ status: 'admitted' as const }),
          stop: async () => ({ status: 'requested' as const }),
          watch: () => ({ dispose: () => undefined }),
          dispose: async () => undefined,
        }),
      },
      surfaces: { fork: { fork } },
    } satisfies AgentRuntime;
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime,
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(),
      diagnostics: [],
      createAgentRuntimeSurfaceInvocationContext: async () => ({ signal } as never),
    });

    await expect(surfaces.fork!.fork!({
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/repo',
      forkPoint: { kind: 'latest' },
      acp: {
        loadSession: async (request) => {
          expect(request.signal).toBe(signal);
          return {
            ok: true as const,
            value: {
              providerSessionId: 'parent-provider-session',
              sessionStateUpdates: [{
                fieldId: 'intent.model' as const,
                value: { v: 1, modelId: 'host-model', updatedAt: 1 },
              }],
            },
          };
        },
        forkSession: async (request) => {
          expect(request.signal).toBe(signal);
          return {
            ok: true as const,
            value: {
              providerSessionId: 'child-provider-session',
              sessionStateUpdates: [{
                fieldId: 'intent.model' as const,
                value: { v: 1, modelId: 'host-model', updatedAt: 1 },
              }],
            },
          };
        },
      },
    })).resolves.toEqual({
      providerSessionId: 'child-provider-session',
      launch: {
        sessionStateUpdates: [{
          fieldId: 'identity.providerSessionId',
          value: 'child-provider-session',
        }],
      },
    });
  });

  it('rejects a handoff result that resolves after its runtime generation retires', async () => {
    let isCurrent = true;
    let resolveExport!: (value: Readonly<{
      ok: true;
      value: Readonly<{ bundle: Readonly<Record<string, never>> }>;
    }>) => void;
    const pendingExport = new Promise<Readonly<{
      ok: true;
      value: Readonly<{ bundle: Readonly<Record<string, never>> }>;
    }>>((resolve) => {
      resolveExport = resolve;
    });
    const runtime = {
      executionRuns: {
        open: async () => ({
          send: async () => ({ status: 'admitted' as const }),
          stop: async () => ({ status: 'requested' as const }),
          watch: () => ({ dispose: () => undefined }),
          dispose: async () => undefined,
        }),
      },
      surfaces: {
        handoff: {
          exportBundle: async () => await pendingExport,
          importBundle: async () => ({
            ok: false as const,
            code: 'bundle_invalid' as const,
            message: 'not exercised',
          }),
        },
      },
    } satisfies AgentRuntime;
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime,
      agentId: 'acme.runtime.provider',
      isCurrent: () => isCurrent,
      declaredAgentSurfaceFamilies: new Set(),
      diagnostics: [],
      createAgentRuntimeSurfaceInvocationContext: async () => ({} as never),
    });

    const exportOperation = surfaces.handoff!.exportBundle({
      sessionId: 'session-1',
      metadata: {},
      directory: '/repo',
    });
    isCurrent = false;
    resolveExport({ ok: true, value: { bundle: {} } });

    await expect(exportOperation).rejects.toThrow(/retired runtime generation/i);
  });

  it('rejects an attach result that resolves after its runtime generation retires', async () => {
    let isCurrent = true;
    let resolveAttach!: (value: Readonly<{ ok: true; value: Readonly<{ exitCode: number | null }> }>) => void;
    const pendingAttach = new Promise<Readonly<{ ok: true; value: Readonly<{ exitCode: number | null }> }>>((resolve) => {
      resolveAttach = resolve;
    });
    const runtime = {
      executionRuns: {
        open: async () => ({
          send: async () => ({ status: 'admitted' as const }),
          stop: async () => ({ status: 'requested' as const }),
          watch: () => ({ dispose: () => undefined }),
          dispose: async () => undefined,
        }),
      },
      surfaces: {
        attach: {
          attach: async () => await pendingAttach,
        },
      },
    } satisfies AgentRuntime;
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime,
      agentId: 'acme.runtime.provider',
      isCurrent: () => isCurrent,
      declaredAgentSurfaceFamilies: new Set(),
      diagnostics: [],
      createAgentRuntimeSurfaceInvocationContext: async () => ({} as never),
    });

    const attachOperation = surfaces.attach!.attach({ sessionId: 'session-1', metadata: {} });
    isCurrent = false;
    resolveAttach({ ok: true, value: { exitCode: 0 } });

    await expect(attachOperation).rejects.toThrow(/retired runtime generation/i);
  });

  it('rejects an attach availability result that resolves after its runtime generation retires', async () => {
    let isCurrent = true;
    let resolveAvailability!: (value: Readonly<{ available: true }>) => void;
    const pendingAvailability = new Promise<Readonly<{ available: true }>>((resolve) => {
      resolveAvailability = resolve;
    });
    const runtime = {
      executionRuns: {
        open: async () => ({
          send: async () => ({ status: 'admitted' as const }),
          stop: async () => ({ status: 'requested' as const }),
          watch: () => ({ dispose: () => undefined }),
          dispose: async () => undefined,
        }),
      },
      surfaces: {
        attach: {
          evaluateAvailability: async () => await pendingAvailability,
          attach: async () => ({ ok: true as const, value: { exitCode: 0 } }),
        },
      },
    } satisfies AgentRuntime;
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime,
      agentId: 'acme.runtime.provider',
      isCurrent: () => isCurrent,
      declaredAgentSurfaceFamilies: new Set(),
      diagnostics: [],
      createAgentRuntimeSurfaceInvocationContext: async () => ({} as never),
    });

    const availabilityOperation = surfaces.attach!.evaluateAvailability!({
      operation: 'attach',
      sessionId: 'session-1',
      metadata: {},
    });
    isCurrent = false;
    resolveAvailability({ available: true });

    await expect(availabilityOperation).rejects.toThrow(/retired runtime generation/i);
  });

  it('refuses to start an attach for an already retired runtime generation', async () => {
    const attach = vi.fn(async () => ({ ok: true as const, value: { exitCode: 0 } }));
    const runtime = {
      executionRuns: {
        open: async () => ({
          send: async () => ({ status: 'admitted' as const }),
          stop: async () => ({ status: 'requested' as const }),
          watch: () => ({ dispose: () => undefined }),
          dispose: async () => undefined,
        }),
      },
      surfaces: { attach: { attach } },
    } satisfies AgentRuntime;
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime,
      agentId: 'acme.runtime.provider',
      isCurrent: () => false,
      declaredAgentSurfaceFamilies: new Set(),
      diagnostics: [],
      createAgentRuntimeSurfaceInvocationContext: async () => ({} as never),
    });

    await expect(surfaces.attach!.attach({ sessionId: 'session-1', metadata: {} }))
      .rejects.toThrow(/retired runtime generation/i);
    expect(attach).not.toHaveBeenCalled();
  });

  it('keeps process, projection, cancellation, and terminal-result ownership in the existing host orchestration', async () => {
    const resolveLaunch = vi.fn(async () => ({
      argv: ['terminal', '--model', 'fast'],
      environment: {
        values: { AGENT_MODE: 'terminal' },
        unset: ['REMOVE_ME'],
      },
      process: {
        stdio: 'inherit' as const,
        windowsHide: true,
        windowsVerbatimArguments: false,
      },
      presentation: {
        onLaunch: { target: 'local' as const, reason: 'terminal_started' },
        onExit: { target: 'remote' as const, reason: 'terminal_finished' },
      },
      resultMetadata: {
        sessionStateUpdates: [{
          fieldId: 'identity.providerSessionId' as const,
          value: 'provider-session-1',
        }],
      },
    }));
    const resolveAgentCliExecutable = vi.fn(async () => ({
      executable: {
        path: '/opt/happier/agent',
        hostGrant: { kind: 'agent-cli' as const, grantId: 'grant-1' },
      },
      args: ['host-prefix'],
      source: 'managed',
      resolvedPath: '/opt/happier/agent',
    }));
    const waitForTermination = vi.fn(async () => ({ type: 'exited' as const, code: 7 }));
    const stop = vi.fn(async () => undefined);
    const launch = vi.fn(async () => ({ pid: 123, waitForTermination, stop }));
    const publishControlState = vi.fn<(
      projection: Readonly<{ target: 'local' | 'remote'; reason?: string }>,
    ) => Promise<void>>(async () => undefined);
    const releaseActiveBindings = vi.fn(async () => undefined);
    const host = {
      input: { subscribe: vi.fn() },
      switching: { register: vi.fn() },
      process: { resolveAgentCliExecutable, launch },
      projection: {
        publishControlState,
        publishProviderSessionId: vi.fn(),
        publishSubagentStarted: vi.fn(),
        publishSubagentCompleted: vi.fn(),
      },
      transcriptFollow: {
        bindProviderSession: vi.fn(),
        releaseActiveBindings,
      },
    };
    const diagnostics: Parameters<typeof resolveBackendExecutionSurfacesFromNativeAgentRuntime>[0]['diagnostics'] = [];
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime: createNativeRuntime(resolveLaunch),
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(['terminalRuntime']),
      diagnostics,
    });
    const signal = new AbortController().signal;
    const terminalLaunchMetadata = {
      model: 'fast',
      externalSessionOperation: { operationClaimId: 'legacy-private-claim' },
      externalSessionOperationV1: {
        v: 1,
        progress: {
          operationId: 'operation-private',
          revision: 3,
          retryable: true,
        },
      },
      externalSessionOperationPresentationV1: {
        v: 1,
        operationId: 'operation-private',
        revision: 3,
        kind: 'materialize',
        status: 'running',
        phase: 'publishing',
      },
      compatibilityMetadata: { owner: 'private' },
      ownerProjection: { owner: 'private' },
      operationClaimId: 'claim-private',
      fence: { token: 'fence-private' },
      paths: { staging: '/private/staging' },
      host: { pid: 123 },
      runtime: { custody: 'host-private' },
      custody: { generation: 'private' },
    } as const;

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'session-1',
      metadata: terminalLaunchMetadata,
      modelSelection: {
        agentTargetKey: 'backend:acme.runtime.provider',
        providerConnectionId: null,
        modelId: 'fast',
      },
      runWithCurrentPublisherPermit: allowCurrentPublisherEffect,
      directory: '/repo',
      env: { HOST_ENV: 'one' },
      isolation: { env: { ISOLATED_ENV: 'two' }, unsetEnvKeys: ['HOST_REMOVE'] },
      signal,
      host,
    })).resolves.toEqual({
      type: 'process_exited',
      exitCode: 7,
      sessionStateUpdates: [{
        fieldId: 'identity.providerSessionId',
        value: 'provider-session-1',
      }],
    });
    expect(diagnostics).toEqual([]);
    expect(resolveLaunch).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cwd: '/repo',
      metadata: {},
      modelSelection: {
        agentTargetKey: 'backend:acme.runtime.provider',
        providerConnectionId: null,
        modelId: 'fast',
      },
    });
    expect(terminalLaunchMetadata).toEqual({
      model: 'fast',
      externalSessionOperation: { operationClaimId: 'legacy-private-claim' },
      externalSessionOperationV1: {
        v: 1,
        progress: {
          operationId: 'operation-private',
          revision: 3,
          retryable: true,
        },
      },
      externalSessionOperationPresentationV1: {
        v: 1,
        operationId: 'operation-private',
        revision: 3,
        kind: 'materialize',
        status: 'running',
        phase: 'publishing',
      },
      compatibilityMetadata: { owner: 'private' },
      ownerProjection: { owner: 'private' },
      operationClaimId: 'claim-private',
      fence: { token: 'fence-private' },
      paths: { staging: '/private/staging' },
      host: { pid: 123 },
      runtime: { custody: 'host-private' },
      custody: { generation: 'private' },
    });
    expect(resolveAgentCliExecutable).toHaveBeenCalledWith({
      agentId: 'acme.runtime.provider',
      cwd: '/repo',
      env: { HOST_ENV: 'one', ISOLATED_ENV: 'two', AGENT_MODE: 'terminal' },
      signal,
    });
    expect(launch).toHaveBeenCalledWith({
      executable: {
        path: '/opt/happier/agent',
        hostGrant: { kind: 'agent-cli', grantId: 'grant-1' },
      },
      args: ['host-prefix', 'terminal', '--model', 'fast'],
      cwd: '/repo',
      env: { HOST_ENV: 'one', ISOLATED_ENV: 'two', AGENT_MODE: 'terminal' },
      unsetEnvKeys: ['HOST_REMOVE', 'REMOVE_ME'],
      stdio: 'inherit',
      windowsHide: true,
      windowsVerbatimArguments: false,
      signal,
    });
    expect(publishControlState.mock.calls.map(([projection]) => projection)).toEqual([
      { target: 'local', reason: 'terminal_started' },
      { target: 'remote', reason: 'terminal_finished' },
    ]);
    expect(waitForTermination).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    // ES-PEP-EU2: the launch surface is no longer a second terminal-follow
    // lifecycle owner. The admission barrier binds before launch, races the
    // ready binding against it, and releases exactly once. (Previously this
    // asserted `toHaveBeenCalledOnce()` here.)
    expect(releaseActiveBindings).not.toHaveBeenCalled();
  });

  it('rejects non-identity Session-state updates from terminal Agent leaves', async () => {
    const resolveLaunch = vi.fn().mockResolvedValue({
      argv: ['terminal'],
      resultMetadata: {
        sessionStateUpdates: [{
          fieldId: 'runtime.externalSessionOperation',
          value: null,
        }],
      },
    });
    const runtime = createNativeRuntime(resolveLaunch);
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime,
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(['terminalRuntime']),
      diagnostics: [],
    });

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'session-private-state',
      metadata: {},
      modelSelection: null,
      runWithCurrentPublisherPermit: allowCurrentPublisherEffect,
      directory: '/repo',
      env: {},
      host: {
        input: { subscribe: vi.fn() },
        switching: { register: vi.fn() },
        process: {
          resolveAgentCliExecutable: vi.fn(async () => ({
            executable: { path: '/agent', hostGrant: { kind: 'agent-cli' as const, grantId: 'grant' } },
            args: [],
            source: 'managed' as const,
            resolvedPath: '/agent',
          })),
          launch: vi.fn(),
        },
        projection: {
          publishControlState: vi.fn(),
          publishProviderSessionId: vi.fn(),
          publishSubagentStarted: vi.fn(),
          publishSubagentCompleted: vi.fn(),
        },
        transcriptFollow: { bindProviderSession: vi.fn(), releaseActiveBindings: vi.fn() },
      },
    })).rejects.toThrow(/unsupported field.*runtime\.externalSessionOperation/i);
  });

  it('does not let a later follow binding delay input return for an already launched process', async () => {
    let finishProcess!: () => void;
    const processFinished = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
    let inputHandler: ((trigger: { sequence: number }) => void | Promise<void>) | undefined;
    let resolveLaterFollow!: () => void;
    const laterFollow = new Promise<void>((resolve) => {
      resolveLaterFollow = resolve;
    });
    const unsubscribeInput = vi.fn();
    const unsubscribeSwitch = vi.fn();
    const followProviderSession = vi.fn(async (request: Readonly<{
      providerSessionId: string;
    }>) => {
      if (request.providerSessionId === 'provider-session-2') {
        await laterFollow;
      }
      return {
        status: 'following' as const,
        startingCursor: null,
        subscription: { dispose: vi.fn(async () => undefined) },
      };
    });
    const transcriptFollow = createHostTerminalTranscriptFollowService({
      loadCommittedLocalIdBaseline: async () => ({
        localIds: new Set<string>(),
        complete: true,
      }),
      followProviderSession,
      signal: new AbortController().signal,
      publish: vi.fn(async () => undefined),
    });
    await expect(transcriptFollow.bindProviderSession({
      agentId: 'acme.runtime.provider',
      providerSessionId: 'provider-session-1',
    })).resolves.toMatchObject({ status: 'following' });
    const stop = vi.fn(async () => finishProcess());
    const host = {
      input: {
        subscribe: vi.fn((handler: typeof inputHandler) => {
          inputHandler = handler;
          return { unsubscribe: unsubscribeInput };
        }),
      },
      switching: {
        register: vi.fn(() => ({ unsubscribe: unsubscribeSwitch })),
      },
      process: {
        resolveAgentCliExecutable: vi.fn(async () => ({
          executable: {
            path: '/opt/happier/agent',
            hostGrant: { kind: 'agent-cli' as const, grantId: 'grant-1' },
          },
          args: [],
          source: 'managed',
          resolvedPath: '/opt/happier/agent',
        })),
        launch: vi.fn(async () => ({
          pid: 123,
          waitForTermination: async () => {
            await processFinished;
            return { type: 'exited' as const, code: 0 };
          },
          stop,
        })),
      },
      projection: {
        publishControlState: vi.fn(),
        publishProviderSessionId: vi.fn(),
        publishSubagentStarted: vi.fn(),
        publishSubagentCompleted: vi.fn(),
      },
      transcriptFollow,
    };
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime: createNativeRuntime(() => ({ argv: ['--terminal'] })),
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(['terminalRuntime']),
      diagnostics: [],
    });

    const result = surfaces.terminalRuntime!.launch!({
      sessionId: 'session-1',
      metadata: {},
      modelSelection: null,
      runWithCurrentPublisherPermit: allowCurrentPublisherEffect,
      directory: '/repo',
      host,
    });
    await vi.waitFor(() => expect(host.process.launch).toHaveBeenCalledOnce());
    let laterBinding: ReturnType<typeof transcriptFollow.bindProviderSession> | null = null;
    let inputReturn: Promise<void> | null = null;
    try {
      if (!inputHandler) throw new Error('host input subscription was not installed');
      laterBinding = transcriptFollow.bindProviderSession({
        agentId: 'acme.runtime.provider',
        providerSessionId: 'provider-session-2',
      });
      await vi.waitFor(() => expect(followProviderSession).toHaveBeenCalledTimes(2));
      let laterBindingSettled = false;
      void laterBinding.then(() => {
        laterBindingSettled = true;
      });
      await Promise.resolve();
      expect(laterBindingSettled).toBe(false);

      inputReturn = Promise.resolve(inputHandler({ sequence: 1 }));
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      await inputReturn;
      await expect(result).resolves.toEqual({
        type: 'control_returned',
        reason: 'pending_input',
      });
      expect(unsubscribeInput).toHaveBeenCalledOnce();
      expect(unsubscribeSwitch).toHaveBeenCalledOnce();
    } finally {
      resolveLaterFollow();
      if (laterBinding) await laterBinding;
      finishProcess();
      if (inputReturn) await inputReturn;
      await result;
      await transcriptFollow.releaseActiveBindings();
    }
  });

  it('returns terminal control through the existing host switch owner', async () => {
    let finishProcess!: () => void;
    const processFinished = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
    let switchHandler: ((request: { target: 'local' | 'remote' | 'unknown' }) => boolean | Promise<boolean>) | undefined;
    const stop = vi.fn(async () => finishProcess());
    const host = {
      input: {
        subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      switching: {
        register: vi.fn((handler: typeof switchHandler) => {
          switchHandler = handler;
          return { unsubscribe: vi.fn() };
        }),
      },
      process: {
        resolveAgentCliExecutable: vi.fn(async () => ({
          executable: {
            path: '/opt/happier/agent',
            hostGrant: { kind: 'agent-cli' as const, grantId: 'grant-1' },
          },
          args: [],
          source: 'managed',
          resolvedPath: '/opt/happier/agent',
        })),
        launch: vi.fn(async () => ({
          pid: 123,
          waitForTermination: async () => {
            await processFinished;
            return { type: 'exited' as const, code: 0 };
          },
          stop,
        })),
      },
      projection: {
        publishControlState: vi.fn(),
        publishProviderSessionId: vi.fn(),
        publishSubagentStarted: vi.fn(),
        publishSubagentCompleted: vi.fn(),
      },
    };
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime: createNativeRuntime(() => ({ argv: ['--terminal'] })),
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(['terminalRuntime']),
      diagnostics: [],
    });

    const result = surfaces.terminalRuntime!.launch!({
      sessionId: 'session-1',
      metadata: {},
      modelSelection: null,
      runWithCurrentPublisherPermit: allowCurrentPublisherEffect,
      directory: '/repo',
      host,
    });
    await vi.waitFor(() => expect(switchHandler).toBeTypeOf('function'));
    const accepted = await switchHandler?.({ target: 'remote' });
    if (!accepted) finishProcess();

    expect(accepted).toBe(true);
    await expect(result).resolves.toEqual({
      type: 'control_returned',
      reason: 'switch_requested',
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('never releases terminal transcript follow bindings the admission barrier owns', async () => {
    let finishProcess!: () => void;
    const processFinished = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
    let inputHandler: (() => void | Promise<void>) | undefined;
    const releaseFailure = new Error('terminal follow close failed');
    const releaseActiveBindings = vi.fn(async () => {
      throw releaseFailure;
    });
    const publishControlState = vi.fn();
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime: createNativeRuntime(() => ({
        argv: ['--terminal'],
        presentation: {
          onExit: { target: 'remote' as const, reason: 'terminal_finished' },
        },
      })),
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(['terminalRuntime']),
      diagnostics: [],
    });

    const result = surfaces.terminalRuntime!.launch!({
      sessionId: 'session-1',
      metadata: {},
      modelSelection: null,
      runWithCurrentPublisherPermit: allowCurrentPublisherEffect,
      directory: '/repo',
      host: {
        input: {
          subscribe: vi.fn((handler: typeof inputHandler) => {
            inputHandler = handler;
            return { unsubscribe: vi.fn() };
          }),
        },
        switching: { register: vi.fn(() => ({ unsubscribe: vi.fn() })) },
        process: {
          resolveAgentCliExecutable: vi.fn(async () => ({
            executable: {
              path: '/opt/happier/agent',
              hostGrant: { kind: 'agent-cli' as const, grantId: 'grant-1' },
            },
            args: [],
            source: 'managed',
            resolvedPath: '/opt/happier/agent',
          })),
          launch: vi.fn(async () => ({
            pid: 123,
            waitForTermination: async () => {
              await processFinished;
              return { type: 'exited' as const, code: 0 };
            },
            stop: vi.fn(async () => finishProcess()),
          })),
        },
        projection: {
          publishControlState,
          publishProviderSessionId: vi.fn(),
          publishSubagentStarted: vi.fn(),
          publishSubagentCompleted: vi.fn(),
        },
        transcriptFollow: {
          bindProviderSession: vi.fn(),
          releaseActiveBindings,
        },
      },
    });
    await vi.waitFor(() => expect(inputHandler).toBeTypeOf('function'));
    await inputHandler?.();

    // ES-PEP-EU2: exactly one owner releases the binding, and it is the barrier
    // that admitted it. This surface must not touch it at all, so a release
    // that would fail here is never invoked and cannot fail the launch.
    // (Previously this asserted `rejects.toBe(releaseFailure)` and
    // `releaseActiveBindings` being called once.)
    await expect(result).resolves.toEqual({
      type: 'control_returned',
      reason: 'pending_input',
    });
    expect(releaseActiveBindings).not.toHaveBeenCalled();
    expect(releaseFailure).toBeInstanceOf(Error);
    expect(publishControlState).toHaveBeenCalledWith({
      target: 'remote',
      reason: 'terminal_finished',
    });
  });

  it('rejects a retired generation before asking its native leaf for a launch plan', async () => {
    const resolveLaunch = vi.fn(async () => ({ argv: [] }));
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime: createNativeRuntime(resolveLaunch),
      agentId: 'acme.runtime.provider',
      isCurrent: () => false,
      declaredAgentSurfaceFamilies: new Set(['terminalRuntime']),
      diagnostics: [],
    });

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'session-1',
      metadata: {},
      modelSelection: null,
      runWithCurrentPublisherPermit: allowCurrentPublisherEffect,
      directory: '/repo',
    })).rejects.toThrow(/retired runtime generation/i);
    expect(resolveLaunch).not.toHaveBeenCalled();
  });

  it('refuses to spawn after async launch preparation when publisher authority is no longer current', async () => {
    let releaseExecutableResolution: () => void = () => {
      throw new Error('executable resolution was not waiting');
    };
    const executableResolution = new Promise<void>((resolve) => {
      releaseExecutableResolution = resolve;
    });
    let publisherCurrent = true;
    const processLaunch = vi.fn(async () => ({
      pid: 123,
      waitForTermination: async () => ({
        type: 'exited' as const,
        code: 0,
      }),
      stop: vi.fn(async () => undefined),
    }));
    const resolveAgentCliExecutable = vi.fn(async () => {
      await executableResolution;
      return {
        executable: {
          path: '/opt/happier/agent',
          hostGrant: {
            kind: 'agent-cli' as const,
            grantId: 'grant-1',
          },
        },
        args: [],
        source: 'managed' as const,
        resolvedPath: '/opt/happier/agent',
      };
    });
    const runWithCurrentPublisherPermit = vi.fn(async <T>(
      localEffect: () => Promise<T>,
    ) => {
      if (!publisherCurrent) return { status: 'blocked' as const };
      return {
        status: 'completed' as const,
        value: await localEffect(),
      };
    });
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime: createNativeRuntime(() => ({ argv: ['--terminal'] })),
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(['terminalRuntime']),
      diagnostics: [],
    });
    const launch = surfaces.terminalRuntime!.launch!({
      sessionId: 'session-1',
      metadata: {},
      modelSelection: null,
      directory: '/repo',
      runWithCurrentPublisherPermit,
      host: {
        input: { subscribe: vi.fn() },
        switching: { register: vi.fn() },
        process: {
          resolveAgentCliExecutable,
          launch: processLaunch,
        },
        projection: {
          publishControlState: vi.fn(),
          publishProviderSessionId: vi.fn(),
          publishSubagentStarted: vi.fn(),
          publishSubagentCompleted: vi.fn(),
        },
      },
    });

    await vi.waitFor(() => {
      expect(resolveAgentCliExecutable).toHaveBeenCalledOnce();
    });
    publisherCurrent = false;
    releaseExecutableResolution();

    await expect(launch).rejects.toBeInstanceOf(
      HostTerminalModelSelectionBlockedError,
    );
    expect(runWithCurrentPublisherPermit).toHaveBeenCalledOnce();
    expect(processLaunch).not.toHaveBeenCalled();
  });

  it('coalesces concurrent launches for one session into one serving process owner', async () => {
    let finishProcess!: () => void;
    const processFinished = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
    const resolveLaunch = vi.fn(async () => ({ argv: ['--terminal'] }));
    const processLaunch = vi.fn(async () => ({
      pid: 123,
      waitForTermination: async () => {
        await processFinished;
        return { type: 'exited' as const, code: 0 };
      },
      stop: vi.fn(async () => undefined),
    }));
    const host = {
      input: { subscribe: vi.fn() },
      switching: { register: vi.fn() },
      process: {
        resolveAgentCliExecutable: vi.fn(async () => ({
          executable: {
            path: '/opt/happier/agent',
            hostGrant: { kind: 'agent-cli' as const, grantId: 'grant-1' },
          },
          args: [],
          source: 'managed',
          resolvedPath: '/opt/happier/agent',
        })),
        launch: processLaunch,
      },
      projection: {
        publishControlState: vi.fn(),
        publishProviderSessionId: vi.fn(),
        publishSubagentStarted: vi.fn(),
        publishSubagentCompleted: vi.fn(),
      },
    };
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime: createNativeRuntime(resolveLaunch),
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(['terminalRuntime']),
      diagnostics: [],
    });
    const launchRequest = {
      sessionId: 'session-1',
      metadata: {},
      modelSelection: null,
      runWithCurrentPublisherPermit: allowCurrentPublisherEffect,
      directory: '/repo',
      host,
    };

    const first = surfaces.terminalRuntime!.launch!(launchRequest);
    const duplicate = surfaces.terminalRuntime!.launch!(launchRequest);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    finishProcess();

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { type: 'process_exited', exitCode: 0 },
      { type: 'process_exited', exitCode: 0 },
    ]);
    expect(resolveLaunch).toHaveBeenCalledOnce();
    expect(processLaunch).toHaveBeenCalledOnce();
  });

  it('rejects a post-reload duplicate instead of joining the retired generation launch', async () => {
    let current = true;
    let finishProcess!: () => void;
    const processFinished = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
    const resolveLaunch = vi.fn(async () => ({ argv: ['--terminal'] }));
    const processLaunch = vi.fn(async () => ({
      pid: 123,
      waitForTermination: async () => {
        await processFinished;
        return { type: 'exited' as const, code: 0 };
      },
      stop: vi.fn(async () => undefined),
    }));
    const host = {
      input: { subscribe: vi.fn() },
      switching: { register: vi.fn() },
      process: {
        resolveAgentCliExecutable: vi.fn(async () => ({
          executable: {
            path: '/opt/happier/agent',
            hostGrant: { kind: 'agent-cli' as const, grantId: 'grant-1' },
          },
          args: [],
          source: 'managed',
          resolvedPath: '/opt/happier/agent',
        })),
        launch: processLaunch,
      },
      projection: {
        publishControlState: vi.fn(),
        publishProviderSessionId: vi.fn(),
        publishSubagentStarted: vi.fn(),
        publishSubagentCompleted: vi.fn(),
      },
    };
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime: createNativeRuntime(resolveLaunch),
      agentId: 'acme.runtime.provider',
      isCurrent: () => current,
      declaredAgentSurfaceFamilies: new Set(['terminalRuntime']),
      diagnostics: [],
    });
    const launchRequest = {
      sessionId: 'session-1',
      metadata: {},
      modelSelection: null,
      runWithCurrentPublisherPermit: allowCurrentPublisherEffect,
      directory: '/repo',
      host,
    };

    const activeLaunch = surfaces.terminalRuntime!.launch!(launchRequest);
    await vi.waitFor(() => expect(processLaunch).toHaveBeenCalledOnce());
    current = false;

    const duplicateOutcome = surfaces.terminalRuntime!.launch!(launchRequest).then(
      () => 'resolved' as const,
      (error: unknown) => error instanceof Error && /retired runtime generation/i.test(error.message)
        ? 'retired' as const
        : 'unexpected-error' as const,
    );
    const outcomeBeforeProcessExit = await Promise.race([
      duplicateOutcome,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ]);
    finishProcess();
    await expect(activeLaunch).rejects.toThrow(/retired runtime generation/i);
    await duplicateOutcome;
    expect(outcomeBeforeProcessExit).toBe('retired');
    expect(resolveLaunch).toHaveBeenCalledOnce();
    expect(processLaunch).toHaveBeenCalledOnce();
  });

  it('restores the leaf-declared exit presentation when host process launch fails', async () => {
    const resolveLaunch = vi.fn(async () => ({
      argv: [],
      presentation: {
        onLaunch: { target: 'local' as const },
        onExit: { target: 'remote' as const },
      },
    }));
    const publishControlState = vi.fn<(
      projection: Readonly<{ target: 'local' | 'remote'; reason?: string }>,
    ) => Promise<void>>(async () => undefined);
    const surfaces = resolveBackendExecutionSurfacesFromNativeAgentRuntime({
      backend: createBackend(),
      runtime: createNativeRuntime(resolveLaunch),
      agentId: 'acme.runtime.provider',
      isCurrent: () => true,
      declaredAgentSurfaceFamilies: new Set(['terminalRuntime']),
      diagnostics: [],
    });

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'session-1',
      metadata: {},
      modelSelection: null,
      runWithCurrentPublisherPermit: allowCurrentPublisherEffect,
      directory: '/repo',
      host: {
        input: { subscribe: vi.fn() },
        switching: { register: vi.fn() },
        process: {
          resolveAgentCliExecutable: vi.fn(async () => ({
            executable: {
              path: '/opt/happier/agent',
              hostGrant: { kind: 'agent-cli' as const, grantId: 'grant-1' },
            },
            args: [],
            source: 'managed',
            resolvedPath: '/opt/happier/agent',
          })),
          launch: vi.fn(async () => { throw new Error('spawn failed'); }),
        },
        projection: {
          publishControlState,
          publishProviderSessionId: vi.fn(),
          publishSubagentStarted: vi.fn(),
          publishSubagentCompleted: vi.fn(),
        },
      },
    })).rejects.toThrow('spawn failed');
    expect(publishControlState.mock.calls.map(([projection]) => projection)).toEqual([
      { target: 'local' },
      { target: 'remote' },
    ]);
  });
});
