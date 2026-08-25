import { ChildProcess } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import type { DaemonState, StartedDaemon } from '../../daemon/daemon';
import type { CliTestLaunchSpec } from '../../process/cliLaunchSpec';
import {
  parseRunnerDaemonServiceAuthority,
  projectRetainedPluginLifecycleEvidence,
  runDaemonRunnerContinuityAToBToC,
  type RunnerDaemonServiceAuthority,
} from './daemonRunnerContinuity';

function startedDaemon(state: DaemonState): StartedDaemon {
  return {
    happyHomeDir: '/private/home',
    state,
    proc: {
      child: new ChildProcess(),
      stdoutPath: '/private/daemon.stdout.log',
      stderrPath: '/private/daemon.stderr.log',
      stop: async () => {},
    },
    stop: async () => {},
  };
}

/**
 * The turn a phase observes as active is the turn that same phase then settles:
 * the harness owner replaces the daemon while that turn is in flight and rejects
 * the run when the settled identity differs. Both fixtures below therefore issue
 * active-turn identities from the one modeled sequence `waitForNextCompletedTurn`
 * advances, instead of a constant that can only agree with one phase.
 */
function nextModeledTurnId(previousTurnId: string | null): string {
  const previousIndex = previousTurnId === null
    ? 0
    : Number.parseInt(previousTurnId.slice('turn-'.length), 10);
  return `turn-${previousIndex + 1}`;
}

