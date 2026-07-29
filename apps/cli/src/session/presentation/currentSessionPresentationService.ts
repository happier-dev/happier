import { randomUUID } from 'node:crypto';

import { clearSessionStateFieldFromMetadata, writeSessionStateFieldToMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CurrentSessionPresentationAckV1Schema,
  CurrentSessionPresentationBindV1Schema,
  CurrentSessionPresentationStateV1Schema,
  type CurrentSessionPresentationAckV1,
  type CurrentSessionPresentationBindV1,
  type CurrentSessionPresentationStateV1,
} from '@happier-dev/protocol/sessions';

import type { AgentState, Metadata } from '@/api/types';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type {
  HostCurrentSessionPresentationService,
  HostSessionPresentationOneShotResult,
  HostSessionPresentationStatefulResult,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';

type PresentationSessionPort = Pick<
  SessionClientPort,
  'sessionId' | 'rpcHandlerManager' | 'updateAgentState' | 'updateMetadata' | 'getMetadataSnapshot'
>;

type BoundClient = CurrentSessionPresentationBindV1;

type PendingCommand = Readonly<{
  clientId: string;
  resolve: (ack: CurrentSessionPresentationAckV1 | null) => void;
}>;

function diagnostic(code: string, message: string) {
  return Object.freeze({ code, severity: 'error' as const, message });
}

function unavailable(message: string, code = 'current_session_presentation_unavailable'): HostSessionPresentationStatefulResult {
  return Object.freeze({ status: 'unavailable', diagnostic: diagnostic(code, message) });
}

function conflict(message: string, code = 'current_session_presentation_conflict'): HostSessionPresentationStatefulResult {
  return Object.freeze({ status: 'conflict', diagnostic: diagnostic(code, message) });
}

function outcomeUnknown(message: string): HostSessionPresentationOneShotResult {
  return Object.freeze({
    status: 'outcomeUnknown',
    diagnostic: diagnostic('current_session_presentation_outcome_unknown', message),
  });
}

function readPresentationState(state: AgentState): CurrentSessionPresentationStateV1 | null {
  const raw = (state as Record<string, unknown>)[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY];
  const parsed = CurrentSessionPresentationStateV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function isKnownPreApplicationFailure(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return code === 'socket_not_connected' || code === 'socket_auth_failed' || code === 'session_closed';
}

function isLocalContractFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

function abortPromise(signal: AbortSignal): Promise<null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
}

export function createCurrentSessionPresentationService(params: Readonly<{
  session: PresentationSessionPort;
  signal: AbortSignal;
  isCurrent: () => boolean;
  ackTimeoutMs?: number;
  recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>): HostCurrentSessionPresentationService {
  const hostNonce = randomUUID();
  const ackTimeoutMs = params.ackTimeoutMs ?? 15_000;
  let revision = 0;
  let boundClient: BoundClient | null = null;
  const pendingCommands = new Map<string, PendingCommand>();

  const isAvailable = () => {
    if (params.signal.aborted) return false;
    try {
      return params.isCurrent() === true;
    } catch {
      return false;
    }
  };

  const updateState = async (
    mutate: (current: CurrentSessionPresentationStateV1) => CurrentSessionPresentationStateV1,
  ): Promise<CurrentSessionPresentationStateV1> => {
    let output: CurrentSessionPresentationStateV1 | null = null;
    await params.session.updateAgentState((state) => {
      const stored = readPresentationState(state);
      revision = Math.max(revision, stored?.revision ?? 0);
      const current: CurrentSessionPresentationStateV1 = {
        v: 1,
        hostNonce,
        revision,
        statuses: stored?.statuses ?? [],
        widgets: stored?.widgets ?? [],
        ...(stored?.hostNonce === hostNonce && stored.command ? { command: stored.command } : {}),
      };
      output = CurrentSessionPresentationStateV1Schema.parse(mutate(current));
      params.recordRuntimeLimitMeasurement?.({
        family: 'current-session-presentation',
        decodedBytes: Buffer.byteLength(JSON.stringify(output), 'utf8'),
        itemCount: output.statuses.length + output.widgets.length,
      });
      return { ...state, [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: output } as AgentState;
    });
    if (!output) throw new Error('Presentation state update did not execute');
    return output;
  };

  const clearCommand = async (commandId: string) => {
    try {
      await updateState((current) => current.command?.id === commandId
        ? { ...current, revision: ++revision, command: undefined }
        : current);
    } catch {
      // A stale command is fenced by hostNonce/clientId and cannot apply to a new binding.
    }
  };

  params.session.rpcHandlerManager.registerHandler(
    CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
    async (raw) => {
      const parsed = CurrentSessionPresentationBindV1Schema.safeParse(raw);
      if (!parsed.success || !isAvailable()) {
        return { error: 'Current-session presentation binding is unavailable' };
      }
      const candidate = Object.freeze({ ...parsed.data });
      if (
        boundClient === null
        || boundClient.clientId === candidate.clientId
        || candidate.focused
        || !boundClient.focused
      ) {
        boundClient = candidate;
      }
      const snapshot = await updateState((current) => ({
        ...current,
        hostNonce,
        revision: ++revision,
        command: undefined,
      }));
      return Object.freeze({
        status: 'bound' as const,
        sessionId: params.session.sessionId,
        hostNonce,
        revision: snapshot.revision,
      });
    },
  );

  params.session.rpcHandlerManager.registerHandler(
    CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
    async (raw) => {
      const parsed = CurrentSessionPresentationAckV1Schema.safeParse(raw);
      if (!parsed.success || parsed.data.hostNonce !== hostNonce) return { status: 'ignored' };
      const pending = pendingCommands.get(parsed.data.commandId);
      if (!pending || pending.clientId !== parsed.data.clientId) return { status: 'ignored' };
      pendingCommands.delete(parsed.data.commandId);
      pending.resolve(parsed.data);
      return { status: 'accepted' };
    },
  );

  params.signal.addEventListener('abort', () => {
    boundClient = null;
    for (const [commandId, pending] of pendingCommands) {
      pendingCommands.delete(commandId);
      pending.resolve(null);
    }
  }, { once: true });

  const setStateful = async (
    operationId: string,
    mutate: (current: CurrentSessionPresentationStateV1, nextRevision: number) => CurrentSessionPresentationStateV1,
  ): Promise<HostSessionPresentationStatefulResult> => {
    if (!operationId.trim() || !isAvailable()) return unavailable('The current Agent session is not available');
    try {
      const next = await updateState((current) => mutate(current, ++revision));
      return Object.freeze({ status: 'applied' as const, revision: `${hostNonce}:${next.revision}` });
    } catch {
      return unavailable('The current-session presentation snapshot could not be persisted');
    }
  };

  const publishOneShot = async (
    operationId: string,
    command: (client: BoundClient) => NonNullable<CurrentSessionPresentationStateV1['command']>,
    options?: { signal?: AbortSignal },
  ): Promise<HostSessionPresentationOneShotResult> => {
    if (!operationId.trim() || !isAvailable() || options?.signal?.aborted) {
      return unavailable('The current Agent session is not available');
    }
    const client = boundClient;
    if (!client) return unavailable('No authenticated client is bound to this session presentation');
    if (pendingCommands.size > 0) return unavailable('Another current-session presentation is awaiting the client');
    const nextCommand = command(client);
    let published = false;
    let resolveAck: (ack: CurrentSessionPresentationAckV1 | null) => void = () => undefined;
    const ackPromise = new Promise<CurrentSessionPresentationAckV1 | null>((resolve) => { resolveAck = resolve; });
    pendingCommands.set(operationId, Object.freeze({ clientId: client.clientId, resolve: resolveAck }));
    try {
      await updateState((current) => ({ ...current, revision: ++revision, command: nextCommand }));
      published = true;
    } catch (error) {
      pendingCommands.delete(operationId);
      if (isLocalContractFailure(error)) {
        return unavailable('The presentation command did not satisfy the bounded host contract');
      }
      return isKnownPreApplicationFailure(error)
        ? unavailable('The presentation target was offline before the command could be published')
        : outcomeUnknown('The command may have been published before the transport failed');
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ackTimeoutMs);
      timer.unref?.();
    });
    const ack = await Promise.race([
      ackPromise,
      timeout,
      abortPromise(params.signal),
      ...(options?.signal ? [abortPromise(options.signal)] : []),
    ]);
    if (timer) clearTimeout(timer);
    pendingCommands.delete(operationId);
    await clearCommand(operationId);
    if (!ack) {
      return published
        ? outcomeUnknown('The command was published, but the client acknowledgement was not observed')
        : unavailable('The command was not published');
    }
    return ack.status === 'applied'
      ? Object.freeze({ status: 'applied' as const, revision: `${hostNonce}:${revision}` })
      : conflict('The client target changed before the presentation could be applied');
  };

  const service: HostCurrentSessionPresentationService = {
    notify: async (request, options) => await publishOneShot(
      request.operationId,
      (client) => Object.freeze({
        id: request.operationId,
        clientId: client.clientId,
        kind: 'notify' as const,
        message: request.message,
        severity: request.severity,
      }),
      options,
    ),
    setStatus: async (request) => await setStateful(request.operationId, (current, nextRevision) => ({
      ...current,
      revision: nextRevision,
      statuses: request.text === null
        ? current.statuses.filter((entry) => entry.key !== request.key)
        : [...current.statuses.filter((entry) => entry.key !== request.key), {
            key: request.key, text: request.text, revision: nextRevision,
          }],
    })),
    setWidget: async (request) => await setStateful(request.operationId, (current, nextRevision) => ({
      ...current,
      revision: nextRevision,
      widgets: request.lines === null
        ? current.widgets.filter((entry) => entry.key !== request.key)
        : [...current.widgets.filter((entry) => entry.key !== request.key), {
            key: request.key, placement: request.placement, lines: [...request.lines], revision: nextRevision,
          }],
    })),
    setSurfaceTitle: async (request) => {
      if (!request.operationId.trim() || !isAvailable()) return unavailable('The current Agent session is not available');
      try {
        await params.session.updateMetadata((metadata) => (request.title === null
          ? clearSessionStateFieldFromMetadata(metadata, 'display.title')
          : writeSessionStateFieldToMetadata(metadata, 'display.title', request.title)) as Metadata);
        return Object.freeze({ status: 'applied' as const, revision: `${hostNonce}:${++revision}` });
      } catch {
        return unavailable('The current session title could not be persisted');
      }
    },
    replaceComposerText: async (request, options) => {
      const client = boundClient;
      if (!client?.focused) return conflict('The target session composer is not focused');
      return await publishOneShot(
        request.operationId,
        (target) => Object.freeze({
          id: request.operationId,
          clientId: target.clientId,
          kind: 'composer.replace' as const,
          text: request.text,
          expectedDraftRevision: target.draftRevision,
        }),
        options,
      );
    },
  };
  return Object.freeze(service);
}
