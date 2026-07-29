import { describe, expect, it, vi } from 'vitest';

import type { AgentState, Metadata } from '@/api/types';
import type { RpcHandler } from '@/api/rpc/types';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type {
  HostRuntimeLimitMeasurementRecorder,
  HostRuntimeLimitMeasurementSample,
} from '@/agent/runtime/state/runtimeLimitMeasurement';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CurrentSessionPresentationStateV1Schema,
} from '@happier-dev/protocol/sessions';

import { createCurrentSessionPresentationService } from './currentSessionPresentationService';

function createHarness(options?: Readonly<{
  recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>) {
  let agentState: AgentState = {};
  let metadata: Metadata = {
    path: '/repo',
    host: 'test-host',
    homeDir: '/home/test',
    happyHomeDir: '/home/test/.happier',
    happyLibDir: '/home/test/.happier/lib',
    happyToolsDir: '/home/test/.happier/tools',
  };
  const handlers = new Map<string, RpcHandler>();
  let failStateWrite: Error | null = null;
  let afterStateWrite: (() => void) | null = null;
  const session = {
    sessionId: 'session-1',
    rpcHandlerManager: {
      registerHandler: (method: string, handler: RpcHandler) => handlers.set(method, handler),
      invokeLocal: async (method: string, params: unknown) => await handlers.get(method)?.(params),
    },
    updateAgentState: async (updater: (state: AgentState) => AgentState) => {
      if (failStateWrite) throw failStateWrite;
      agentState = updater(agentState);
      afterStateWrite?.();
    },
    updateMetadata: async (updater: (value: Metadata) => Metadata) => {
      metadata = updater(metadata);
    },
    getMetadataSnapshot: () => metadata,
  } as Pick<SessionClientPort, 'sessionId' | 'rpcHandlerManager' | 'updateAgentState' | 'updateMetadata' | 'getMetadataSnapshot'>;
  const controller = new AbortController();
  const presentation = createCurrentSessionPresentationService({
    session,
    signal: controller.signal,
    isCurrent: () => true,
    ackTimeoutMs: 20,
    ...(options?.recordRuntimeLimitMeasurement
      ? { recordRuntimeLimitMeasurement: options.recordRuntimeLimitMeasurement }
      : {}),
  });
  return {
    presentation,
    controller,
    handlers,
    readState: () => CurrentSessionPresentationStateV1Schema.parse(
      (agentState as Record<string, unknown>)[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
    ),
    readMetadata: () => metadata,
    setFailStateWrite: (error: Error | null) => { failStateWrite = error; },
    setAfterStateWrite: (callback: (() => void) | null) => { afterStateWrite = callback; },
  };
}

describe('current-session presentation service', () => {
  it('records the exact UTF-8 aggregate only after the canonical snapshot accepts it', async () => {
    const samples: HostRuntimeLimitMeasurementSample[] = [];
    const harness = createHarness({
      recordRuntimeLimitMeasurement: (sample) => samples.push(sample),
    });

    await expect(harness.presentation.setStatus({
      operationId: 's-exact',
      key: 'build',
      text: 'ready 💡',
    })).resolves.toMatchObject({ status: 'applied' });
    const accepted = harness.readState();
    expect(samples.at(-1)).toEqual({
      family: 'current-session-presentation',
      decodedBytes: Buffer.byteLength(JSON.stringify(accepted), 'utf8'),
      itemCount: 1,
    });

    const sampleCount = samples.length;
    await expect(harness.presentation.setStatus({
      operationId: 's-oversize',
      key: 'build',
      text: 'x'.repeat(16_385),
    })).resolves.toMatchObject({ status: 'unavailable' });
    expect(harness.readState()).toEqual(accepted);
    expect(samples).toHaveLength(sampleCount);
  });

  it('owns reconnectable status/widget snapshots and reuses the canonical title field', async () => {
    const harness = createHarness();

    await expect(harness.presentation.setStatus({ operationId: 's1', key: 'build', text: 'Running' }))
      .resolves.toMatchObject({ status: 'applied' });
    await expect(harness.presentation.setWidget({
      operationId: 'w1', key: 'checks', placement: 'beforeComposer', lines: ['Tests: 4/5'],
    })).resolves.toMatchObject({ status: 'applied' });
    await expect(harness.presentation.setSurfaceTitle({ operationId: 't1', title: 'Build monitor' }))
      .resolves.toMatchObject({ status: 'applied' });

    expect(harness.readState()).toMatchObject({
      statuses: [{ key: 'build', text: 'Running' }],
      widgets: [{ key: 'checks', placement: 'beforeComposer', lines: ['Tests: 4/5'] }],
    });
    expect(harness.readMetadata().summary?.text).toBe('Build monitor');
  });

  it('targets one-shot notification delivery to a bound client and settles only its exact acknowledgement', async () => {
    const harness = createHarness();
    const bound = await harness.handlers.get(CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD)?.({
      clientId: 'client-1', focused: false, draftRevision: 2,
    }) as { hostNonce: string };
    harness.setAfterStateWrite(() => {
      const command = harness.readState().command;
      if (!command) return;
      void harness.handlers.get(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD)?.({
        hostNonce: bound.hostNonce,
        clientId: 'wrong-client',
        commandId: command.id,
        status: 'applied',
      });
      void harness.handlers.get(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD)?.({
        hostNonce: bound.hostNonce,
        clientId: 'client-1',
        commandId: command.id,
        status: 'applied',
      });
    });

    await expect(harness.presentation.notify({
      operationId: 'notify-1', message: 'Done', severity: 'info',
    })).resolves.toMatchObject({ status: 'applied' });
    expect(harness.readState().command).toBeUndefined();
  });

  it('requires focused target and exact draft revision for composer replacement', async () => {
    const harness = createHarness();
    const firstBind = await harness.handlers.get(CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD)?.({
      clientId: 'client-1', focused: false, draftRevision: 4,
    });
    expect(firstBind).toBeTruthy();
    await expect(harness.presentation.replaceComposerText({ operationId: 'c1', text: 'new' }))
      .resolves.toMatchObject({ status: 'conflict' });

    const bound = await harness.handlers.get(CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD)?.({
      clientId: 'client-1', focused: true, draftRevision: 7,
    }) as { hostNonce: string };
    harness.setAfterStateWrite(() => {
      const command = harness.readState().command;
      if (!command) return;
      expect(command).toMatchObject({ kind: 'composer.replace', expectedDraftRevision: 7 });
      void harness.handlers.get(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD)?.({
        hostNonce: bound.hostNonce,
        clientId: 'client-1', commandId: command.id, status: 'conflict', draftRevision: 8,
      });
    });
    await expect(harness.presentation.replaceComposerText({ operationId: 'c2', text: 'new' }))
      .resolves.toMatchObject({ status: 'conflict' });
  });

  it('does not let an unfocused client steal composer authority from the focused bound client', async () => {
    const harness = createHarness();
    const bound = await harness.handlers.get(CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD)?.({
      clientId: 'focused-client', focused: true, draftRevision: 9,
    }) as { hostNonce: string };
    await harness.handlers.get(CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD)?.({
      clientId: 'background-client', focused: false, draftRevision: 2,
    });
    harness.setAfterStateWrite(() => {
      const command = harness.readState().command;
      if (!command) return;
      expect(command).toMatchObject({ clientId: 'focused-client', expectedDraftRevision: 9 });
      void harness.handlers.get(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD)?.({
        hostNonce: bound.hostNonce,
        clientId: 'focused-client', commandId: command.id, status: 'applied', draftRevision: 10,
      });
    });

    await expect(harness.presentation.replaceComposerText({ operationId: 'c-focused', text: 'new' }))
      .resolves.toMatchObject({ status: 'applied' });
  });

  it('distinguishes known pre-application loss from acknowledgement loss after publication', async () => {
    const harness = createHarness();
    await harness.handlers.get(CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD)?.({
      clientId: 'client-1', focused: false, draftRevision: 0,
    });
    const preIssueError = Object.assign(new Error('socket is not connected'), { code: 'socket_not_connected' });
    harness.setFailStateWrite(preIssueError);
    await expect(harness.presentation.notify({ operationId: 'n1', message: 'first', severity: 'warning' }))
      .resolves.toMatchObject({ status: 'unavailable' });

    harness.setFailStateWrite(null);
    harness.setAfterStateWrite(null);
    await expect(harness.presentation.notify({ operationId: 'n2', message: 'second', severity: 'error' }))
      .resolves.toMatchObject({ status: 'outcomeUnknown' });
  });

  it('retires pending work when its runtime generation aborts', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await harness.handlers.get(CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD)?.({
        clientId: 'client-1', focused: false, draftRevision: 0,
      });
      const result = harness.presentation.notify({ operationId: 'n1', message: 'pending', severity: 'info' });
      await vi.waitFor(() => expect(harness.readState().command).toBeTruthy());
      harness.controller.abort(new Error('generation retired'));
      await expect(result).resolves.toMatchObject({ status: 'outcomeUnknown' });
    } finally {
      vi.useRealTimers();
    }
  });
});
