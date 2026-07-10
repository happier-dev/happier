import { describe, expect, it, vi } from 'vitest';
import type {
  SessionScopedServicesV1,
  TerminalRuntimeHostOrchestrationV1,
} from '@happier-dev/plugin-sdk';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/plugin-sdk/sessions';

import { createCodexTerminalRuntimeSurface } from './launch.js';

function createSessionServicesFixture() {
  return {
    sessionId: 'session-1',
    send: vi.fn(async () => ({ ok: true as const })),
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    writeMetadata: vi.fn(async () => undefined),
    writeAgentState: vi.fn(async () => undefined),
    writeStateField: vi.fn(async () => undefined),
    mcp: { elicit: vi.fn() },
    auth: { services: { refreshRuntimeAuth: vi.fn() } },
    permissions: {
      requestDecision: vi.fn(),
      getMode: vi.fn(() => 'default'),
    },
    subagents: {
      list: vi.fn(),
      get: vi.fn(),
      watch: vi.fn(),
      upsert: vi.fn(),
      updateStatus: vi.fn(),
      complete: vi.fn(),
    },
    external: {
      listCandidates: vi.fn(),
      attach: vi.fn(),
      takeover: vi.fn(),
      pageTranscript: vi.fn(),
      readAfterTranscript: vi.fn(),
      followTranscript: vi.fn(),
    },
  } as unknown as SessionScopedServicesV1 & Readonly<{
    send: ReturnType<typeof vi.fn>;
    permissions: { getMode: ReturnType<typeof vi.fn> };
  }>;
}

function createHostFixture() {
  let resolveTermination!: (value: { type: 'exited'; code: number }) => void;
  const termination = new Promise<{ type: 'exited'; code: number }>((resolve) => {
    resolveTermination = resolve;
  });
  const host: TerminalRuntimeHostOrchestrationV1 = {
    input: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
    switching: { register: vi.fn(() => ({ unsubscribe: vi.fn() })) },
    process: {
      resolveAgentCliExecutable: vi.fn(async () => ({
        executable: {
          path: '/managed/runtime/node',
          hostGrant: { kind: 'agent-cli' as const, grantId: 'agent-cli:codex' },
        },
        args: ['/managed/codex/bin/codex.js'],
        source: 'managed',
        resolvedPath: '/managed/codex/bin/codex.js',
      })),
      launch: vi.fn(async () => ({
        pid: 123,
        waitForTermination: async () => await termination,
        stop: vi.fn(async () => undefined),
      })),
    },
    transcripts: {
      openDirectMirror: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
    },
    projection: {
      openDirectTranscriptMirror: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
      publishControlState: vi.fn(async () => undefined),
      publishProviderSessionId: vi.fn(async () => true),
      publishSubagentStarted: vi.fn(async () => undefined),
      publishSubagentCompleted: vi.fn(async () => undefined),
    },
  };
  return { host, resolveTermination };
}

