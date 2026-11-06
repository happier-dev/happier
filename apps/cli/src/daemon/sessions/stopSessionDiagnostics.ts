import type { ActionExecutorContext } from '@happier-dev/protocol/actions';

/** Host-observed correlation only. These fields never grant Stop authority. */
export type SessionStopRequestSource = Readonly<{
  surface?: ActionExecutorContext['surface'];
  callerKind?: NonNullable<ActionExecutorContext['actionCaller']>['kind'];
  requestingSessionId?: string;
  toolCallId?: string;
}>;

export type SessionStopRequestDiagnostics = Readonly<{
  source?: SessionStopRequestSource;
  transport?: 'machine_rpc' | 'local_http' | 'external_action' | 'process_action' | 'internal';
}>;

export function readSessionStopRequestSource(context?: Partial<Pick<ActionExecutorContext,
  'surface' | 'actionCaller' | 'approvalOrigin' | 'approvedActionReplay'>>): SessionStopRequestSource | undefined {
  if (!context) return undefined;
  // A person approving an Action is not the original requester. The approval
  // owner has already validated this retained origin; it is diagnostic here.
  const original = context.approvedActionReplay?.origin;
  const caller = original?.caller ?? context.actionCaller;
  const transcript = context.approvalOrigin;
  const requestingSessionId = caller?.kind === 'session' ? caller.sessionId : transcript?.sessionId;
  return {
    surface: original?.surface ?? context.surface,
    ...(caller ? { callerKind: caller.kind } : {}),
    ...(requestingSessionId ? { requestingSessionId } : {}),
    ...(transcript?.toolCallId ? { toolCallId: transcript.toolCallId } : {}),
  };
}

export function sessionStopRequestDiagnostics(options?: SessionStopRequestDiagnostics) {
  const source = options?.source;
  return {
    requestSource: source ? {
      ...(source.surface ? { surface: source.surface } : {}),
      ...(source.callerKind ? { callerKind: source.callerKind } : {}),
      ...(source.requestingSessionId ? { requestingSessionId: source.requestingSessionId } : {}),
      ...(source.toolCallId ? { toolCallId: source.toolCallId } : {}),
    } : null,
    requestTransport: options?.transport ?? 'internal',
  };
}
