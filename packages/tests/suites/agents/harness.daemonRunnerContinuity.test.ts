import { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  runDaemonRunnerContinuityAToBToC,
  type RunnerDaemonServiceAuthority,
} from '../../src/testkit/providers/harness/daemonRunnerContinuity';
import type { StartedDaemon } from '../../src/testkit/daemon/daemon';
import { writeTestManifest } from '../../src/testkit/manifest';

function retainedAgentBinding() {
  return {
    v: 1,
    pluginId: 'plugin.test',
    pluginVersion: '1.0.0',
    agentId: 'agent.test',
    localAgentId: 'agent.test',
    immutableGenerationId: 'generation-1',
    locator: {
      module: './agent/runtime/factory',
      export: 'createAgentSessionRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: '/private/immutable/agent/runtime/factory.js',
    loadMode: 'immutable-js' as const,
  } as const;
}

function authority(params: {
  daemonPort: number;
  capability: string;
}): RunnerDaemonServiceAuthority {
  return {
    path: '/tmp/runner-authority.json',
    sessionId: 'session-123',
    runner: {
      pid: 700,
      processStartTimeMs: 123,
      processCommandHash: 'a'.repeat(64),
      snapshotIdentity: 'path:/private/source/apps/cli/src/index.ts',
    },
    pluginHardRevocationRevision: 0,
    retainedAgent: retainedAgentBinding(),
    httpPort: params.daemonPort,
    capability: params.capability,
  };
}

describe('providers harness: daemon runner continuity orchestration', () => {
  it('exports the shared A-to-B-to-C continuity owner', async () => {
    const continuity = await import(
      '../../src/testkit/providers/harness/daemonRunnerContinuity'
    ).catch(() => null);

    expect(continuity).not.toBeNull();
    expect(continuity && typeof continuity.runDaemonRunnerContinuityAToBToC).toBe('function');
  });

  it('rotates daemon authority while preserving one live runner and one matching transcript output per later phase', async () => {
    const daemonA = { pid: 101, httpPort: 4101, controlToken: 'control-a' };
    const daemonB = { pid: 102, httpPort: 4102, controlToken: 'control-b' };
    const daemonC = { pid: 103, httpPort: 4103, controlToken: 'control-c' };
    const authorities = new Map([
      [daemonA.pid, authority({ daemonPort: daemonA.httpPort, capability: 'A'.repeat(43) })],
      [daemonB.pid, authority({ daemonPort: daemonB.httpPort, capability: 'B'.repeat(43) })],
      [daemonC.pid, authority({ daemonPort: daemonC.httpPort, capability: 'C'.repeat(43) })],
    ]);
    const outputs = new Map<string, number>();
    const effects = new Map<string, number>();
    const sequence: string[] = [];
    let completedTurnId = 'turn-a';

    const result = await runDaemonRunnerContinuityAToBToC({
      daemonA: { state: daemonA } as StartedDaemon,
      testDir: '/tmp/test',
      happyHomeDir: '/tmp/home',
      daemonEnv: {},
      baseUrl: 'http://server.test',
      token: 'token',
      sessionId: 'session-123',
      secret: new Uint8Array(32),
      launchEntrypointKind: 'source',
      phases: [
        {
          id: 'b',
          prompt: 'prompt-b',
          requiredAssistantSubstring: 'output-b',
          effect: { path: '/tmp/effect-b', marker: 'effect-b' },
        },
        {
          id: 'c',
          prompt: 'prompt-c',
          requiredAssistantSubstring: 'output-c',
          effect: { path: '/tmp/effect-c', marker: 'effect-c' },
        },
      ],
      deps: {
        readTrackedRunnerPid: vi.fn(async () => 700),
        waitForAuthority: vi.fn(async ({ daemon }) => authorities.get(daemon.pid)!),
        probeAuthority: vi.fn(async (value) => (
          value.capability === 'A'.repeat(43) && value.httpPort !== daemonA.httpPort
            || value.capability === 'B'.repeat(43) && value.httpPort !== daemonB.httpPort
            ? { status: 403, ok: false, errorCode: 'agent_runtime_daemon_service_forbidden', resultKind: null, resultStatus: null }
            : { status: 200, ok: true, errorCode: null, resultKind: 'turn_contributions', resultStatus: 'resolved' }
        )),
        replaceDaemon: vi.fn(async ({ previousDaemon }) => {
          sequence.push(`replace-${previousDaemon.pid}`);
          const state = previousDaemon.pid === daemonA.pid ? daemonB : daemonC;
          return {
            happyHomeDir: '/tmp/home',
            state,
            proc: {
              child: new ChildProcess(),
              stdoutPath: '/tmp/daemon.stdout.log',
              stderrPath: '/tmp/daemon.stderr.log',
              stop: async () => {},
            },
            stop: async () => {},
          };
        }),
        isProcessAlive: vi.fn(() => true),
        enqueuePrompt: vi.fn(async ({ text }) => {
          sequence.push(`enqueue-${text}`);
        }),
        waitForActiveTurn: vi.fn(async () => {
          sequence.push('active-turn-b');
          return 'turn-b';
        }),
        waitForMatchingEffect: vi.fn(async ({ marker }) => {
          sequence.push(`effect-${marker}`);
          effects.set(marker, 1);
        }),
        waitForMatchingAssistantTranscriptOutput: vi.fn(async ({ requiredSubstring }) => {
          sequence.push(`output-${requiredSubstring}`);
          outputs.set(requiredSubstring, 1);
        }),
        countMatchingAssistantTranscriptOutputs: vi.fn(async ({ requiredSubstring }) => {
          sequence.push(`count-${requiredSubstring}`);
          return outputs.get(requiredSubstring) ?? 0;
        }),
        countMatchingEffects: vi.fn(async ({ marker }) => {
          sequence.push(`count-${marker}`);
          return effects.get(marker) ?? 0;
        }),
        countTerminalEvents: vi.fn(async ({ turnId }) => {
          sequence.push(`terminal-${turnId}`);
          return 1;
        }),
        observeUnderlyingAgentIdentity: vi.fn(async () => ({
          childProcessIdentity: null,
          vendorSessionId: 'private-vendor-session',
        })),
        waitForNextCompletedTurn: vi.fn(async ({ previousTurnId }) => {
          completedTurnId = previousTurnId === null
            ? 'turn-a'
            : previousTurnId === 'turn-a'
              ? 'turn-b'
              : 'turn-c';
          sequence.push(`completed-${completedTurnId}`);
          return completedTurnId;
        }),
      },
    });

    expect(result).toMatchObject({
      phaseCount: 3,
      runtime: {
        launchEntrypointKind: 'source',
        identityKind: 'mutable_runtime',
        distinctEntrypointIdentityCount: 1,
        stableAcrossAllPhases: true,
      },
      daemon: {
        distinctIdentityCount: 3,
        replacedAcrossAllPhases: true,
      },
      runner: {
        distinctIdentityCount: 1,
        distinctProcessCommandHashCount: 1,
        aliveAcrossAllPhases: true,
      },
      logicalSession: {
        distinctIdentityCount: 1,
        stableAcrossAllPhases: true,
      },
      executionAuthority: {
        distinctRetainedAgentBindingCount: 1,
        stableAcrossAllPhases: true,
      },
      underlyingAgent: {
        childProcess: {
          availability: 'unknown',
          distinctIdentityCount: null,
          stableAcrossAllPhases: null,
        },
        vendorSession: {
          availability: 'observed',
          distinctIdentityCount: 1,
          stableAcrossAllPhases: true,
        },
      },
      authority: {
        distinctCapabilityCount: 3,
        rotatedAcrossAllPhases: true,
        currentAcceptedAcrossAllPhases: true,
        predecessorRejectedAtBAndC: true,
      },
      turns: {
        distinctCompletedTurnCount: 3,
        matchingAssistantTranscriptOutputCounts: { b: 1, c: 1 },
        matchingEffectCounts: { b: 1, c: 1 },
        terminalEventCounts: { b: 1, c: 1 },
        activeTurnCrossedAToB: true,
        activeTurnCrossedBToC: true,
        exactlyOneMatchingAssistantTranscriptOutputPerLaterPhase: true,
        exactlyOneMatchingEffectPerLaterPhase: true,
        exactlyOneTerminalEventPerLaterPhase: true,
      },
    });
    for (const fingerprints of [
      result.daemon.identityFingerprints,
      result.runtime.entrypointIdentityFingerprints,
      result.runner.identityFingerprints,
      result.runner.processCommandHashFingerprints,
      result.logicalSession.identityFingerprints,
      result.executionAuthority.retainedAgentBindingFingerprints,
      result.underlyingAgent.vendorSession.identityFingerprints,
      result.authority.capabilityFingerprints,
      result.turns.completedTurnFingerprints,
    ]) {
      expect(Object.values(fingerprints)).toEqual([
        expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      ]);
    }

    const testDir = mkdtempSync(join(tmpdir(), 'happier-runner-continuity-manifest-'));
    const manifestPath = writeTestManifest(testDir, {
      startedAt: '2026-08-01T00:00:00.000Z',
      sessionIds: ['session-123'],
      results: {
        status: 'passed',
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-01T00:01:00.000Z',
        daemonRunnerContinuity: result,
      },
    });
    const writtenManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      sessionIds?: string[];
      results?: { daemonRunnerContinuity?: unknown };
    };
    const serializedContinuity = JSON.stringify(writtenManifest.results?.daemonRunnerContinuity);

    expect(writtenManifest.results?.daemonRunnerContinuity).toEqual(result);
    expect(writtenManifest.sessionIds).toEqual(['session-123']);
    expect(serializedContinuity).not.toContain('A'.repeat(43));
    expect(serializedContinuity).not.toContain('B'.repeat(43));
    expect(serializedContinuity).not.toContain('C'.repeat(43));
    expect(serializedContinuity).not.toContain('/tmp/runner-authority.json');
    expect(serializedContinuity).not.toContain('/tmp/home');
    expect(serializedContinuity).not.toContain('/tmp/test');
    expect(serializedContinuity).not.toContain('http://server.test');
    expect(serializedContinuity).not.toContain('control-a');
    expect(serializedContinuity).not.toContain('control-b');
    expect(serializedContinuity).not.toContain('control-c');
    expect(serializedContinuity).not.toContain('session-123');
    expect(serializedContinuity).not.toContain('plugin.test');
    expect(serializedContinuity).not.toContain('agent.test');
    expect(serializedContinuity).not.toContain('generation-1');
    expect(serializedContinuity).not.toContain('snapshot-1');
    expect(serializedContinuity).not.toContain('turn-a');
    expect(serializedContinuity).not.toContain('turn-b');
    expect(serializedContinuity).not.toContain('turn-c');
    expect(serializedContinuity).not.toContain('private-vendor-session');
    expect(serializedContinuity).not.toContain('prompt-b');
    expect(serializedContinuity).not.toContain('prompt-c');
    expect(serializedContinuity).not.toContain('output-b');
    expect(serializedContinuity).not.toContain('output-c');
    expect(serializedContinuity).not.toContain('/tmp/effect-b');
    expect(serializedContinuity).not.toContain('/tmp/effect-c');
    expect(serializedContinuity).not.toContain('effect-b');
    expect(serializedContinuity).not.toContain('effect-c');
    expect(serializedContinuity).not.toContain('"capability"');
    expect(serializedContinuity).not.toContain('"httpPort"');
    expect(serializedContinuity).not.toContain('"path"');
    expect(serializedContinuity).not.toContain('"token"');
    expect(serializedContinuity).not.toContain('"credentials"');
    expect(serializedContinuity).not.toContain('"executablePath"');
    expect(serializedContinuity).not.toContain('"homeDir"');
    expect(serializedContinuity).not.toContain('"configPath"');
    expect(serializedContinuity).not.toContain('"managedProviderGenerations"');
    expect(sequence).toEqual([
      'completed-turn-a',
      'enqueue-prompt-b',
      'active-turn-b',
      'effect-effect-b',
      'replace-101',
      'output-output-b',
      'completed-turn-b',
      'replace-102',
      'enqueue-prompt-c',
      'effect-effect-c',
      'output-output-c',
      'completed-turn-c',
      'count-output-b',
      'count-effect-b',
      'terminal-turn-b',
      'count-output-c',
      'count-effect-c',
      'terminal-turn-c',
    ]);
  });
});