describe('createCodexTerminalRuntimeSurface', () => {
  it('opens the Codex direct transcript mirror through host projection services', async () => {
    const services = createSessionServicesFixture();
    const { host, resolveTermination } = createHostFixture();
    const surface = createCodexTerminalRuntimeSurface({
      baseProcessEnv: {
        CODEX_HOME: '/tmp/codex-home',
      },
      deps: {
        now: () => Date.parse('2026-06-10T10:00:00Z'),
        homeDir: () => '/tmp/home',
        createDirectory: vi.fn(),
        discoverRolloutFileOnce: vi.fn(async () => ({
          filePath: '/tmp/codex-home/sessions/rollout-2026-06-10T10-00-01-codex-session-1.jsonl',
          sessionMeta: {
            id: 'codex-session-1',
            timestamp: '2026-06-10T10:00:01Z',
            cwd: '/repo',
          },
        })),
      },
    });

    const launch = surface.launch?.({
      sessionId: 'session-1',
      directory: '/repo',
      metadata: {
        activeServerDir: '/repo',
        rolloutDiscovery: {
          initialTimeoutMs: 1,
          initialPollIntervalMs: 1,
          extendedPollIntervalMs: 1,
        },
      },
      services,
      host,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(host.projection.openDirectTranscriptMirror).toHaveBeenCalledTimes(1);
    });
    const mirrorRequest = vi.mocked(host.projection.openDirectTranscriptMirror).mock.calls[0]?.[0];
    expect(mirrorRequest).toEqual(expect.objectContaining({
      binding: expect.objectContaining({
        agentId: 'codex',
        remoteSessionId: 'codex-session-1',
      }),
    }));

    await mirrorRequest?.onItems([{
      id: 'item-1',
      createdAtMs: 1_771_234_567_000,
      raw: {
        role: 'user',
        content: {
          type: 'text',
          text: 'hello from terminal',
        },
      },
    }]);
    resolveTermination({ type: 'exited', code: 0 });

    await expect(launch).resolves.toEqual({ type: 'process_exited', exitCode: 0 });
    expect(host.projection.publishProviderSessionId).toHaveBeenCalledWith({
      providerSessionId: 'codex-session-1',
      metadataKey: 'codexSessionId',
    });
    expect(services.send).toHaveBeenCalledWith({
      kind: 'userText',
      text: 'hello from terminal',
      opts: {
        localId: 'item-1',
        meta: {
          importedFrom: 'codex-terminal-direct-transcript',
          providerTranscriptItemId: 'item-1',
        },
      },
    });
  });

  it('uses provider item ids as stable user local ids across recreated mirrors', async () => {
    const services = createSessionServicesFixture();
    const surface = createCodexTerminalRuntimeSurface({
      baseProcessEnv: {
        CODEX_HOME: '/tmp/codex-home',
      },
      deps: {
        now: () => Date.parse('2026-06-10T10:00:00Z'),
        homeDir: () => '/tmp/home',
        createDirectory: vi.fn(),
        discoverRolloutFileOnce: vi.fn(async () => ({
          filePath: '/tmp/codex-home/sessions/rollout-2026-06-10T10-00-01-codex-session-1.jsonl',
          sessionMeta: {
            id: 'codex-session-1',
            timestamp: '2026-06-10T10:00:01Z',
            cwd: '/repo',
          },
        })),
      },
    });
    const item = {
      id: 'item-replayed-user',
      createdAtMs: 1_771_234_567_000,
      raw: {
        role: 'user',
        content: {
          type: 'text',
          text: 'hello after mirror replay',
        },
      },
    };

    const runMirror = async (): Promise<void> => {
      const { host, resolveTermination } = createHostFixture();
      const launch = surface.launch?.({
        sessionId: 'session-1',
        directory: '/repo',
        metadata: {
          activeServerDir: '/repo',
          rolloutDiscovery: {
            initialTimeoutMs: 1,
            initialPollIntervalMs: 1,
            extendedPollIntervalMs: 1,
          },
        },
        services,
        host,
        signal: new AbortController().signal,
      });
      await vi.waitFor(() => {
        expect(host.projection.openDirectTranscriptMirror).toHaveBeenCalledTimes(1);
      });
      const mirrorRequest = vi.mocked(host.projection.openDirectTranscriptMirror).mock.calls[0]?.[0];
      await mirrorRequest?.onItems([item]);
      resolveTermination({ type: 'exited', code: 0 });
      await expect(launch).resolves.toEqual({ type: 'process_exited', exitCode: 0 });
    };

    await runMirror();
    await runMirror();

    const userTextRequests = vi.mocked(services.send).mock.calls
      .map(([request]) => request)
      .filter((request): request is { kind: 'userText'; text: string; opts: { localId: string; meta: Record<string, unknown> } } =>
        typeof request === 'object'
        && request !== null
        && 'kind' in request
        && request.kind === 'userText',
      );
    expect(userTextRequests).toEqual([
      {
        kind: 'userText',
        text: 'hello after mirror replay',
        opts: {
          localId: 'item-replayed-user',
          meta: {
            importedFrom: 'codex-terminal-direct-transcript',
            providerTranscriptItemId: 'item-replayed-user',
          },
        },
      },
      {
        kind: 'userText',
        text: 'hello after mirror replay',
        opts: {
          localId: 'item-replayed-user',
          meta: {
            importedFrom: 'codex-terminal-direct-transcript',
            providerTranscriptItemId: 'item-replayed-user',
          },
        },
      },
    ]);
  });

  it('uses provider item ids as stable tool local ids across recreated mirrors', async () => {
    const services = createSessionServicesFixture();
    const surface = createCodexTerminalRuntimeSurface({
      baseProcessEnv: {
        CODEX_HOME: '/tmp/codex-home',
      },
      deps: {
        now: () => Date.parse('2026-06-10T10:00:00Z'),
        homeDir: () => '/tmp/home',
        createDirectory: vi.fn(),
        discoverRolloutFileOnce: vi.fn(async () => ({
          filePath: '/tmp/codex-home/sessions/rollout-2026-06-10T10-00-01-codex-session-1.jsonl',
          sessionMeta: {
            id: 'codex-session-1',
            timestamp: '2026-06-10T10:00:01Z',
            cwd: '/repo',
          },
        })),
      },
    });
    const toolRows = [
      {
        id: 'item-tool-call',
        createdAtMs: 1_771_234_567_000,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call',
              callId: 'call-1',
              name: 'exec_command',
              input: { cmd: 'echo ok' },
            },
          },
        },
      },
      {
        id: 'item-tool-result',
        createdAtMs: 1_771_234_567_001,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'tool-call-result',
              callId: 'call-1',
              output: { ok: true },
            },
          },
        },
      },
    ];

    const runMirror = async (): Promise<void> => {
      const { host, resolveTermination } = createHostFixture();
      const launch = surface.launch?.({
        sessionId: 'session-1',
        directory: '/repo',
        metadata: {
          activeServerDir: '/repo',
          rolloutDiscovery: {
            initialTimeoutMs: 1,
            initialPollIntervalMs: 1,
            extendedPollIntervalMs: 1,
          },
        },
        services,
        host,
        signal: new AbortController().signal,
      });
      await vi.waitFor(() => {
        expect(host.projection.openDirectTranscriptMirror).toHaveBeenCalledTimes(1);
      });
      const mirrorRequest = vi.mocked(host.projection.openDirectTranscriptMirror).mock.calls[0]?.[0];
      await mirrorRequest?.onItems(toolRows);
      resolveTermination({ type: 'exited', code: 0 });
      await expect(launch).resolves.toEqual({ type: 'process_exited', exitCode: 0 });
    };

    await runMirror();
    await runMirror();

    const providerDispatchRequests = vi.mocked(services.send).mock.calls
      .map(([request]) => request)
      .filter((request): request is { kind: 'providerDispatch'; body: { type: string; id: string } } =>
        typeof request === 'object'
        && request !== null
        && 'kind' in request
        && request.kind === 'providerDispatch',
      );
    expect(providerDispatchRequests).toEqual([
      {
        kind: 'providerDispatch',
        body: expect.objectContaining({
          type: 'tool-call',
          id: 'item-tool-call',
        }),
      },
      {
        kind: 'providerDispatch',
        body: expect.objectContaining({
          type: 'tool-call-result',
          id: 'item-tool-result',
        }),
      },
      {
        kind: 'providerDispatch',
        body: expect.objectContaining({
          type: 'tool-call',
          id: 'item-tool-call',
        }),
      },
      {
        kind: 'providerDispatch',
        body: expect.objectContaining({
          type: 'tool-call-result',
          id: 'item-tool-result',
        }),
      },
    ]);
  });

  it('skips id-less provider transcript rows instead of synthesizing local ids', async () => {
    const services = createSessionServicesFixture();
    const { host, resolveTermination } = createHostFixture();
    const surface = createCodexTerminalRuntimeSurface({
      baseProcessEnv: {
        CODEX_HOME: '/tmp/codex-home',
      },
      deps: {
        now: () => Date.parse('2026-06-10T10:00:00Z'),
        homeDir: () => '/tmp/home',
        createDirectory: vi.fn(),
        discoverRolloutFileOnce: vi.fn(async () => ({
          filePath: '/tmp/codex-home/sessions/rollout-2026-06-10T10-00-01-codex-session-1.jsonl',
          sessionMeta: {
            id: 'codex-session-1',
            timestamp: '2026-06-10T10:00:01Z',
            cwd: '/repo',
          },
        })),
      },
    });

    const launch = surface.launch?.({
      sessionId: 'session-1',
      directory: '/repo',
      metadata: {
        activeServerDir: '/repo',
        rolloutDiscovery: {
          initialTimeoutMs: 1,
          initialPollIntervalMs: 1,
          extendedPollIntervalMs: 1,
        },
      },
      services,
      host,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(host.projection.openDirectTranscriptMirror).toHaveBeenCalledTimes(1);
    });
    const mirrorRequest = vi.mocked(host.projection.openDirectTranscriptMirror).mock.calls[0]?.[0];
    const idlessRows = [
      {
        createdAtMs: 1_771_234_567_000,
        raw: {
          role: 'user',
          content: {
            type: 'text',
            text: 'malformed user row',
          },
        },
      },
      {
        createdAtMs: 1_771_234_567_001,
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'message',
              message: 'malformed assistant row',
            },
          },
        },
      },
    ];

    // Deliberately malformed boundary fixture: protocol-valid external rows require ids.
    await mirrorRequest?.onItems(idlessRows as unknown as ExternalSessionTranscriptRawMessageV1[]);
    resolveTermination({ type: 'exited', code: 0 });

    await expect(launch).resolves.toEqual({ type: 'process_exited', exitCode: 0 });
    const sends = vi.mocked(services.send).mock.calls.map(([request]) => request);
    expect(sends.filter((request) =>
      request.kind === 'userText' || request.kind === 'agentMessageCommitted',
    )).toEqual([]);
    expect(sends.filter((request) =>
      request.kind === 'sessionEvent'
      && 'event' in request
      && typeof request.event === 'object'
      && request.event !== null
      && 'kind' in request.event
      && request.event.kind === 'codex-terminal-direct-transcript-item-skipped',
    )).toEqual([
      {
        kind: 'sessionEvent',
        event: {
          kind: 'codex-terminal-direct-transcript-item-skipped',
          reason: 'missing_provider_transcript_item_id',
          agentId: 'codex',
        },
        id: 'codex-terminal-direct-transcript:item-skipped:missing-id',
      },
    ]);
  });

  it('uses the default Codex home for direct transcript binding when CODEX_HOME is absent', async () => {
    const services = createSessionServicesFixture();
    const { host, resolveTermination } = createHostFixture();
    const surface = createCodexTerminalRuntimeSurface({
      baseProcessEnv: {},
      deps: {
        now: () => Date.parse('2026-06-10T10:00:00Z'),
        homeDir: () => '/tmp/home',
        createDirectory: vi.fn(),
        discoverRolloutFileOnce: vi.fn(async () => ({
          filePath: '/tmp/home/.codex/sessions/rollout-2026-06-10T10-00-01-codex-session-1.jsonl',
          sessionMeta: {
            id: 'codex-session-1',
            timestamp: '2026-06-10T10:00:01Z',
            cwd: '/repo',
          },
        })),
      },
    });

    const launch = surface.launch?.({
      sessionId: 'session-1',
      directory: '/repo',
      metadata: {
        activeServerDir: '/repo',
        rolloutDiscovery: {
          initialTimeoutMs: 1,
          initialPollIntervalMs: 1,
          extendedPollIntervalMs: 1,
        },
      },
      services,
      host,
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      expect(host.projection.openDirectTranscriptMirror).toHaveBeenCalledTimes(1);
    });
    resolveTermination({ type: 'exited', code: 0 });

    await expect(launch).resolves.toEqual({ type: 'process_exited', exitCode: 0 });
  });
});
