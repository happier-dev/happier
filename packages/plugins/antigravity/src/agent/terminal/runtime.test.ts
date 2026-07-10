import { describe, expect, it, vi } from 'vitest';
import type { TerminalRuntimeHostOrchestrationV1 } from '@happier-dev/plugin-sdk';

import {
  createAntigravityTerminalRuntimeSurface,
  resolveAntigravityTerminalRuntimeLaunch,
} from './runtime.js';

describe('Antigravity terminal runtime launch', () => {
  it('returns a host terminal launch request instead of spawning agy directly', () => {
    expect(resolveAntigravityTerminalRuntimeLaunch({
      cwd: '/repo',
      promptInteractive: true,
      sandbox: true,
      modelId: 'Gemini 3.1 Pro (High)',
    })).toEqual({
      kind: 'host-terminal-runtime.launch',
      agentId: 'antigravity',
      backendId: 'antigravity',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'antigravity',
        agent: {
          backendId: 'antigravity',
          runtimeCore: 'localharness',
          runtimeSurface: 'terminalRuntime',
          backendMode: 'terminal',
        },
      },
      cwd: '/repo',
      command: {
        kind: 'agent-cli',
        agentId: 'antigravity',
        binaryName: 'agy',
        args: ['--prompt-interactive', '--sandbox', '--model', 'Gemini 3.1 Pro (High)'],
      },
      transcript: { source: 'terminal_mirror' },
      structuredRuntime: {
        transcript: false,
        toolCalls: false,
        permissions: false,
      },
      providerNativeStatusLine: {
        supported: false,
        reason: 'No source-real, non-mutating AGY status-line integration is available in terminal v1.',
      },
    });
  });

  it('launches agy through the host with the canonical model override as --model', async () => {
    const waitForTermination = vi.fn(async () => ({ type: 'exited' as const, code: 0 }));
    const launch = vi.fn(async () => ({
      pid: 123,
      waitForTermination,
      stop: vi.fn(async () => undefined),
    }));
    const host: TerminalRuntimeHostOrchestrationV1 = {
      input: { subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) },
      switching: { register: vi.fn(() => ({ unsubscribe: vi.fn() })) },
      process: {
        resolveAgentCliExecutable: vi.fn(async () => ({
          executable: {
            path: '/managed/runtime/node',
            hostGrant: { kind: 'agent-cli', grantId: 'agent-cli:antigravity' },
          },
          args: ['/managed/agy/bin/agy.js'],
          source: 'managed',
          resolvedPath: '/managed/agy/bin/agy.js',
        })),
        launch,
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

    await expect(createAntigravityTerminalRuntimeSurface().launch?.({
      sessionId: 'session-1',
      directory: '/repo',
      metadata: {
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 100,
          selection: {
            agentTargetKey: 'backend:antigravity',
            providerConnectionId: 'pc_work',
            modelId: 'Claude Sonnet 4.6 (Thinking)',
          },
        },
      },
      host,
      signal: new AbortController().signal,
    })).resolves.toEqual({ type: 'process_exited', exitCode: 0 });

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        '/managed/agy/bin/agy.js',
        '--model',
        'Claude Sonnet 4.6 (Thinking)',
      ],
    }));
  });
});