function retainedAgentBinding(immutableGenerationId: string) {
  return {
    v: 1,
    pluginId: 'happier.agent.opencode',
    pluginVersion: '1.0.0',
    agentId: 'opencode',
    localAgentId: 'opencode',
    immutableGenerationId,
    locator: {
      module: './agent/runtime/factory',
      export: 'createAgentSessionRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: '/private/immutable/agent/runtime/factory.js',
    loadMode: 'immutable-js' as const,
  } as const;
}

describe('daemon runner continuity evidence', () => {
  it('accepts only the direct grant-free authority document schema', () => {
    const document = {
      v: 2,
      sessionId: 'session-direct-authority',
      runner: {
        pid: 50_100,
        processStartTimeMs: 1_754_041_400_000,
        processCommandHash: 'a'.repeat(64),
        snapshotIdentity: 'snapshot:/private/candidate/happier',
      },
      pluginHardRevocationRevision: 0,
      retainedAgent: retainedAgentBinding(`bundled-${'b'.repeat(64)}`),
      httpPort: 41_000,
      capability: 'A'.repeat(43),
    };

    expect(parseRunnerDaemonServiceAuthority(
      '/private/runtime/authority.json',
      document,
    )).toMatchObject({
      sessionId: document.sessionId,
      runner: document.runner,
      pluginHardRevocationRevision: 0,
      retainedAgent: document.retainedAgent,
    });
    expect(parseRunnerDaemonServiceAuthority(
      '/private/runtime/authority.json',
      { ...document, unexpectedLegacyAuthority: true },
    )).toBeNull();
    const declarativeAcp = {
      ...document,
      retainedAgent: {
        kind: 'host_declarative_acp_v1',
        v: 1,
        pluginId: 'happier.agent.claude',
        pluginVersion: '1.0.0',
        agentId: 'claude',
        qualifiedAgentId: 'happier.agent.claude/claude',
        localAgentId: 'claude',
        immutableGenerationId: `bundled-${'c'.repeat(64)}`,
      },
    };
    expect(parseRunnerDaemonServiceAuthority(
      '/private/runtime/authority.json',
      declarativeAcp,
    )?.retainedAgent).toEqual(declarativeAcp.retainedAgent);
  });

  it('rejects a mutable runtime identity for candidate-artifact continuity before turn work', async () => {
    const daemonAState = { pid: 50_001, httpPort: 41_001 } satisfies DaemonState;
    const authority: RunnerDaemonServiceAuthority = {
      path: '/private/runtime/authority.json',
      sessionId: 'session-candidate-mutable',
      runner: {
        pid: 50_101,
        processStartTimeMs: 1_754_041_500_000,
        processCommandHash: 'a'.repeat(64),
        snapshotIdentity: 'path:/private/mutable/apps/cli/src/index.ts',
      },
      pluginHardRevocationRevision: 0,
      retainedAgent: retainedAgentBinding(`bundled-${'d'.repeat(64)}`),
      httpPort: daemonAState.httpPort,
      capability: 'A'.repeat(43),
    };

    await expect(runDaemonRunnerContinuityAToBToC({
      daemonA: startedDaemon(daemonAState),
      testDir: '/private/test',
      happyHomeDir: '/private/home',
      daemonEnv: {},
      baseUrl: 'http://127.0.0.1:41_100',
      token: 'server-token',
      sessionId: authority.sessionId,
      secret: Uint8Array.of(1, 2, 3),
      launchEntrypointKind: 'candidate_artifact',
      phases: [
        {
          id: 'b',
          prompt: 'phase b',
          requiredAssistantSubstring: 'done-b',
          effect: { path: '/private/effect-b', marker: 'effect-b' },
        },
        {
          id: 'c',
          prompt: 'phase c',
          requiredAssistantSubstring: 'done-c',
          effect: { path: '/private/effect-c', marker: 'effect-c' },
        },
      ],
      deps: {
        readTrackedRunnerPid: async () => authority.runner.pid,
        waitForAuthority: async () => authority,
        probeAuthority: async () => ({
          status: 200,
          ok: true,
          errorCode: null,
          resultKind: 'turn_contributions',
          resultStatus: 'resolved',
        }),
        replaceDaemon: async () => {
          throw new Error('candidate mutable identity reached daemon replacement');
        },
        isProcessAlive: () => true,
        enqueuePrompt: async () => {},
        waitForActiveTurn: async () => 'turn-b',
        waitForMatchingEffect: async () => {},
        waitForMatchingAssistantTranscriptOutput: async () => {},
        countMatchingAssistantTranscriptOutputs: async () => 1,
        countMatchingEffects: async () => 1,
        countTerminalEvents: async () => 1,
        observeUnderlyingAgentIdentity: async () => ({
          childProcessIdentity: null,
          vendorSessionId: null,
        }),
        waitForNextCompletedTurn: async () => {
          throw new Error('candidate mutable identity reached turn work');
        },
      },
    })).rejects.toThrow('candidate_artifact requires an immutable or versioned runner runtime identity');
  });

  it('projects observed continuity fingerprints without raw authority material', async () => {
    const lifecycleEvents: string[] = [];
    const replacementDaemons: StartedDaemon[] = [];
    const candidateLaunchSpec: CliTestLaunchSpec = Object.freeze({
      command: '/private/candidate/happier',
      args: [],
      cwd: '/private/candidate',
    });
    const replacementLaunchSpecs: CliTestLaunchSpec[] = [];
    const runner = {
      pid: 51_001,
      processStartTimeMs: 1_754_041_600_000,
      processCommandHash: 'a'.repeat(64),
      snapshotIdentity: 'snapshot:/private/candidate/happier',
    } as const;
    const binding = retainedAgentBinding(`bundled-${'c'.repeat(64)}`);
    const daemons = {
      a: { pid: 52_001, httpPort: 42_001, controlToken: 'daemon-a-secret' },
      b: { pid: 52_002, httpPort: 42_002, controlToken: 'daemon-b-secret' },
      c: { pid: 52_003, httpPort: 42_003, controlToken: 'daemon-c-secret' },
    } satisfies Record<'a' | 'b' | 'c', DaemonState>;
    const rawAuthorityPath = '/private/runtime/authority.json';
    const rawCapabilities = {
      a: 'A'.repeat(43),
      b: 'B'.repeat(43),
      c: 'C'.repeat(43),
    } as const;
    const rawAgentChildIdentity = {
      pid: 53_001,
      processStartTimeMs: 1_754_041_600_500,
      processCommandHash: 'f'.repeat(64),
    } as const;
    const rawVendorSessionId = 'vendor-session-private';
    const authority = (
      phase: 'a' | 'b' | 'c',
    ): RunnerDaemonServiceAuthority => ({
      path: rawAuthorityPath,
      sessionId: 'session-continuity',
      runner,
      pluginHardRevocationRevision: 0,
      retainedAgent: binding,
      httpPort: daemons[phase].httpPort,
      capability: rawCapabilities[phase],
    });
    const authorityByPort = new Map([
      [daemons.a.httpPort, authority('a')],
      [daemons.b.httpPort, authority('b')],
      [daemons.c.httpPort, authority('c')],
    ]);
    let completedTurn = 0;
    const daemonA: StartedDaemon = {
      happyHomeDir: '/private/home',
      state: daemons.a,
      proc: {
        child: new ChildProcess(),
        stdoutPath: '/private/daemon.stdout.log',
        stderrPath: '/private/daemon.stderr.log',
        stop: async () => {},
      },
      stop: async () => {},
    };

    const evidence = await runDaemonRunnerContinuityAToBToC({
      daemonA,
      testDir: '/private/test',
      happyHomeDir: '/private/home',
      daemonEnv: { RAW_PROVIDER_TOKEN: 'provider-token-secret' },
      baseUrl: 'http://127.0.0.1:42_100',
      token: 'server-token-secret',
      sessionId: 'session-continuity',
      secret: Uint8Array.of(1, 2, 3),
      launchEntrypointKind: 'candidate_artifact',
      cliLaunchSpec: candidateLaunchSpec,
      onReplacementDaemon: (replacementDaemon) => {
        replacementDaemons.push(replacementDaemon);
      },
      phases: [
        {
          id: 'b',
          prompt: 'phase b',
          requiredAssistantSubstring: 'done-b',
          effect: { path: '/private/effect-b', marker: 'effect-b-private' },
        },
        {
          id: 'c',
          prompt: 'phase c',
          requiredAssistantSubstring: 'done-c',
          effect: { path: '/private/effect-c', marker: 'effect-c-private' },
        },
      ],
      deps: {
        readTrackedRunnerPid: async () => runner.pid,
        waitForAuthority: async ({ daemon }) => {
          const current = authorityByPort.get(daemon.httpPort);
          if (!current) throw new Error('unexpected daemon');
          return current;
        },
        probeAuthority: async (observed) => {
          const current = authorityByPort.get(observed.httpPort);
          return observed.capability === current?.capability
            ? {
                status: 200,
                ok: true,
                errorCode: null,
                resultKind: 'turn_contributions',
                resultStatus: 'resolved',
              }
            : {
                status: 403,
                ok: false,
                errorCode: 'agent_runtime_daemon_service_forbidden',
                resultKind: null,
                resultStatus: null,
              };
        },
        replaceDaemon: async ({ phase, cliLaunchSpec }) => {
          lifecycleEvents.push(`replace:${phase}`);
          replacementLaunchSpecs.push(cliLaunchSpec!);
          return startedDaemon(daemons[phase]);
        },
        isProcessAlive: (pid) => pid === runner.pid,
        enqueuePrompt: async ({ text }) => {
          lifecycleEvents.push(`enqueue:${text.at(-1)}`);
        },
        waitForActiveTurn: async ({ previousTurnId }) => {
          const activeTurnId = nextModeledTurnId(previousTurnId);
          lifecycleEvents.push(`active:${activeTurnId === 'turn-2' ? 'b' : 'c'}`);
          return activeTurnId;
        },
        waitForMatchingEffect: async ({ marker }) => {
          lifecycleEvents.push(`effect:${marker.includes('-b-') ? 'b' : 'c'}`);
        },
        waitForMatchingAssistantTranscriptOutput: async ({ requiredSubstring }) => {
          lifecycleEvents.push(`output:${requiredSubstring.at(-1)}`);
        },
        countMatchingAssistantTranscriptOutputs: async ({ requiredSubstring }) => {
          lifecycleEvents.push(`count-output:${requiredSubstring.at(-1)}`);
          return 1;
        },
        countMatchingEffects: async ({ marker }) => {
          lifecycleEvents.push(`count-effect:${marker.includes('-b-') ? 'b' : 'c'}`);
          return 1;
        },
        countTerminalEvents: async ({ turnId }) => {
          lifecycleEvents.push(`terminal:${turnId === 'turn-2' ? 'b' : 'c'}`);
          return 1;
        },
        observeUnderlyingAgentIdentity: async () => ({
          childProcessIdentity: rawAgentChildIdentity,
          vendorSessionId: rawVendorSessionId,
        }),
        waitForNextCompletedTurn: async ({ previousTurnId }) => {
          completedTurn += 1;
          lifecycleEvents.push(`complete:${previousTurnId === null ? 'a' : completedTurn === 2 ? 'b' : 'c'}`);
          return `turn-${completedTurn}`;
        },
      },
    });

    expect(evidence).toMatchObject({
      phaseCount: 3,
      runtime: {
        launchEntrypointKind: 'candidate_artifact',
        identityKind: 'immutable_snapshot',
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
          availability: 'observed',
          distinctIdentityCount: 1,
          stableAcrossAllPhases: true,
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
    expect(evidence).not.toHaveProperty('retainedPluginLifecycle');
    expect(replacementDaemons.map((daemon) => daemon.state.pid)).toEqual([
      daemons.b.pid,
      daemons.c.pid,
    ]);
    expect(replacementLaunchSpecs).toEqual([
      candidateLaunchSpec,
      candidateLaunchSpec,
    ]);
    expect(lifecycleEvents).toEqual([
      'complete:a',
      'enqueue:b',
      'active:b',
      'effect:b',
      'replace:b',
      'output:b',
      'complete:b',
      'enqueue:c',
      'active:c',
      'effect:c',
      'replace:c',
      'output:c',
      'complete:c',
      'count-output:b',
      'count-effect:b',
      'terminal:b',
      'count-output:c',
      'count-effect:c',
      'terminal:c',
    ]);
    for (const fingerprintGroup of [
      evidence.daemon.identityFingerprints,
      evidence.runtime.entrypointIdentityFingerprints,
      evidence.runner.identityFingerprints,
      evidence.runner.processCommandHashFingerprints,
      evidence.logicalSession.identityFingerprints,
      evidence.executionAuthority.retainedAgentBindingFingerprints,
      evidence.underlyingAgent.childProcess.identityFingerprints,
      evidence.underlyingAgent.vendorSession.identityFingerprints,
      evidence.authority.capabilityFingerprints,
      evidence.turns.completedTurnFingerprints,
    ]) {
      for (const fingerprint of Object.values(fingerprintGroup)) {
        expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      }
    }
    const serialized = JSON.stringify(evidence);
    for (const rawValue of [
      rawAuthorityPath,
      '/private/test',
      '/private/home',
      '/private/daemon.stdout.log',
      '/private/daemon.stderr.log',
      'provider-token-secret',
      'server-token-secret',
      'session-continuity',
      String(daemons.a.pid),
      String(daemons.b.pid),
      String(daemons.c.pid),
      String(daemons.a.httpPort),
      String(daemons.b.httpPort),
      String(daemons.c.httpPort),
      String(runner.pid),
      String(runner.processStartTimeMs),
      String(rawAgentChildIdentity.pid),
      String(rawAgentChildIdentity.processStartTimeMs),
      rawAgentChildIdentity.processCommandHash,
      rawVendorSessionId,
      runner.processCommandHash,
      runner.snapshotIdentity,
      binding.pluginId,
      binding.agentId,
      binding.localAgentId,
      binding.immutableGenerationId,
      'turn-1',
      'turn-2',
      'turn-3',
      'phase b',
      'phase c',
      'done-b',
      'done-c',
      '/private/effect-b',
      '/private/effect-c',
      'effect-b-private',
      'effect-c-private',
      ...Object.values(rawCapabilities),
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
  });

  function retainedLifecycleRunParams(params: Readonly<{
    agentNewGeneration: string;
    providerNewGeneration: string;
  }>) {
    const runner = {
      pid: 61_001,
      processStartTimeMs: 1_754_041_700_000,
      processCommandHash: '1'.repeat(64),
      snapshotIdentity: 'path:/private/source/apps/cli/src/index.ts',
    } as const;
    const daemons = {
      a: { pid: 62_001, httpPort: 43_001, controlToken: 'daemon-a-secret' },
      b: { pid: 62_002, httpPort: 43_002, controlToken: 'daemon-b-secret' },
      c: { pid: 62_003, httpPort: 43_003, controlToken: 'daemon-c-secret' },
    } satisfies Record<'a' | 'b' | 'c', DaemonState>;
    const authority = (phase: 'a' | 'b' | 'c'): RunnerDaemonServiceAuthority => ({
      path: '/private/runtime/authority.json',
      sessionId: 'session-retained-lifecycle',
      runner,
      pluginHardRevocationRevision: 0,
      retainedAgent: retainedAgentBinding('ordinary-a-to-b-to-c-generation'),
      httpPort: daemons[phase].httpPort,
      capability: phase.toUpperCase().repeat(43),
    });
    const authorityByPort = new Map([
      [daemons.a.httpPort, authority('a')],
      [daemons.b.httpPort, authority('b')],
      [daemons.c.httpPort, authority('c')],
    ]);
    let completedTurn = 0;
    const daemonA: StartedDaemon = {
      happyHomeDir: '/private/home',
      state: daemons.a,
      proc: {
        child: new ChildProcess(),
        stdoutPath: '/private/daemon.stdout.log',
        stderrPath: '/private/daemon.stderr.log',
        stop: async () => {},
      },
      stop: async () => {},
    };
    const agentRetainedGeneration = 'agent-generation-g';
    const providerRetainedGeneration = 'provider-generation-p';

    return {
      daemonA,
      testDir: '/private/test',
      happyHomeDir: '/private/home',
      daemonEnv: {},
      baseUrl: 'http://127.0.0.1:43_100',
      token: 'server-token-secret',
      sessionId: 'session-retained-lifecycle',
      secret: Uint8Array.of(4, 5, 6),
      launchEntrypointKind: 'source',
      phases: [
        {
          id: 'b',
          prompt: 'phase b',
          requiredAssistantSubstring: 'done-b',
          effect: { path: '/private/effect-b', marker: 'effect-b-private' },
        },
        {
          id: 'c',
          prompt: 'phase c',
          requiredAssistantSubstring: 'done-c',
          effect: { path: '/private/effect-c', marker: 'effect-c-private' },
        },
      ],
      observeRetainedPluginLifecycle: async () => ({
        agent: {
          generations: {
            retainedSessionBeforeUpdate: agentRetainedGeneration,
            retainedSessionAfterUpdate: agentRetainedGeneration,
            newSessionAfterUpdate: params.agentNewGeneration,
          },
          retainedLaterTurn: 'completed',
          newSessionFirstTurn: 'completed',
        },
        provider: {
          generations: {
            retainedHandleBeforeUpdate: providerRetainedGeneration,
            retainedHandleAfterUpdate: providerRetainedGeneration,
            newClaimAfterUpdate: params.providerNewGeneration,
          },
          retainedHandleUse: 'continued',
          newClaim: 'admitted',
        },
      }),
      deps: {
        readTrackedRunnerPid: async () => runner.pid,
        waitForAuthority: async ({ daemon }: { daemon: DaemonState }) => {
          const current = authorityByPort.get(daemon.httpPort);
          if (!current) throw new Error('unexpected daemon');
          return current;
        },
        probeAuthority: async (observed: RunnerDaemonServiceAuthority) => {
          const current = authorityByPort.get(observed.httpPort);
          return observed.capability === current?.capability
            ? {
                status: 200 as const,
                ok: true as const,
                errorCode: null,
                resultKind: 'turn_contributions',
                resultStatus: 'resolved',
              }
            : {
                status: 403 as const,
                ok: false as const,
                errorCode: 'agent_runtime_daemon_service_forbidden',
                resultKind: null,
                resultStatus: null,
              };
        },
        replaceDaemon: async ({ phase }: { phase: 'b' | 'c' }) => startedDaemon(daemons[phase]),
        isProcessAlive: (pid: number) => pid === runner.pid,
        enqueuePrompt: async () => {},
        waitForActiveTurn: async (
          { previousTurnId }: { previousTurnId: string | null },
        ) => nextModeledTurnId(previousTurnId),
        waitForMatchingEffect: async () => {},
        waitForMatchingAssistantTranscriptOutput: async () => {},
        countMatchingAssistantTranscriptOutputs: async () => 1,
        countMatchingEffects: async () => 1,
        countTerminalEvents: async () => 1,
        observeUnderlyingAgentIdentity: async () => ({
          childProcessIdentity: null,
          vendorSessionId: null,
        }),
        waitForNextCompletedTurn: async () => {
          completedTurn += 1;
          return `turn-${completedTurn}`;
        },
      },
    } satisfies Parameters<typeof runDaemonRunnerContinuityAToBToC>[0];
  }

  it('does not let ordinary same-generation A-to-B-to-C observations satisfy retained G-to-H/P-to-Q evidence', async () => {
    await expect(runDaemonRunnerContinuityAToBToC(retainedLifecycleRunParams({
      agentNewGeneration: 'agent-generation-g',
      providerNewGeneration: 'provider-generation-p',
    }))).rejects.toThrow(/distinct retained plugin lifecycle generation/u);
    expect(() => (
      projectRetainedPluginLifecycleEvidence as (observations: unknown) => unknown
    )({
      agent: {
        generations: {
          retainedSessionBeforeUpdate: 'agent-generation-g',
          retainedSessionAfterUpdate: 'agent-generation-g',
        },
        retainedLaterTurn: 'completed',
        newSessionFirstTurn: 'completed',
      },
      provider: {
        generations: {
          retainedHandleBeforeUpdate: 'provider-generation-p',
          retainedHandleAfterUpdate: 'provider-generation-p',
          newClaimAfterUpdate: 'provider-generation-q',
        },
        retainedHandleUse: 'continued',
        newClaim: 'admitted',
      },
    })).toThrow(/Invalid retained plugin lifecycle observations/u);
    expect(() => (
      projectRetainedPluginLifecycleEvidence as (observations: unknown) => unknown
    )({
      agent: {
        generations: {
          retainedSessionBeforeUpdate: 'agent-generation-g',
          retainedSessionAfterUpdate: 'agent-generation-g',
          newSessionAfterUpdate: 'agent-generation-h',
        },
        retainedLaterTurn: 'completed',
        newSessionFirstTurn: 'completed',
      },
      provider: {
        generations: {
          retainedHandleBeforeUpdate: 'provider-generation-p',
          retainedHandleAfterUpdate: 'provider-generation-p',
          newClaimAfterUpdate: 'provider-generation-q',
        },
        retainedHandleUse: 'continued',
        newClaim: 'rejected',
      },
    })).toThrow(/Invalid distinct retained plugin lifecycle generation evidence/u);
  });

  it('projects only explicit distinct retained G-to-H/P-to-Q observations', async () => {
    const evidence = await runDaemonRunnerContinuityAToBToC(retainedLifecycleRunParams({
      agentNewGeneration: 'agent-generation-h',
      providerNewGeneration: 'provider-generation-q',
    }));
    const retainedPluginLifecycle = (
      evidence as typeof evidence & { retainedPluginLifecycle?: unknown }
    ).retainedPluginLifecycle;

    expect(retainedPluginLifecycle).toMatchObject({
      agent: {
        generations: {
          retainedSessionBeforeUpdate: 'agent-generation-g',
          retainedSessionAfterUpdate: 'agent-generation-g',
          newSessionAfterUpdate: 'agent-generation-h',
        },
        distinctGenerationCount: 2,
        retainedLaterTurn: 'completed',
        newSessionFirstTurn: 'completed',
      },
      provider: {
        generations: {
          retainedHandleBeforeUpdate: 'provider-generation-p',
          retainedHandleAfterUpdate: 'provider-generation-p',
          newClaimAfterUpdate: 'provider-generation-q',
        },
        distinctGenerationCount: 2,
        retainedHandleUse: 'continued',
        newClaim: 'admitted',
      },
    });
    const serialized = JSON.stringify(retainedPluginLifecycle);
    for (const rawGeneration of [
      'agent-generation-g',
      'agent-generation-h',
      'provider-generation-p',
      'provider-generation-q',
    ]) {
      expect(serialized).toContain(rawGeneration);
    }
    expect(serialized).not.toContain('generationFingerprints');
    expect(serialized).not.toContain('sha256:');
  });
});
