import { describe, expect, it, vi } from 'vitest';

import {
  createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
  createExternalSessionHostOperationOwner,
  type ExternalSessionHostOperationSet,
  type ExternalSessionHostOperationPort,
} from '@/session/external/hostOperationOwner';
import type {
  HostExternalTranscriptFollowEvent,
} from '@/session/external/privateContract';
import {
  createRunnerAgentDaemonFacetService,
} from './runnerAgentDaemonFacetService';

const sessionId = 'session-1';
const retainedAgent = createAgentSessionRunnerFactoryBinding({
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
});
const runner = {
  pid: 123,
  processStartTimeMs: 1_000,
  processCommandHash: 'b'.repeat(64),
  snapshotIdentity: 'snapshot-1',
};
const direct = Object.freeze({ sessionId, runner, retainedAgent });

const source = { kind: 'syntheticSource', value: 'test' } as const;
const ref = {
  agentId: 'acme',
  sourceId: 'default',
  remoteSessionId: 'remote-session-1',
} as const;
const witness = {
  turnId: 'turn-1',
  inputId: 'input-1',
  userMessageSeq: 7,
  userMessageSeqs: [7],
};

function createDeferred<T = void>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return Object.freeze({ promise, resolve });
}

type ServiceInput = Parameters<typeof createRunnerAgentDaemonFacetService>[0];

type SetupOptions = Readonly<{
  authorizeCurrent?: ServiceInput['authorizeCurrent'];
  resolveRetainedExternalSessionAgentContribution?:
    NonNullable<
      ServiceInput['resolveRetainedExternalSessionAgentContribution']
    >;
}>;

