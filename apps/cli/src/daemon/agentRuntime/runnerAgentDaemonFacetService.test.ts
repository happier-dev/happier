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
  executeFollow?: NonNullable<
    ExternalSessionHostOperationSet['followOperation']
  >['execute'];
}>

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
  >(options.executeFollow ?? (async (request) => {
    followListener = request.listener;
    return {
      status: 'following' as const,
      startingCursor: request.options.cursor ?? null,
      subscription: { dispose: disposeFollow },
    };
  }));
  const setFollowListener = (
    listener: ((event: HostExternalTranscriptFollowEvent) => void | Promise<void>) | null,
  ): void => {
    followListener = listener;
  };
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
    setFollowListener,
    snapshotVoiceAuthority,
    waitVoiceAuthorityRetired,
    authorizeActiveTurn,
    authorizeCurrent,
    bindPrivateExternalSession,
    boundPortRetirements,
    emitFollow: async (event: HostExternalTranscriptFollowEvent) => {
      if (!followListener) throw new Error('follow listener unavailable');
      await followListener(event);
    },
    setCurrent(value: boolean) {
      current = value;
    },
  };
}

describe('runner Agent daemon-owned facet service', () => {
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

  it('lets an aborted caller stop waiting without cancelling the shared cold binding', async () => {
    const contributionEntered = createDeferred();
    const releaseContribution = createDeferred();
    const fixture = await setup({
      resolveRetainedExternalSessionAgentContribution: async () => {
        contributionEntered.resolve();
        await releaseContribution.promise;
        return null;
      },
    });
    const caller = new AbortController();
    const opening = fixture.service.dispatch({
      ...direct,
      signal: caller.signal,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'aborted-cold-open',
        followId: 'aborted-cold-open',
        target: { kind: 'externalSession', ref, source },
      },
    });
    await contributionEntered.promise;
    caller.abort();

    await expect(opening).rejects.toThrow('plugin_operation_aborted');
    expect(fixture.bindPrivateExternalSession).not.toHaveBeenCalled();

    releaseContribution.resolve();
    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'joined-cold-open',
        followId: 'joined-cold-open',
        target: { kind: 'externalSession', ref, source },
      },
    })).resolves.toMatchObject({
      kind: 'external_session.follow.open',
      followId: 'joined-cold-open',
    });
    expect(fixture.bindPrivateExternalSession).toHaveBeenCalledTimes(1);
  });

  it('retires the exact losing private candidate once before a concurrent successor binding becomes reachable', async () => {
    const successor = {
      ...retainedAgent,
      immutableGenerationId: 'generation-2',
    };
    const contributionEntered = createDeferred();
    const releaseContribution = createDeferred();
    let resolutions = 0;
    const fixture = await setup({
      authorizeCurrent: async (input) =>
        input.sessionId === sessionId
        && input.runner === runner
        && (
          input.retainedAgent === retainedAgent
          || input.retainedAgent === successor
        ),
      resolveRetainedExternalSessionAgentContribution: async () => {
        resolutions += 1;
        if (resolutions === 1) {
          contributionEntered.resolve();
          await releaseContribution.promise;
        }
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
    await expect(second).resolves.toMatchObject({
      kind: 'external_session.follow.open',
      followId: 'candidate-b',
    });
    await expect(first).rejects.toThrow(
      'agent_runtime_daemon_service_generation_not_current',
    );
    expect(fixture.bindPrivateExternalSession).toHaveBeenCalledTimes(1);
    expect(fixture.boundPortRetirements).toHaveLength(1);
    expect(fixture.boundPortRetirements[0]).not.toHaveBeenCalled();

    // A late result from the fenced predecessor must not install a second
    // binding or displace the authorized successor.
    releaseContribution.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.bindPrivateExternalSession).toHaveBeenCalledTimes(1);

    await fixture.service.dispose();
    expect(fixture.boundPortRetirements[0]).toHaveBeenCalledTimes(1);
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

  it('holds a registration event under one-event custody and publishes follow.open only after acknowledgement', async () => {
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

    const opened = await fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'registration-open',
        followId: 'registration-follow',
        target: { kind: 'externalSession', ref, source },
      },
    });
    expect(opened).toMatchObject({
      kind: 'external_session.follow.event',
      followId: 'registration-follow',
      event: { kind: 'data', nextCursor: 'registration-cursor' },
    });
    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.next',
        requestId: 'registration-ack',
        followId: 'registration-follow',
        ...(opened.kind === 'external_session.follow.event'
          ? { acknowledgeEventId: opened.eventId }
          : {}),
      },
    })).resolves.toEqual({
      kind: 'external_session.follow.open',
      followId: 'registration-follow',
      result: { status: 'following', startingCursor: null },
    });
  });

  it('delivers a multi-page initial replay oldest-first under one-event custody before follow.open settles', async () => {
    const fixture = await setup({
      executeFollow: async (request) => {
        await request.listener({
          kind: 'data',
          phase: 'initial_replay',
          items: [{
            id: 'replay-item-1',
            kind: 'agent',
            data: {
              role: 'agent',
              content: { type: 'codex', data: { type: 'message', message: 'oldest page' } },
            },
          }],
          fromCursor: null,
          nextCursor: 'replay-cursor-2',
        });
        // Delivery is serialised behind the listener, so the second, newer
        // page is emitted only after the older page was acknowledged and
        // drained through the open exchange.
        await request.listener({
          kind: 'data',
          phase: 'initial_replay',
          items: [{
            id: 'replay-item-2',
            kind: 'agent',
            data: {
              role: 'agent',
              content: { type: 'codex', data: { type: 'message', message: 'newer page' } },
            },
          }],
          fromCursor: 'replay-cursor-2',
          nextCursor: 'replay-cursor-3',
        });
        return {
          status: 'following' as const,
          startingCursor: 'replay-cursor-3',
          subscription: { dispose: async () => undefined },
        };
      },
    });

    const firstPage = await fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.open',
        requestId: 'replay-open',
        followId: 'replay-follow',
        target: { kind: 'externalSession', ref, source },
        initialReplay: true,
      },
    });
    expect(firstPage).toMatchObject({
      kind: 'external_session.follow.event',
      followId: 'replay-follow',
      event: {
        kind: 'data',
        phase: 'initial_replay',
        fromCursor: null,
        nextCursor: 'replay-cursor-2',
      },
    });
    const secondPage = await fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.next',
        requestId: 'replay-ack-1',
        followId: 'replay-follow',
        ...(firstPage.kind === 'external_session.follow.event'
          ? { acknowledgeEventId: firstPage.eventId }
          : {}),
      },
    });
    expect(secondPage).toMatchObject({
      kind: 'external_session.follow.event',
      followId: 'replay-follow',
      event: {
        kind: 'data',
        phase: 'initial_replay',
        fromCursor: 'replay-cursor-2',
        nextCursor: 'replay-cursor-3',
      },
    });
    await expect(fixture.service.dispatch({
      ...direct,
      operation: {
        kind: 'external_session.follow.next',
        requestId: 'replay-ack-2',
        followId: 'replay-follow',
        ...(secondPage.kind === 'external_session.follow.event'
          ? { acknowledgeEventId: secondPage.eventId }
          : {}),
      },
    })).resolves.toEqual({
      kind: 'external_session.follow.open',
      followId: 'replay-follow',
      result: { status: 'following', startingCursor: 'replay-cursor-3' },
    });
  });

  it('aborts and removes a follow while its provider request is pending', async () => {
    const fixture = await setup();
    const admissionDeadlineAtMs = Date.now() + 30_000;
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
            deadlineAtMs: request.options.admissionDeadlineAtMs,
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
        initialReplay: true,
        admissionDeadlineAtMs,
      },
    });
    expect(pending).toMatchObject({
      kind: 'external_session.follow.provider_request',
      followId: 'abort-follow',
      request: { deadlineAtMs: admissionDeadlineAtMs },
    });
    expect(fixture.executeFollow).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        initialReplay: true,
        admissionDeadlineAtMs,
      }),
    }));
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
