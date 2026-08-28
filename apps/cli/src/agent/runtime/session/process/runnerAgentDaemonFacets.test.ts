import { describe, expect, it, vi } from 'vitest';
import type { VoiceProviderContribution } from '@happier-dev/protocol';

import type {
  RunnerAgentExternalSessionProviderOps,
} from '@/agent/runtime/registry/engineRegistry/types';
import {
  resolveRetainedAgentSessionRealtimeVoiceAuthority,
} from '@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority';

import {
  createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  createRunnerAgentDaemonFacets,
} from './runnerAgentDaemonFacets';
import {
  RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
} from './agentRuntimeDaemonServiceAuthorityClient';
import type {
    AgentRuntimeDaemonServiceResponseV1,
} from './agentRuntimeDaemonServiceProtocol';
import {
    AgentRuntimeDaemonServiceRequestV1Schema,
} from './agentRuntimeDaemonServiceProtocol';

const runnerFixture = {
  sessionId: 'session-1',
  binding: createAgentSessionRunnerFactoryBinding({
    v: 1,
    pluginId: 'happier.agent.acme',
    pluginVersion: '1.0.0',
    agentId: 'acme',
    localAgentId: 'acme',
    immutableGenerationId: 'generation-1',
    locator: {
      module: './agent/factory.js',
      export: 'createAgentRuntime',
      runtimeApiVersion: 1,
    },
    normalizedModulePath: 'agent/factory.js',
    loadMode: 'immutable-js',
  }),
  runner: {
    pid: 123,
    processStartTimeMs: 1_000,
    processCommandHash: 'b'.repeat(64),
    snapshotIdentity: 'snapshot-1',
  },
} as const;

const authority = {
  happyHomeDir: '/tmp/happier',
  publicReleaseRing: 'stable' as const,
  path: '/tmp/happier/authority.json',
  sessionId: runnerFixture.sessionId,
  runner: runnerFixture.runner,
  retainedAgent: runnerFixture.binding,
};
const daemonWitness = {
    turnId: 'turn-1',
    inputId: 'input-1',
    userMessageSeq: 7,
    userMessageSeqs: [7],
};
const witness = {
    ...daemonWitness,
    causalPermissionAuthority: {
        kind: 'admittedSessionInputV1' as const,
        admittedPermissionCeiling: 'read-only',
    },
};

const voiceProvider = {
  pluginId: 'happier.voice.elevenlabs',
  localId: 'conversation',
} as const;

type ConversationVoiceProviderContribution = Extract<
  VoiceProviderContribution,
  Readonly<{ kind: 'conversation' }>
>;

function voiceDeclaration(): ConversationVoiceProviderContribution {
  return {
    id: voiceProvider.localId,
    kind: 'conversation' as const,
    title: 'Conversation',
    roles: ['realtime_conversation' as const],
    platforms: ['web' as const],
    capabilities: {
      turn: {
        cancelResponse: false,
        bargeIn: false,
      },
      tools: { effectCalls: 'none' },
    },
    execution: {
      kind: 'experimental_agent_session_realtime' as const,
      agent: {
        pluginId: runnerFixture.binding.pluginId,
        localId: runnerFixture.binding.localAgentId,
      },
      supportedRuntimeVersions: ['1.2.3'],
    },
    settings: {
      schemaVersion: 2 as const,
      fields: [],
      connectedServicesBinding: {
        id: 'globalConnectedServices',
        title: 'Agent account',
        agent: {
          pluginId: runnerFixture.binding.pluginId,
          localId: runnerFixture.binding.localAgentId,
        },
        serviceIds: ['openai-codex'],
      },
    },
    client: {
      artifactId: 'voice-runtime-web',
      modulePath: './ui/voice',
      exportName: 'activate' as const,
    },
  };
}