async function setup(options: SetupOptions = {}) {
  const privateOwner = createExternalSessionHostOperationOwner();
  const boundPortRetirements: Array<ReturnType<typeof vi.fn>> = [];
  const bindPrivateExternalSession = vi.fn(
    (binding: Parameters<ServiceInput['externalSessionHostOperationOwner']['bind']>[0]) => {
      const port = privateOwner.bind(binding);
      const retire = vi.fn(port.retire);
      boundPortRetirements.push(retire);
      return Object.freeze({
        executeFollow: port.executeFollow,
        executeProviderSessionFollow: port.executeProviderSessionFollow,
        retire,
      }) satisfies ExternalSessionHostOperationPort;
    },
  );
  let followListener:
    | ((event: HostExternalTranscriptFollowEvent) => void | Promise<void>)
    | null = null;
  const disposeFollow = vi.fn(async () => undefined);
  const executeFollow = vi.fn<
    NonNullable<
      ExternalSessionHostOperationSet['followOperation']
    >['execute']
  >(async (request) => {
    followListener = request.listener;
    return {
      status: 'following' as const,
      startingCursor: request.options.cursor ?? null,
      subscription: { dispose: disposeFollow },
    };
  });
  const operations: ExternalSessionHostOperationSet = {
    followOperation: {
      execute: executeFollow,
    },
    followTargetOperation: null,
  };
  await privateOwner.install(operations);
  let current = true;
  const snapshotVoiceAuthority = vi.fn(async () => ({
    agentGeneration: retainedAgent.immutableGenerationId,
    providers: [],
  }));
  const waitVoiceAuthorityRetired = vi.fn(async () => undefined);
  const currentExternalSessionProviderOps = {
    validateSource: vi.fn(async ({ source }) => ({
      ok: true as const,
      source,
    })),
    listCandidates: vi.fn(async () => ({
      candidates: [{
        remoteSessionId: 'current-h-session',
        updatedAtMs: 1,
      }],
      nextCursor: null,
    })),
    resolveLinkIdentity: vi.fn(async ({ source, remoteSessionId }) => ({
      source,
      remoteSessionId,
    })),
    canonicalizeLinkedSession: vi.fn(async ({ source, remoteSessionId }) => ({
      source,
      remoteSessionId,
    })),
    pageTranscript: vi.fn(async () => ({
      items: [],
      nextCursor: null,
      tailCursor: null,
      hasMore: false,
      truncated: false,
    })),
    readAfterTranscript: vi.fn(async () => ({
      outcome: 'already_current' as const,
    })),
  };
  let currentExternalSessionAvailable = true;
  const resolveCurrentExternalSessionProviderOps = vi.fn(
    async () => currentExternalSessionAvailable
      ? currentExternalSessionProviderOps
      : null,
  );
  const authorizeActiveTurn = vi.fn<
    Parameters<typeof createRunnerAgentDaemonFacetService>[0]['authorizeActiveTurn']
  >(
    async (input) =>
      input.sessionId === sessionId
      && input.runner === runner
      && input.retainedAgent === retainedAgent
      && input.witness.turnId === witness.turnId
      && input.witness.inputId === witness.inputId
      && input.witness.userMessageSeq
        === witness.userMessageSeq
      && JSON.stringify(input.witness.userMessageSeqs)
        === JSON.stringify(witness.userMessageSeqs),
  );
  const authorizeCurrent = vi.fn<ServiceInput['authorizeCurrent']>(
    options.authorizeCurrent
    ?? (async (input) =>
      current
      && input.sessionId === sessionId
      && input.runner === runner
      && input.retainedAgent === retainedAgent),
  );
  const service = createRunnerAgentDaemonFacetService({
    externalSessionHostOperationOwner: {
      bind: bindPrivateExternalSession,
      install: privateOwner.install,
      canFollowNow: privateOwner.canFollowNow,
      retire: privateOwner.retire,
    },
    machineId: 'machine-1',
    readAccountRevision: () => 'account-revision-1',
    authorizeCurrent,
    authorizeActiveTurn,
    resolveCurrentExternalSessionProviderOps,
    ...(options.resolveRetainedExternalSessionAgentContribution
      ? {
          resolveRetainedExternalSessionAgentContribution:
            options.resolveRetainedExternalSessionAgentContribution,
        }
      : {}),
    snapshotVoiceAuthority,
    waitVoiceAuthorityRetired,
  });
  return {
    service,
    operations,
    executeFollow,
    disposeFollow,
    snapshotVoiceAuthority,
    waitVoiceAuthorityRetired,
    authorizeActiveTurn,
    authorizeCurrent,
    bindPrivateExternalSession,
    boundPortRetirements,
    currentExternalSessionProviderOps,
    resolveCurrentExternalSessionProviderOps,
    emitFollow: async (event: HostExternalTranscriptFollowEvent) => {
      if (!followListener) throw new Error('follow listener unavailable');
      await followListener(event);
    },
    setCurrent(value: boolean) {
      current = value;
    },
    setCurrentExternalSessionAvailable(value: boolean) {
      currentExternalSessionAvailable = value;
    },
  };
}

