import { describe, expect, it, vi } from 'vitest';
import type {
  SessionScopedServicesV1,
  TerminalRuntimeHostOrchestrationV1,
} from '@happier-dev/agents';

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
        providerId: 'codex',
        remoteSessionId: 'codex-session-1',
      }),
    }));

    await mirrorRequest?.onItems([{
      id: 'item-1',
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
    });
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
