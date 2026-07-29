import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@happier-dev/plugin-sdk/agent-runtime';

import {
  createEmptyBackendExecutionSurfaces,
  type BackendExecutionSurfaces,
} from './engineRegistryTypes';
import type { ResolvedAgentRuntimeContribution } from '../../../plugins/projection/registry/types';
import {
  mergeBackendExecutionSurfaces,
  resolveBackendExecutionSurfacesFromNativeAgentRuntime,
} from './backendEngineSurfaceBindings';

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
    manifestDigest: 'digest-1',
    daemonEntryPath: '/plugins/acme.runtime/daemon.mjs',
  };
}

describe('mergeBackendExecutionSurfaces', () => {
  it('fails closed when handler and engine surfaces both implement the same operation', () => {
    const handlerLaunch = vi.fn();
    const engineLaunch = vi.fn();

    const handlerSurfaces: BackendExecutionSurfaces = {
      ...createEmptyBackendExecutionSurfaces(),
      terminalRuntime: {
        launch: handlerLaunch,
      } as NonNullable<BackendExecutionSurfaces['terminalRuntime']>,
    };
    const engineSurfaces: BackendExecutionSurfaces = {
      ...createEmptyBackendExecutionSurfaces(),
      terminalRuntime: {
        launch: engineLaunch,
      } as NonNullable<BackendExecutionSurfaces['terminalRuntime']>,
    };

    expect(() => mergeBackendExecutionSurfaces(handlerSurfaces, engineSurfaces)).toThrow(/duplicate.*terminalRuntime\.launch/i);
  });
});

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
    } as const;

    await expect(surfaces.terminalRuntime?.launch?.({
      sessionId: 'session-1',
      metadata: terminalLaunchMetadata,
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
      metadata: {
        model: 'fast',
        externalSessionOperationPresentationV1: {
          v: 1,
          operationId: 'operation-private',
          revision: 3,
          kind: 'materialize',
          status: 'running',
          phase: 'publishing',
        },
      },
    });
    expect(terminalLaunchMetadata).toEqual({
      model: 'fast',
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
    expect(releaseActiveBindings).toHaveBeenCalledOnce();
  });

  it('returns terminal control to the structured session when the existing host input owner fires', async () => {
    let finishProcess!: () => void;
    const processFinished = new Promise<void>((resolve) => {
      finishProcess = resolve;
    });
    let finishStop!: () => void;
    const stopFinished = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    let inputHandler: ((trigger: { sequence: number }) => void | Promise<void>) | undefined;
    const unsubscribeInput = vi.fn();
    const unsubscribeSwitch = vi.fn();
    const stop = vi.fn(async () => {
      finishProcess();
      await stopFinished;
    });
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
      directory: '/repo',
      host,
    });
    await vi.waitFor(() => expect(host.process.launch).toHaveBeenCalledOnce());
    if (!inputHandler) {
      finishProcess();
      await result;
    }
    expect(inputHandler).toBeTypeOf('function');
    const inputReturn = Promise.resolve(inputHandler?.({ sequence: 1 }));
    const outcomeBeforeStopCompletion = await Promise.race([
      result.then((outcome) => ({ settled: true as const, outcome })),
      new Promise<{ settled: false }>((resolve) => {
        setTimeout(() => resolve({ settled: false }), 0);
      }),
    ]);
    finishStop();
    await inputReturn;
    const outcome = outcomeBeforeStopCompletion.settled
      ? outcomeBeforeStopCompletion.outcome
      : await result;

    expect(outcome).toEqual({
      type: 'control_returned',
      reason: 'pending_input',
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(unsubscribeInput).toHaveBeenCalledOnce();
    expect(unsubscribeSwitch).toHaveBeenCalledOnce();
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
      directory: '/repo',
    })).rejects.toThrow(/retired runtime generation/i);
    expect(resolveLaunch).not.toHaveBeenCalled();
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