describe('runner Agent daemon-owned facet service', () => {
  it('authorizes retained G but resolves the six-operation External Session surface through current H per call', async () => {
    const fixture = await setup();
    fixture.setCurrent(false);
    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.current.list_candidates',
        requestId: 'current-list-1',
        agentId: retainedAgent.agentId,
        source,
        limit: 20,
        witness,
      },
    })).resolves.toEqual({
      kind: 'external_session.current.list_candidates',
      result: {
        candidates: [{
          remoteSessionId: 'current-h-session',
          updatedAtMs: 1,
        }],
        nextCursor: null,
      },
    });
    expect(fixture.authorizeActiveTurn).toHaveBeenCalledWith({
      ...direct,
      witness,
    });
    expect(
      fixture.resolveCurrentExternalSessionProviderOps,
    ).toHaveBeenCalledWith(retainedAgent.agentId);
    expect(
      fixture.currentExternalSessionProviderOps.listCandidates,
    ).toHaveBeenCalledWith({
      source,
      limit: 20,
    });
    const remainingOperations = [
      {
        kind: 'external_session.current.resolve_source',
        requestId: 'current-source-1',
        agentId: retainedAgent.agentId,
        source,
        witness,
      },
      {
        kind: 'external_session.current.resolve_link_identity',
        requestId: 'current-link-1',
        agentId: retainedAgent.agentId,
        source,
        remoteSessionId: 'remote-session-1',
        witness,
      },
      {
        kind: 'external_session.current.resolve_linked_identity',
        requestId: 'current-linked-1',
        agentId: retainedAgent.agentId,
        source,
        remoteSessionId: 'remote-session-1',
        metadata: {},
        witness,
      },
      {
        kind: 'external_session.current.page_transcript',
        requestId: 'current-page-1',
        agentId: retainedAgent.agentId,
        source,
        remoteSessionId: 'remote-session-1',
        direction: 'older',
        maxBytes: 65_536,
        maxItems: 100,
        witness,
      },
      {
        kind: 'external_session.current.read_after_transcript',
        requestId: 'current-after-1',
        agentId: retainedAgent.agentId,
        source,
        remoteSessionId: 'remote-session-1',
        cursor: 'cursor-1',
        maxBytes: 65_536,
        maxItems: 100,
        witness,
      },
    ] as const;
    for (const operation of remainingOperations) {
      await expect(fixture.service.dispatch({
        ...direct,
        operation,
      })).resolves.toMatchObject({ kind: operation.kind });
    }
    expect(fixture.bindPrivateExternalSession).not.toHaveBeenCalled();

    fixture.setCurrentExternalSessionAvailable(false);
    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.current.resolve_source',
        requestId: 'current-source-unavailable',
        agentId: retainedAgent.agentId,
        source,
        witness,
      },
    })).rejects.toThrow(
      'agent_runtime_daemon_current_external_session_unavailable',
    );
  });

  it('reuses one exact private binding for concurrent cold follows and retires it when G stops being current', async () => {
    const contributionEntered = createDeferred();
    const releaseContribution = createDeferred();
    const resolveRetainedExternalSessionAgentContribution = vi.fn(
      async () => {
        contributionEntered.resolve();
        await releaseContribution.promise;
        return null;
      },
    );
    const fixture = await setup({
      resolveRetainedExternalSessionAgentContribution,
    });
    const first = fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'cold-open-1',
        followId: 'cold-follow-1',
        target: { kind: 'externalSession', ref, source },
      },
    });
    await contributionEntered.promise;
    const second = fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'cold-open-2',
        followId: 'cold-follow-2',
        target: { kind: 'externalSession', ref, source },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolveRetainedExternalSessionAgentContribution)
      .toHaveBeenCalledTimes(1);

    releaseContribution.resolve();
    await expect(first).resolves.toMatchObject({
      kind: 'external_session.follow.open',
      followId: 'cold-follow-1',
    });
    await expect(second).resolves.toMatchObject({
      kind: 'external_session.follow.open',
      followId: 'cold-follow-2',
    });
    expect(fixture.bindPrivateExternalSession).toHaveBeenCalledTimes(1);

    fixture.setCurrent(false);
    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.next',
        requestId: 'cold-retirement',
        followId: 'cold-follow-1',
      },
    })).rejects.toThrow(
      'agent_runtime_daemon_service_generation_not_current',
    );
    expect(fixture.boundPortRetirements).toHaveLength(1);
    expect(fixture.boundPortRetirements[0]).toHaveBeenCalledTimes(1);
  });

  it('cancels a stale cold private binding when service disposal wins during contribution resolution', async () => {
    const contributionEntered = createDeferred();
    const releaseContribution = createDeferred();
    const fixture = await setup({
      resolveRetainedExternalSessionAgentContribution: async () => {
        contributionEntered.resolve();
        await releaseContribution.promise;
        return null;
      },
    });
    const opening = fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'stale-during-contribution',
        followId: 'stale-during-contribution',
        target: { kind: 'externalSession', ref, source },
      },
    });
    await contributionEntered.promise;
    fixture.setCurrent(false);
    await fixture.service.dispose();
    releaseContribution.resolve();

    await expect(opening).rejects.toThrow(
      'agent_runtime_daemon_service_generation_not_current',
    );
    expect(fixture.bindPrivateExternalSession).not.toHaveBeenCalled();
  });

  it('retires the exact losing private candidate once before a concurrent successor binding becomes reachable', async () => {
    const successor = {
      ...retainedAgent,
      immutableGenerationId: 'generation-2',
    };
    const contributionEntered = createDeferred();
    const releaseContribution = createDeferred();
    const fixture = await setup({
      authorizeCurrent: async (input) =>
        input.sessionId === sessionId
        && input.runner === runner
        && (
          input.retainedAgent === retainedAgent
          || input.retainedAgent === successor
        ),
      resolveRetainedExternalSessionAgentContribution: async () => {
        contributionEntered.resolve();
        await releaseContribution.promise;
        return null;
      },
    });
    const first = fixture.service.dispatch({
      sessionId,
      runner,
      retainedAgent,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'candidate-a',
        followId: 'candidate-a',
        target: { kind: 'externalSession', ref, source },
      },
    });
    await contributionEntered.promise;
    const second = fixture.service.dispatch({
      sessionId,
      runner,
      retainedAgent: successor,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'candidate-b',
        followId: 'candidate-b',
        target: { kind: 'externalSession', ref, source },
      },
    });
    releaseContribution.resolve();

    await first.catch(() => undefined);
    await expect(second).resolves.toMatchObject({
      kind: 'external_session.follow.open',
      followId: 'candidate-b',
    });
    expect(fixture.boundPortRetirements).toHaveLength(2);
    expect(fixture.boundPortRetirements[0]).toHaveBeenCalledTimes(1);
    expect(fixture.boundPortRetirements[1]).not.toHaveBeenCalled();

    await fixture.service.dispose();
    expect(fixture.boundPortRetirements[0]).toHaveBeenCalledTimes(1);
    expect(fixture.boundPortRetirements[1]).toHaveBeenCalledTimes(1);
  });

  it('keeps one acknowledged follow event in daemon custody and closes explicitly', async () => {
    const fixture = await setup();
    await expect(
      fixture.service.dispatch({
        ...direct,
        operation: {
          kind: 'external_session.follow.open',
          requestId: 'follow-open-1',
          followId: 'follow-1',
          target: {
            kind: 'externalSession',
            ref,
            source,
          },
          cursor: 'cursor-1',
        },
      }),
    ).resolves.toEqual({
      kind: 'external_session.follow.open',
      followId: 'follow-1',
      result: {
        status: 'following',
        startingCursor: 'cursor-1',
      },
    });

    let listenerSettled = false;
    const emitted = fixture.emitFollow({
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
    }).then(() => {
      listenerSettled = true;
    });
    await Promise.resolve();

    const delivered = await fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.next',
        requestId: 'follow-next-1',
        followId: 'follow-1',
      },
    });
    expect(delivered).toMatchObject({
      kind: 'external_session.follow.event',
      followId: 'follow-1',
      event: {
        kind: 'data',
        nextCursor: 'cursor-2',
      },
    });
    expect(listenerSettled).toBe(false);

    const acknowledgedEventId =
      delivered.kind === 'external_session.follow.event'
        ? delivered.eventId
        : undefined;
    const next = fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.next',
        requestId: 'follow-next-2',
        followId: 'follow-1',
        acknowledgeEventId: acknowledgedEventId,
      },
    });
    await Promise.resolve();
    await expect(
      fixture.service.dispatch({
        ...direct,
        operation: {
          kind: 'external_session.follow.close',
          requestId: 'follow-close-1',
          followId: 'follow-1',
          acknowledgeEventId: acknowledgedEventId,
        },
      }),
    ).resolves.toEqual({
      kind: 'external_session.follow.closed',
      followId: 'follow-1',
    });
    await expect(next).resolves.toEqual({
      kind: 'external_session.follow.closed',
      followId: 'follow-1',
    });
    await emitted;
    expect(listenerSettled).toBe(true);
    expect(fixture.disposeFollow).toHaveBeenCalledOnce();
  });

  it('publishes follow.open before an event emitted during async registration', async () => {
    const fixture = await setup();
    fixture.executeFollow.mockImplementationOnce(
      async (request) => {
        await request.listener({
          kind: 'data',
          items: [{
            id: 'registration-item',
            kind: 'agent',
            data: {
              role: 'agent',
              content: { type: 'codex', data: { type: 'message', message: 'registered' } },
            },
          }],
          fromCursor: null,
          nextCursor: 'registration-cursor',
        });
        return {
          status: 'following' as const,
          startingCursor: null,
          subscription: { dispose: async () => undefined },
        };
      },
    );

    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'registration-open',
        followId: 'registration-follow',
        target: { kind: 'externalSession', ref, source },
      },
    })).resolves.toEqual({
      kind: 'external_session.follow.open',
      followId: 'registration-follow',
      result: { status: 'following', startingCursor: null },
    });
    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.next',
        requestId: 'registration-next',
        followId: 'registration-follow',
      },
    })).resolves.toMatchObject({
      kind: 'external_session.follow.event',
      followId: 'registration-follow',
      event: { kind: 'data', nextCursor: 'registration-cursor' },
    });
  });

  it('aborts and removes a follow while its provider request is pending', async () => {
    const fixture = await setup();
    let first = true;
    let providerRejected = false;
    fixture.executeFollow.mockImplementation(
      async (request) => {
        if (!first) {
          return {
            status: 'following' as const,
            startingCursor: null,
            subscription: { dispose: async () => undefined },
          };
        }
        first = false;
        try {
          await request.providerOps?.pageTranscript({
            source: request.source,
            remoteSessionId: request.ref.remoteSessionId,
            direction: 'older',
            maxBytes: 524_288,
            maxItems: 1,
            signal: request.options.signal,
          });
          throw new Error('pending provider request unexpectedly resolved');
        } catch (error) {
          providerRejected = true;
          throw error;
        }
      },
    );
    const controller = new AbortController();
    const pending = await fixture.service.dispatch({
      ...direct,
      signal: controller.signal,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'abort-open',
        followId: 'abort-follow',
        target: { kind: 'externalSession', ref, source },
      },
    });
    expect(pending).toMatchObject({
      kind: 'external_session.follow.provider_request',
      followId: 'abort-follow',
    });
    controller.abort(new Error('caller aborted follow'));
    await vi.waitFor(() => expect(providerRejected).toBe(true));

    const providerRequestId = pending.kind
      === 'external_session.follow.provider_request'
      ? pending.providerRequestId
      : 'missing-provider-request';
    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.next',
        requestId: 'late-provider-response',
        followId: 'abort-follow',
        providerResponse: {
          providerRequestId,
          status: 'success',
          result: {
            kind: 'pageTranscript',
            value: {
              items: [],
              nextCursor: null,
              tailCursor: null,
              hasMore: false,
              truncated: false,
            },
          },
        },
      },
    })).rejects.toThrow('plugin_external_follow_unavailable');
    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'reopen-after-abort',
        followId: 'abort-follow',
        target: { kind: 'externalSession', ref, source },
      },
    })).resolves.toMatchObject({
      kind: 'external_session.follow.open',
      followId: 'abort-follow',
    });
  });

  it('retains the exact follow after source disposal rejects so the same close id can retry', async () => {
    const fixture = await setup();
    fixture.disposeFollow.mockRejectedValueOnce(
      new Error('source disposal rejected'),
    );
    await fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'follow-open-retry',
        followId: 'follow-retry',
        target: {
          kind: 'externalSession',
          ref,
          source,
        },
      },
    });

    const close = (requestId: string) =>
      fixture.service.dispatch({
        ...direct,
        operation: {
          kind: 'external_session.follow.close' as const,
          requestId,
          followId: 'follow-retry',
        },
      });
    await expect(close('follow-close-rejected')).rejects.toThrow(
      'source disposal rejected',
    );
    await expect(close('follow-close-retry')).resolves.toEqual({
      kind: 'external_session.follow.closed',
      followId: 'follow-retry',
    });
    await expect(close('follow-close-idempotent')).resolves.toEqual({
      kind: 'external_session.follow.closed',
      followId: 'follow-retry',
    });
    expect(fixture.disposeFollow).toHaveBeenCalledTimes(2);
  });

  it('continues one retained follow only with the exact active-turn witness and closes on mismatch', async () => {
    const fixture = await setup();
    await fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'follow-open-retained',
        followId: 'follow-retained',
        target: {
          kind: 'externalSession',
          ref,
          source,
        },
      },
    });
    fixture.setCurrent(false);
    const emitted = fixture.emitFollow({
      kind: 'data',
      items: [{
        id: 'item-retained',
        kind: 'agent',
        data: {
          role: 'agent',
          content: { type: 'codex', data: { type: 'message', message: 'retained' } },
        },
      }],
      fromCursor: null,
      nextCursor: 'cursor-retained',
    });
    const delivered = await fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.next',
        requestId: 'follow-next-retained',
        followId: 'follow-retained',
        witness,
      },
    });
    expect(delivered).toMatchObject({
      kind: 'external_session.follow.event',
      followId: 'follow-retained',
    });
    expect(fixture.authorizeActiveTurn).toHaveBeenCalledWith({
      ...direct,
      witness,
    });

    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.next',
        requestId: 'follow-next-stale-witness',
        followId: 'follow-retained',
        acknowledgeEventId:
          delivered.kind === 'external_session.follow.event'
            ? delivered.eventId
            : undefined,
        witness: {
          ...witness,
          turnId: 'turn-other',
        },
      },
    })).rejects.toThrow(
      'agent_runtime_daemon_service_generation_not_current',
    );
    await emitted;
    expect(fixture.disposeFollow).toHaveBeenCalledOnce();
  });

  it('snapshots Voice authority and waits on the exact provider generation only after currentness admission', async () => {
    const fixture = await setup();
    await expect(
      fixture.service.dispatch({
        ...direct,
        operation: {
          kind: 'voice.authority.snapshot',
          requestId: 'voice-snapshot-1',
        },
      }),
    ).resolves.toEqual({
      kind: 'voice.authority.snapshot',
      agentGeneration: retainedAgent.immutableGenerationId,
      providers: [],
    });
    expect(fixture.snapshotVoiceAuthority).toHaveBeenCalledWith(direct);

    const provider = {
      pluginId: 'happier.voice.elevenlabs',
      localId: 'conversation',
    } as const;
    await expect(
      fixture.service.dispatch({
        ...direct,
        operation: {
          kind: 'voice.authority.waitRetired',
          requestId: 'voice-retired-1',
          provider,
          providerGeneration: 'voice-generation-1',
          witness,
        },
      }),
    ).resolves.toEqual({
      kind: 'voice.authority.retired',
      providerGeneration: 'voice-generation-1',
    });
    expect(fixture.waitVoiceAuthorityRetired).toHaveBeenCalledWith({
      ...direct,
      provider,
      providerGeneration: 'voice-generation-1',
      signal: undefined,
    });
  });

  it('keeps an exact retained Voice retirement wait authorized by its active-turn witness', async () => {
    const fixture = await setup();
    fixture.setCurrent(false);
    const provider = {
      pluginId: 'happier.voice.elevenlabs',
      localId: 'conversation',
    } as const;
    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'voice.authority.waitRetired',
        requestId: 'voice-retained-1',
        provider,
        providerGeneration: 'voice-generation-1',
        witness,
      },
    })).resolves.toEqual({
      kind: 'voice.authority.retired',
      providerGeneration: 'voice-generation-1',
    });
    expect(fixture.authorizeActiveTurn).toHaveBeenCalledWith({
      ...direct,
      witness,
    });
  });
});