describe('runner Agent daemon facet adapters', () => {
  it('preserves acknowledged same-daemon follow delivery', async () => {
    const calls: unknown[] = [];
    let nextCount = 0;
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      calls.push(request.operation);
      switch (request.operation.kind) {
        case 'voice.authority.snapshot':
          return {
            ok: true,
            result: {
              kind: 'voice.authority.snapshot',
              agentGeneration: runnerFixture.binding.immutableGenerationId,
              providers: [],
            },
          };
        case 'external_session.follow.open':
          return {
            ok: true,
            result: {
              kind: 'external_session.follow.open',
              followId: request.operation.followId,
              result: {
                status: 'following',
                startingCursor: 'cursor-1',
              },
            },
          };
        case 'external_session.follow.next':
          nextCount += 1;
          return {
            ok: true,
            result: {
              kind: 'external_session.follow.event',
              followId: request.operation.followId,
              eventId: `event-${nextCount}`,
              event: nextCount === 1
                ? {
                    kind: 'data',
                    items: [{
                      id: 'item-1',
                      kind: 'agent',
                      data: {
                        role: 'agent',
                        content: { type: 'codex', data: { type: 'message', message: 'hello' } },
                      },
                    }],
                    fromCursor: 'cursor-1',
                    nextCursor: 'cursor-2',
                  }
                : {
                    kind: 'terminated',
                    reason: 'retired',
                    cursor: 'cursor-2',
                  },
            },
          };
        case 'external_session.follow.close':
          return {
            ok: true,
            result: {
              kind: 'external_session.follow.closed',
              followId: request.operation.followId,
            },
          };
        default:
          throw new Error(`unexpected ${request.operation.kind}`);
      }
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
      readActiveTurnAdmissionWitness: () => witness,
    });
    const port =
      facets.externalSessionHostOperations.bindSession(
        runnerFixture.sessionId,
      );
    const events: string[] = [];
    const follow = await port.executeFollow({
      ref: {
        agentId: runnerFixture.binding.localAgentId,
        sourceId: 'default',
        remoteSessionId: 'remote-session-1',
      },
      source: { kind: 'syntheticSource', value: 'test' },
      options: { cursor: 'cursor-1' },
      listener: async (event) => {
        events.push(event.kind);
      },
    });
    expect(follow.status).toBe('following');
    await vi.waitFor(() => {
      expect(events).toEqual(['data', 'terminated']);
    });
    expect(calls).toContainEqual(expect.objectContaining({
      kind: 'external_session.follow.next',
      acknowledgeEventId: 'event-1',
      witness: daemonWitness,
    }));
    expect(calls).toContainEqual(expect.objectContaining({
      kind: 'external_session.follow.close',
      acknowledgeEventId: 'event-2',
    }));
    const providerFollow =
      await port.executeProviderSessionFollow({
        agentId: runnerFixture.binding.localAgentId,
        providerSessionId: 'provider-session-1',
        options: {},
        listener: async () => undefined,
      });
    expect(providerFollow.status).toBe('following');
    expect(calls).toContainEqual(expect.objectContaining({
      kind: 'external_session.follow.open',
      target: {
        kind: 'providerSession',
        agentId: runnerFixture.binding.localAgentId,
        providerSessionId: 'provider-session-1',
      },
    }));
    if (providerFollow.status === 'following') {
      await providerFollow.subscription.dispose();
    }
    await port.retire();
  });

  it.each([
    {
      caseName: 'follow.next failure',
      nextResponse: (): AgentRuntimeDaemonServiceResponseV1 => ({
        ok: false,
        error: {
          code: 'plugin_external_follow_provider_failed',
          message: 'provider follow failed',
        },
      }),
      expectedCode: 'plugin_external_follow_provider_failed',
    },
    {
      caseName: 'invalid follow response',
      nextResponse: (): AgentRuntimeDaemonServiceResponseV1 => ({
        ok: true,
        result: {
          kind: 'external_session.follow.event',
          followId: 'mismatched-follow-id',
          eventId: 'event-invalid-response',
          event: {
            kind: 'data',
            items: [],
            fromCursor: 'cursor-1',
            nextCursor: 'cursor-2',
          },
        },
      }),
      expectedCode: 'plugin_external_follow_response_invalid',
    },
  ])(
    'reports a non-recoverable $caseName before closing the daemon follow',
    async ({ nextResponse, expectedCode }) => {
    const events: Array<{
      kind: string;
      reason?: string;
      code?: string;
    }> = [];
    const closedFollowIds: string[] = [];
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [],
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.open') {
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.open',
            followId: request.operation.followId,
            result: {
              status: 'following',
              startingCursor: 'cursor-1',
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.next') {
        return nextResponse();
      }
      if (request.operation.kind === 'external_session.follow.close') {
        closedFollowIds.push(request.operation.followId);
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.closed',
            followId: request.operation.followId,
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
    });
    const port = facets.externalSessionHostOperations.bindSession(
      runnerFixture.sessionId,
    );

    const follow = await port.executeProviderSessionFollow({
      agentId: runnerFixture.binding.localAgentId,
      providerSessionId: 'provider-session-failure',
      options: {},
      listener: async (event) => {
        events.push(event);
      },
    });
    expect(follow.status).toBe('following');
    if (follow.status !== 'following') {
      throw new Error('expected active provider follow');
    }
    await expect(follow.failure).resolves.toMatchObject({
      code: expectedCode,
    });
    await vi.waitFor(() => {
      expect(events).toEqual([{
        kind: 'terminated',
        reason: 'providerFailure',
        cursor: 'cursor-1',
        code: expectedCode,
      }]);
    });
    await vi.waitFor(() => {
      expect(closedFollowIds).toHaveLength(1);
    });
    await facets.dispose();
    },
  );

  it('settles the private follow failure signal when the listener projector rejects', async () => {
    const projectorFailure = Object.assign(
      new Error('terminal transcript projector failed'),
      { code: 'terminal_transcript_projection_failed' },
    );
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [],
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.open') {
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.open',
            followId: request.operation.followId,
            result: {
              status: 'following',
              startingCursor: null,
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.next') {
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.event',
            followId: request.operation.followId,
            eventId: 'event-projector-failure',
            event: {
              kind: 'data',
              items: [],
              fromCursor: null,
              nextCursor: 'cursor-1',
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.close') {
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.closed',
            followId: request.operation.followId,
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
    });
    const port = facets.externalSessionHostOperations.bindSession(
      runnerFixture.sessionId,
    );

    const follow = await port.executeProviderSessionFollow({
      agentId: runnerFixture.binding.localAgentId,
      providerSessionId: 'provider-session-projector-failure',
      options: {},
      listener: async () => {
        throw projectorFailure;
      },
    });
    expect(follow.status).toBe('following');
    if (follow.status !== 'following') {
      throw new Error('expected active provider follow');
    }
    expect(follow.failure).toBeDefined();
    await expect(follow.failure).resolves.toBe(projectorFailure);
    await facets.dispose();
  });

  it('projects only the daemon snapshot and retires the runner-local realtime data plane with its provider generation', async () => {
    let retireVoice!: () => void;
    const retired = new Promise<void>((resolve) => {
      retireVoice = resolve;
    });
    const conversation = {
      inspect: vi.fn(),
      start: vi.fn(),
    };
    let retirementWaitCount = 0;
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [{
              provider: voiceProvider,
              providerGeneration: 'voice-generation-1',
              declaration: voiceDeclaration(),
            }],
          },
        };
      }
      if (
        request.operation.kind
          === 'voice.authority.waitRetired'
      ) {
        retirementWaitCount += 1;
        if (retirementWaitCount <= 2) {
          throw Object.assign(
            new Error(
              retirementWaitCount === 1
                ? 'daemon A replaced by daemon B'
                : 'daemon B replaced by daemon C',
            ),
            {
              code:
                RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
            },
          );
        }
        await retired;
        return {
          ok: true,
          result: {
            kind: 'voice.authority.retired',
            providerGeneration:
              request.operation.providerGeneration,
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
      readActiveTurnAdmissionWitness: () => witness,
    });
    const voice = facets.agentSessionRealtimeVoiceAuthority;
    expect(voice?.resolveDeclaration(voiceProvider)).toEqual(
      voiceDeclaration(),
    );
    expect(voice?.isCurrent(voiceProvider)).toBe(true);
    await vi.waitFor(() => {
      expect(retirementWaitCount).toBe(3);
    });
    expect(voice?.resolveConversation({
      provider: voiceProvider,
      runtime: {
        send: vi.fn(),
        watch: vi.fn(),
        dispose: vi.fn(),
        realtimeConversation: conversation,
      },
    })).toMatchObject({ conversation });

    retireVoice();
    await vi.waitFor(() => {
      expect(voice?.isCurrent(voiceProvider)).toBe(false);
    });
    await facets.dispose();
  });

  it('keeps retained G Voice current through daemon A to B when H replaces the registry Agent, then retires with the current Voice provider', async () => {
    const voiceProviderRetirement = new AbortController();
    const registryForAgentGeneration = (
      immutableGenerationId: string,
    ) => ({
      contributes: {
        voiceProviders: [{
          pluginId: voiceProvider.pluginId,
          identity: voiceProvider,
          definition: voiceDeclaration(),
        }],
      },
      agentRuntimesByAgentId: new Map([[
        runnerFixture.binding.agentId,
        {
          pluginId: runnerFixture.binding.pluginId,
          agentId: runnerFixture.binding.agentId,
          generation: immutableGenerationId,
          immutableGenerationId,
          sessionRunnerFactoryBinding: {
            pluginId: runnerFixture.binding.pluginId,
            agentId: runnerFixture.binding.agentId,
            localAgentId: runnerFixture.binding.localAgentId,
            immutableGenerationId,
          },
          isCurrent: () => true,
          retirementSignal: new AbortController().signal,
        },
      ]]),
      resolveVoiceProviderRuntimeLifecycle: () => ({
        generation: 'voice-generation-1',
        isCurrent: () => !voiceProviderRetirement.signal.aborted,
        retirementSignal: voiceProviderRetirement.signal,
      }),
    });
    let currentRegistry = registryForAgentGeneration(
      runnerFixture.binding.immutableGenerationId,
    );
    let daemon: 'A' | 'B' = 'A';
    let retirementWaitCount = 0;
    const resolveSnapshot = () => {
      const voiceAuthority =
        resolveRetainedAgentSessionRealtimeVoiceAuthority({
          runtimeRegistry: currentRegistry,
          retainedAgent: runnerFixture.binding,
        });
      const declaration = voiceAuthority?.resolveDeclaration(voiceProvider);
      const providerGeneration =
        voiceAuthority?.resolveProviderGeneration(voiceProvider);
      if (
        !voiceAuthority
        || !declaration
        || !providerGeneration
        || !voiceAuthority.isCurrent(voiceProvider)
      ) {
        return null;
      }
      return {
        agentGeneration: voiceAuthority.generation,
        providers: [{
          provider: voiceProvider,
          providerGeneration,
          declaration,
        }],
      };
    };
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        const snapshot = resolveSnapshot();
        if (!snapshot) {
          return {
            ok: false,
            error: {
              code: 'native_agent_privileged_effect_authority_unavailable',
              message: 'Voice authority is unavailable',
            },
          };
        }
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            ...snapshot,
          },
        };
      }
      if (request.operation.kind === 'voice.authority.waitRetired') {
        retirementWaitCount += 1;
        if (daemon === 'A') {
          daemon = 'B';
          currentRegistry = registryForAgentGeneration(
            'agent-generation-H',
          );
          throw Object.assign(
            new Error('daemon A replaced by daemon B'),
            {
              code:
                RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
            },
          );
        }
        const voiceAuthority =
          resolveRetainedAgentSessionRealtimeVoiceAuthority({
            runtimeRegistry: currentRegistry,
            retainedAgent: runnerFixture.binding,
          });
        const retirementSignal = voiceAuthority
          && voiceAuthority.isCurrent(voiceProvider)
          && voiceAuthority.resolveProviderGeneration(voiceProvider)
            === request.operation.providerGeneration
          ? voiceAuthority.resolveRetirementSignal(voiceProvider)
          : null;
        if (!retirementSignal || retirementSignal.aborted) {
          return {
            ok: true,
            result: {
              kind: 'voice.authority.retired',
              providerGeneration: request.operation.providerGeneration,
            },
          };
        }
        await new Promise<void>((resolve) => {
          retirementSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          ok: true,
          result: {
            kind: 'voice.authority.retired',
            providerGeneration: request.operation.providerGeneration,
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
    });
    const voice = facets.agentSessionRealtimeVoiceAuthority;

    await vi.waitFor(() => {
      expect(daemon).toBe('B');
      expect(retirementWaitCount).toBe(2);
      expect(voice?.isCurrent(voiceProvider)).toBe(true);
    });

    voiceProviderRetirement.abort(new Error('current Voice provider retired'));
    await vi.waitFor(() => {
      expect(voice?.isCurrent(voiceProvider)).toBe(false);
    });
    await facets.dispose();
  });

  it('admits a daemon snapshot declaration that does not declare Connected Services', async () => {
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch: async (input) => {
        const request = input.createRequest('A'.repeat(43));
        if (request.operation.kind !== 'voice.authority.snapshot') {
          throw new Error(`unexpected ${request.operation.kind}`);
        }
        const { settings: _settings, ...declaration } = voiceDeclaration();
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [{
              provider: voiceProvider,
              providerGeneration: 'voice-generation-1',
              declaration,
            }],
          },
        };
      },
    });
    const voice = facets.agentSessionRealtimeVoiceAuthority;

    expect(voice?.resolveDeclaration(voiceProvider)?.id).toBe(
      voiceProvider.localId,
    );
    expect(voice?.isCurrent(voiceProvider)).toBe(true);
    await facets.dispose();
  });

  it('reopens a daemon-owned follow from the last acknowledged cursor without reusing its expired admission deadline', async () => {
    let nowMs = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const admissionDeadlineAtMs = 16_000;
    const replacementProviderDeadlineAtMs = 47_000;
    const opens: Array<{
      followId: string;
      cursor?: string;
      initialReplay?: boolean;
      admissionDeadlineAtMs?: number;
    }> = [];
    let nextCount = 0;
    const pageTranscript = vi.fn(async () => ({
      items: [],
      nextCursor: null,
      tailCursor: 'cursor-2',
      hasMore: false,
      truncated: false,
    }));
    const events: string[] = [];
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [],
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.open') {
        opens.push({
          followId: request.operation.followId,
          ...(request.operation.cursor
            ? { cursor: request.operation.cursor }
            : {}),
          ...(request.operation.initialReplay
            ? { initialReplay: true }
            : {}),
          ...(request.operation.admissionDeadlineAtMs === undefined
            ? {}
            : { admissionDeadlineAtMs: request.operation.admissionDeadlineAtMs }),
        });
        if (opens.length === 2) {
          return {
            ok: true,
            result: {
              kind: 'external_session.follow.provider_request',
              followId: request.operation.followId,
              providerRequestId: 'daemon-b-provider-request',
              request: {
                kind: 'pageTranscript',
                source: { kind: 'syntheticSource', value: 'test' },
                remoteSessionId: 'remote-session-1',
                direction: 'older',
                maxBytes: 524_288,
                maxItems: 1,
                deadlineAtMs: replacementProviderDeadlineAtMs,
              },
            },
          };
        }
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.open',
            followId: request.operation.followId,
            result: {
              status: 'following',
              startingCursor:
                request.operation.cursor ?? 'cursor-1',
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.next') {
        if (request.operation.providerResponse) {
          expect(request.operation.providerResponse).toMatchObject({
            providerRequestId: 'daemon-b-provider-request',
            status: 'success',
            result: { kind: 'pageTranscript' },
          });
          return {
            ok: true,
            result: {
              kind: 'external_session.follow.open',
              followId: request.operation.followId,
              result: {
                status: 'following',
                startingCursor: 'cursor-2',
              },
            },
          };
        }
        nextCount += 1;
        if (nextCount === 1) {
          return {
            ok: true,
            result: {
              kind: 'external_session.follow.event',
              followId: request.operation.followId,
              eventId: 'event-a-1',
              event: {
                kind: 'data',
                items: [{
                  id: 'item-a-1',
                  kind: 'agent',
                  data: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'message', message: 'from daemon A' } },
                  },
                }],
                fromCursor: 'cursor-1',
                nextCursor: 'cursor-2',
              },
            },
          };
        }
        if (nextCount === 2) {
          nowMs = 32_000;
          throw Object.assign(
            new Error(
              'daemon A replaced by daemon B',
            ),
            {
              code:
                RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
            },
          );
        }
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.event',
            followId: request.operation.followId,
            eventId: 'event-b-1',
            event: {
              kind: 'terminated',
              reason: 'retired',
              cursor: 'cursor-2',
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.close') {
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.closed',
            followId: request.operation.followId,
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
      readActiveTurnAdmissionWitness: () => witness,
      resolveRetainedExternalSessionProviderOps: async () => ({
        validateSource: async ({ source }) => ({ ok: true, source }),
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
          source,
          remoteSessionId,
        }),
        pageTranscript,
        readAfterTranscript: async () => ({
          outcome: 'already_current',
        }),
      }),
    });
    const port =
      facets.externalSessionHostOperations.bindSession(
        runnerFixture.sessionId,
      );
    const follow = await port.executeProviderSessionFollow({
      agentId: runnerFixture.binding.localAgentId,
      providerSessionId: 'remote-session-1',
      options: {
        cursor: 'cursor-1',
        initialReplay: true,
        admissionDeadlineAtMs,
      },
      listener: async (event) => {
        events.push(event.kind);
      },
    });
    await vi.waitFor(() => {
      expect(events).toEqual(['data', 'terminated']);
    });
    expect(opens).toHaveLength(2);
    expect(opens[1]).toEqual({
      cursor: 'cursor-2',
      followId: expect.any(String),
    });
    expect(opens[1]?.followId).not.toBe(opens[0]?.followId);
    expect(pageTranscript).toHaveBeenCalledOnce();
    expect(pageTranscript).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAtMs: replacementProviderDeadlineAtMs,
    }));
    if (follow.status === 'following') {
      await follow.subscription.dispose();
    }
    await facets.dispose();
    now.mockRestore();
  });

  it('executes only the retained runner companion when the daemon follow owner requests transcript work', async () => {
    const admissionDeadlineAtMs = Date.now() + 30_000;
    let providerSignal: AbortSignal | undefined;
    const pageTranscript = vi.fn<
      RunnerAgentExternalSessionProviderOps['pageTranscript']
    >(async (request) => {
      providerSignal = request.signal;
      return {
      items: [],
      nextCursor: null,
      tailCursor: 'cursor-g',
      hasMore: false,
      truncated: false,
      };
    });
    const readAfterTranscript = vi.fn(async () => ({
      outcome: 'already_current' as const,
    }));
    const validateSource = vi.fn<
      RunnerAgentExternalSessionProviderOps['validateSource']
    >(async ({ source }) => ({
      ok: true as const,
      source,
    }));
    const resolveLinkIdentity = vi.fn<
      RunnerAgentExternalSessionProviderOps['resolveLinkIdentity']
    >(async (request) => ({
      source: request.source,
      remoteSessionId: request.remoteSessionId,
    }));
    const providerRequestId = 'provider-request-g';
    let openSettled = false;
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [],
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.open') {
        expect(request.operation).toMatchObject({
          initialReplay: true,
          admissionDeadlineAtMs,
        });
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.provider_request',
            followId: request.operation.followId,
            providerRequestId,
            request: {
              kind: 'pageTranscript',
              source: { kind: 'syntheticSource', value: 'g' },
              remoteSessionId: 'remote-session-1',
              direction: 'older',
              maxBytes: 524_288,
              maxItems: 1,
              deadlineAtMs: admissionDeadlineAtMs,
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.next') {
        if (!openSettled) {
          openSettled = true;
          expect(Reflect.get(request.operation, 'providerResponse'))
            .toMatchObject({
              providerRequestId,
              status: 'success',
              result: {
                kind: 'pageTranscript',
                value: { tailCursor: 'cursor-g' },
              },
            });
          return {
            ok: true,
            result: {
              kind: 'external_session.follow.open',
              followId: request.operation.followId,
              result: {
                status: 'following',
                startingCursor: 'cursor-g',
              },
            },
          };
        }
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.event',
            followId: request.operation.followId,
            eventId: 'event-g-terminal',
            event: {
              kind: 'terminated',
              reason: 'retired',
              cursor: 'cursor-g',
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.close') {
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.closed',
            followId: request.operation.followId,
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
        authority,
        dispatch,
        resolveRetainedExternalSessionProviderOps: async () => ({
          validateSource,
          resolveLinkIdentity,
          pageTranscript,
          readAfterTranscript,
        }),
      });
    const port = facets.externalSessionHostOperations.bindSession(
      runnerFixture.sessionId,
    );
    const events: string[] = [];
    const caller = new AbortController();
    const follow = await port.executeFollow({
      ref: {
        agentId: runnerFixture.binding.localAgentId,
        sourceId: 'default',
        remoteSessionId: 'remote-session-1',
      },
      source: { kind: 'syntheticSource', value: 'g' },
      options: {
        initialReplay: true,
        admissionDeadlineAtMs,
        signal: caller.signal,
      },
      listener: async (event) => {
        events.push(event.kind);
      },
    });
    expect(follow.status).toBe('following');
    await vi.waitFor(() => expect(events).toEqual(['terminated']));
    expect(pageTranscript).toHaveBeenCalledOnce();
    expect(pageTranscript).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAtMs: admissionDeadlineAtMs,
    }));
    expect(readAfterTranscript).not.toHaveBeenCalled();
    expect(providerSignal?.aborted).toBe(false);
    caller.abort(new Error('caller retired follow'));
    expect(providerSignal?.aborted).toBe(true);
    await facets.dispose();
  });

  it('closes the provisional daemon follow when the caller aborts during retained companion work', async () => {
    let providerSignal: AbortSignal | undefined;
    const pageTranscript = vi.fn<
      RunnerAgentExternalSessionProviderOps['pageTranscript']
    >(async (request) => {
      providerSignal = request.signal;
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(
          request.signal?.reason ?? new Error('provider request aborted'),
        );
        request.signal?.addEventListener('abort', abort, { once: true });
        if (request.signal?.aborted) abort();
      });
    });
    const provisionalFollowIds: string[] = [];
    const closedFollowIds: string[] = [];
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [],
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.open') {
        provisionalFollowIds.push(request.operation.followId);
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.provider_request',
            followId: request.operation.followId,
            providerRequestId: 'provider-request-abort',
            request: {
              kind: 'pageTranscript',
              source: { kind: 'syntheticSource', value: 'g' },
              remoteSessionId: 'remote-session-1',
              direction: 'older',
              maxBytes: 524_288,
              maxItems: 1,
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.next') {
        if (input.signal?.aborted) {
          throw new Error('aborted before follow.next reached the daemon');
        }
        throw new Error('follow.next unexpectedly reached the daemon');
      }
      if (request.operation.kind === 'external_session.follow.close') {
        closedFollowIds.push(request.operation.followId);
        expect(input.signal).toBeUndefined();
        expect(input.timeoutMs).toBe(6_000);
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.closed',
            followId: request.operation.followId,
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
      resolveRetainedExternalSessionProviderOps: async () => ({
        validateSource: vi.fn(async ({ source }) => ({
          ok: true as const,
          source,
        })),
        resolveLinkIdentity: vi.fn(async (request) => ({
          source: request.source,
          remoteSessionId: request.remoteSessionId,
        })),
        pageTranscript,
        readAfterTranscript: vi.fn(async () => ({
          outcome: 'already_current' as const,
        })),
      }),
    });
    const port = facets.externalSessionHostOperations.bindSession(
      runnerFixture.sessionId,
    );
    const caller = new AbortController();
    const pending = port.executeFollow({
      ref: {
        agentId: runnerFixture.binding.localAgentId,
        sourceId: 'default',
        remoteSessionId: 'remote-session-1',
      },
      source: { kind: 'syntheticSource', value: 'g' },
      options: { signal: caller.signal },
      listener: async () => undefined,
    });
    await vi.waitFor(() => expect(pageTranscript).toHaveBeenCalledOnce());
    caller.abort(new Error('caller aborted provisional follow'));
    await expect(pending).rejects.toThrow(
      'aborted before follow.next reached the daemon',
    );
    expect(providerSignal?.aborted).toBe(true);
    expect(provisionalFollowIds).toHaveLength(1);
    expect(closedFollowIds).toEqual(provisionalFollowIds);
    await facets.dispose();
  });

  it('closes the attempt-owned provisional follow when retained provider continuation fails', async () => {
    const provisionalFollowIds: string[] = [];
    const closedFollowIds: string[] = [];
    let providerContinuationCount = 0;
    let provisionalCloseAttempts = 0;
    const pageTranscript = vi.fn<
      RunnerAgentExternalSessionProviderOps['pageTranscript']
    >(async () => ({
      items: [],
      nextCursor: null,
      tailCursor: 'cursor-provisional',
      hasMore: false,
      truncated: false,
    }));
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [],
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.open') {
        provisionalFollowIds.push(request.operation.followId);
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.provider_request',
            followId: request.operation.followId,
            providerRequestId: 'provider-request-failed-continuation',
            request: {
              kind: 'pageTranscript',
              source: { kind: 'syntheticSource', value: 'g' },
              remoteSessionId: 'remote-session-1',
              direction: 'older',
              maxBytes: 524_288,
              maxItems: 1,
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.next') {
        providerContinuationCount += 1;
        return {
          ok: false,
          error: {
            code: 'plugin_external_follow_provider_failed',
            message: 'provider continuation failed',
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.close') {
        closedFollowIds.push(request.operation.followId);
        expect(input.signal).toBeUndefined();
        expect(input.timeoutMs).toBe(6_000);
        provisionalCloseAttempts += 1;
        if (provisionalCloseAttempts === 1) {
          throw new Error('provisional cleanup acknowledgement failed');
        }
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.closed',
            followId: request.operation.followId,
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
      resolveRetainedExternalSessionProviderOps: async () => ({
        validateSource: vi.fn(async ({ source }) => ({
          ok: true as const,
          source,
        })),
        resolveLinkIdentity: vi.fn(async (request) => ({
          source: request.source,
          remoteSessionId: request.remoteSessionId,
        })),
        pageTranscript,
        readAfterTranscript: vi.fn(async () => ({
          outcome: 'already_current' as const,
        })),
      }),
    });
    const port = facets.externalSessionHostOperations.bindSession(
      runnerFixture.sessionId,
    );

    await expect(port.executeFollow({
      ref: {
        agentId: runnerFixture.binding.localAgentId,
        sourceId: 'default',
        remoteSessionId: 'remote-session-1',
      },
      source: { kind: 'syntheticSource', value: 'g' },
      options: {},
      listener: async () => undefined,
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_provider_failed',
    });
    expect(pageTranscript).toHaveBeenCalledOnce();
    expect(providerContinuationCount).toBe(1);
    expect(provisionalFollowIds).toHaveLength(1);
    expect(closedFollowIds).toEqual(provisionalFollowIds);
    await port.retire();
    expect(closedFollowIds).toEqual([
      provisionalFollowIds[0],
      provisionalFollowIds[0],
    ]);
    await facets.dispose();
  });

  it('closes the trusted daemon-B candidate when its provider request carries a mismatched follow id', async () => {
    const openedFollowIds: string[] = [];
    const closedFollowIds: string[] = [];
    const untrustedResponseFollowId = 'untrusted-daemon-follow-id';
    const pageTranscript = vi.fn<
      RunnerAgentExternalSessionProviderOps['pageTranscript']
    >();
    let nextCount = 0;
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [],
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.open') {
        openedFollowIds.push(request.operation.followId);
        if (openedFollowIds.length === 1) {
          return {
            ok: true,
            result: {
              kind: 'external_session.follow.open',
              followId: request.operation.followId,
              result: {
                status: 'following',
                startingCursor: 'cursor-a',
              },
            },
          };
        }
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.provider_request',
            followId: untrustedResponseFollowId,
            providerRequestId: 'daemon-b-mismatched-provider-request',
            request: {
              kind: 'pageTranscript',
              source: { kind: 'syntheticSource', value: 'g' },
              remoteSessionId: 'remote-session-1',
              direction: 'older',
              maxBytes: 524_288,
              maxItems: 1,
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.next') {
        nextCount += 1;
        throw Object.assign(
          new Error('daemon A replaced by daemon B'),
          {
            code:
              RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
          },
        );
      }
      if (request.operation.kind === 'external_session.follow.close') {
        closedFollowIds.push(request.operation.followId);
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.closed',
            followId: request.operation.followId,
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
      resolveRetainedExternalSessionProviderOps: async () => ({
        validateSource: vi.fn(async ({ source }) => ({
          ok: true as const,
          source,
        })),
        resolveLinkIdentity: vi.fn(async (request) => ({
          source: request.source,
          remoteSessionId: request.remoteSessionId,
        })),
        pageTranscript,
        readAfterTranscript: vi.fn(async () => ({
          outcome: 'already_current' as const,
        })),
      }),
    });
    const port = facets.externalSessionHostOperations.bindSession(
      runnerFixture.sessionId,
    );
    const follow = await port.executeProviderSessionFollow({
      agentId: runnerFixture.binding.localAgentId,
      providerSessionId: 'provider-session-daemon-b-mismatch',
      options: {},
      listener: async () => undefined,
    });
    expect(follow.status).toBe('following');
    if (follow.status !== 'following') {
      throw new Error('expected active provider follow');
    }

    await expect(follow.failure).resolves.toMatchObject({
      code: RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
    });
    await vi.waitFor(() => expect(closedFollowIds).toHaveLength(2));
    expect(openedFollowIds).toHaveLength(2);
    expect(nextCount).toBe(1);
    expect(pageTranscript).not.toHaveBeenCalled();
    expect(closedFollowIds).toEqual([
      openedFollowIds[1],
      openedFollowIds[0],
    ]);
    expect(closedFollowIds).not.toContain(untrustedResponseFollowId);
    await facets.dispose();
  });

  it('bounds close transport to six seconds and retirement retries the same follow id once', async () => {
    vi.useFakeTimers();
    try {
      const closeFollowIds: string[] = [];
      const closeTimeouts: Array<number | null | undefined> = [];
      let closeCount = 0;
      const dispatch = vi.fn(async (input): Promise<
        AgentRuntimeDaemonServiceResponseV1
      > => {
        const request = input.createRequest('A'.repeat(43));
        if (request.operation.kind === 'voice.authority.snapshot') {
          return {
            ok: true,
            result: {
              kind: 'voice.authority.snapshot',
              agentGeneration: runnerFixture.binding.immutableGenerationId,
              providers: [],
            },
          };
        }
        if (request.operation.kind === 'external_session.follow.open') {
          return {
            ok: true,
            result: {
              kind: 'external_session.follow.open',
              followId: request.operation.followId,
              result: {
                status: 'following',
                startingCursor: null,
              },
            },
          };
        }
        if (request.operation.kind === 'external_session.follow.next') {
          return await new Promise<AgentRuntimeDaemonServiceResponseV1>(
            () => undefined,
          );
        }
        if (request.operation.kind === 'external_session.follow.close') {
          closeCount += 1;
          closeFollowIds.push(request.operation.followId);
          closeTimeouts.push(input.timeoutMs);
          return await new Promise<AgentRuntimeDaemonServiceResponseV1>(
            (resolve) => {
              setTimeout(() => {
                resolve(
                  closeCount === 1
                    ? {
                        ok: false,
                        error: {
                          code: 'plugin_external_follow_close_unknown',
                          message: 'close acknowledgement was lost',
                        },
                      }
                    : {
                        ok: true,
                        result: {
                          kind: 'external_session.follow.closed',
                          followId: request.operation.followId,
                        },
                      },
                );
              }, input.timeoutMs ?? 300_000);
            },
          );
        }
        throw new Error(`unexpected ${request.operation.kind}`);
      });
      const facets = await createRunnerAgentDaemonFacets({
        authority,
        dispatch,
      });
      const port =
        facets.externalSessionHostOperations.bindSession(
          runnerFixture.sessionId,
        );
      const follow = await port.executeProviderSessionFollow({
        agentId: runnerFixture.binding.localAgentId,
        providerSessionId: 'provider-session-close-retry',
        options: {},
        listener: async () => undefined,
      });
      expect(follow.status).toBe('following');
      if (follow.status !== 'following') {
        throw new Error('expected active provider follow');
      }

      let explicitOutcome = 'pending';
      const explicitClose = Promise.resolve(
        follow.subscription.dispose(),
      ).then(
        () => {
          explicitOutcome = 'resolved';
        },
        () => {
          explicitOutcome = 'rejected';
        },
      );
      let retirementOutcome = 'pending';
      const retirement = port.retire().then(() => {
        retirementOutcome = 'resolved';
      });

      await vi.advanceTimersByTimeAsync(5_999);
      expect(explicitOutcome).toBe('pending');
      expect(retirementOutcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      await explicitClose;
      expect(explicitOutcome).toBe('rejected');
      expect(retirementOutcome).toBe('pending');
      expect(closeFollowIds).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(6_000);
      await retirement;
      expect(retirementOutcome).toBe('resolved');
      expect(closeTimeouts).toEqual([6_000, 6_000]);
      expect(new Set(closeFollowIds).size).toBe(1);
      expect(closeCount).toBe(2);
      await facets.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a stale daemon A follow response after rebinding the follow to daemon B', async () => {
    const opens: string[] = [];
    const closes: string[] = [];
    const events: string[] = [];
    let nextCount = 0;
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [],
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.open') {
        opens.push(request.operation.followId);
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.open',
            followId: request.operation.followId,
            result: {
              status: 'following',
              startingCursor: 'cursor-1',
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.next') {
        nextCount += 1;
        if (nextCount === 1) {
          throw Object.assign(
            new Error('daemon A replaced by daemon B'),
            {
              code:
                RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
            },
          );
        }
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.event',
            followId: opens[0]!,
            eventId: 'stale-event-a',
            event: {
              kind: 'terminated',
              reason: 'retired',
              cursor: 'cursor-1',
            },
          },
        };
      }
      if (request.operation.kind === 'external_session.follow.close') {
        closes.push(request.operation.followId);
        return {
          ok: true,
          result: {
            kind: 'external_session.follow.closed',
            followId: request.operation.followId,
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
    });
    const port =
      facets.externalSessionHostOperations.bindSession(
        runnerFixture.sessionId,
      );
    const follow = await port.executeFollow({
      ref: {
        agentId: runnerFixture.binding.localAgentId,
        sourceId: 'default',
        remoteSessionId: 'remote-session-1',
      },
      source: { kind: 'syntheticSource', value: 'test' },
      options: { cursor: 'cursor-1' },
      listener: async (event) => {
        events.push(event.kind);
      },
    });
    await vi.waitFor(() => {
      expect(closes).toHaveLength(1);
    });
    expect(opens).toHaveLength(2);
    expect(closes).toEqual([opens[1]]);
    expect(events).toEqual(['terminated']);
    if (follow.status === 'following') {
      await follow.subscription.dispose();
    }
    await facets.dispose();
  });

  it('retires Voice when daemon B reports hard Agent revocation and does not retry without a proven authority transition', async () => {
    let retirementWaitCount = 0;
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind === 'voice.authority.snapshot') {
        return {
          ok: true,
          result: {
            kind: 'voice.authority.snapshot',
            agentGeneration: runnerFixture.binding.immutableGenerationId,
            providers: [{
              provider: voiceProvider,
              providerGeneration: 'voice-generation-1',
              declaration: voiceDeclaration(),
            }],
          },
        };
      }
      if (
        request.operation.kind
          === 'voice.authority.waitRetired'
      ) {
        retirementWaitCount += 1;
        return {
          ok: false,
          error: {
            code:
              'native_agent_privileged_effect_authority_unavailable',
            message: 'retained Agent hard-revoked without a proven rotation',
          },
        };
      }
      throw new Error(`unexpected ${request.operation.kind}`);
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
    });
    const voice = facets.agentSessionRealtimeVoiceAuthority;
    await vi.waitFor(() => {
      expect(voice?.isCurrent(voiceProvider)).toBe(false);
    });
    expect(retirementWaitCount).toBe(1);
    await facets.dispose();
  });

  it('retries an initial Voice snapshot only after an exact daemon authority transition', async () => {
    let snapshotCount = 0;
    const dispatch = vi.fn(async (input): Promise<
      AgentRuntimeDaemonServiceResponseV1
    > => {
      const request = input.createRequest('A'.repeat(43));
      if (request.operation.kind !== 'voice.authority.snapshot') {
        throw new Error(`unexpected ${request.operation.kind}`);
      }
      snapshotCount += 1;
      if (snapshotCount === 1) {
        throw Object.assign(
          new Error('daemon A replaced by daemon B'),
          {
            code:
              RUNNER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_TRANSITION_CODE,
          },
        );
      }
      return {
        ok: true,
        result: {
          kind: 'voice.authority.snapshot',
          agentGeneration: runnerFixture.binding.immutableGenerationId,
          providers: [],
        },
      };
    });
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch,
    });
    expect(snapshotCount).toBe(2);
    expect(facets.agentSessionRealtimeVoiceAuthority)
      .not.toBeNull();
    await facets.dispose();
  });

  it('fails closed when the daemon snapshot does not match the admitted Agent generation', async () => {
    const facets = await createRunnerAgentDaemonFacets({
      authority,
      dispatch: async () => ({
        ok: true,
        result: {
          kind: 'voice.authority.snapshot',
          agentGeneration: 'other-generation',
          providers: [],
        },
      }),
    });
    expect(facets.agentSessionRealtimeVoiceAuthority).toBeNull();
  });
});
