import { z } from 'zod';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { ConnectedServiceCredentialRevisionV1Schema, type ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';

import type {
  ConnectedServiceDaemonAuthBridgeRefreshResult,
  ConnectedServiceDaemonAuthBridgeRegistration,
} from './daemonAuthBridgeTypes';
import {
  runtimeTargetOwnsConnectedServiceRuntimeAuthRefreshSelection,
  type ConnectedServiceRuntimeAuthRefreshSelection,
} from './runtimeAuthRefreshAuthorization';
import type { ConnectedServiceRuntimeRegistry } from './runtimeRegistry/registry';
import type { ConnectedServiceRuntimeTarget } from './runtimeRegistry/target';
import type { ConnectedServiceCredentialRefreshFailureCode } from './refresh/ConnectedServiceRefreshCoordinator';

export type SessionConnectedServiceRuntimeAuthRefreshInput = Readonly<{
  sessionId: string;
  refreshAttemptId: string;
  selection: ConnectedServiceRuntimeAuthRefreshSelection;
  planType?: string | null;
  failingAccessTokenFingerprint?: string | null;
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
  reason?: string | null;
}>;

export type SessionConnectedServiceRuntimeAuthRefreshResult = Readonly<
  | {
      ok: true;
      result: ConnectedServiceDaemonAuthBridgeRefreshResult;
    }
  | {
      ok: false;
      errorCode:
        | 'connected_service_session_refresh_forbidden'
        | 'connected_service_daemon_auth_bridge_unavailable';
    }
>;

const ConnectedServiceDaemonAuthBridgeRefreshProofResultSchema = z.record(z.string(), z.unknown())
  .refine((value) => !Object.prototype.hasOwnProperty.call(value, 'status'));

export const ConnectedServiceDaemonAuthBridgeRefreshResultSchema:
  z.ZodType<ConnectedServiceDaemonAuthBridgeRefreshResult> =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('refreshed'),
      result: ConnectedServiceDaemonAuthBridgeRefreshProofResultSchema,
    }).strict(),
    z.object({
      status: z.literal('pending'),
      refreshAttemptId: z.string().trim().min(1),
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      reason: z.string().trim().min(1),
    }).strict(),
    z.object({
      status: z.literal('failed'),
      reason: z.string().trim().min(1),
      error: z.unknown().optional(),
    }).strict(),
  ]);

function parseDaemonAuthBridgeRefreshSettlement(
  value: unknown,
  expectedRefreshAttemptId: string,
): ConnectedServiceDaemonAuthBridgeRefreshResult {
  const parsed = ConnectedServiceDaemonAuthBridgeRefreshResultSchema.safeParse(value);
  if (!parsed.success) {
    return { status: 'failed', reason: 'runtime_auth_refresh_invalid_bridge_result' };
  }
  if (parsed.data.status === 'pending') {
    return parsed.data.refreshAttemptId === expectedRefreshAttemptId
      ? parsed.data
      : { status: 'failed', reason: 'runtime_auth_refresh_attempt_mismatch' };
  }
  return parsed.data;
}

function readCredentialRefreshFailureCode(error: unknown): ConnectedServiceCredentialRefreshFailureCode | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired
    || code === CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialRefreshUnavailable
    ? code
    : null;
}

export type SessionConnectedServiceRuntimeAuthRefreshHandler = (
  input: SessionConnectedServiceRuntimeAuthRefreshInput,
) => Promise<SessionConnectedServiceRuntimeAuthRefreshResult>;

export type ResolveDaemonAuthBridge = (
  serviceId: ConnectedServiceRuntimeAuthRefreshSelection['serviceId'],
) => Promise<Readonly<{
  pluginId?: string;
  registration: ConnectedServiceDaemonAuthBridgeRegistration;
}> | ConnectedServiceDaemonAuthBridgeRegistration | null>;

function readBridgeRegistration(
  value: Awaited<ReturnType<ResolveDaemonAuthBridge>>,
): ConnectedServiceDaemonAuthBridgeRegistration | null {
  if (!value || typeof value !== 'object') return null;
  if ('registration' in value) return value.registration;
  return typeof value.refresh === 'function' ? value : null;
}

export function resolveCurrentRefreshSelection(input: Readonly<{
  target: ConnectedServiceRuntimeTarget;
  serviceId: ConnectedServiceRuntimeAuthRefreshSelection['serviceId'];
}>): Readonly<{
  selection: ConnectedServiceRuntimeAuthRefreshSelection;
  credentialRevision: ConnectedServiceCredentialRevisionV1;
}> | null {
  const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(input.serviceId);
  const current = input.target.connectedServiceSelections.find((candidate) => candidate.serviceId === serviceId);
  if (!current?.credentialRevision) return null;
  if (current.kind === 'profile') {
    return {
      selection: {
        kind: 'profile',
        serviceId: current.serviceId,
        profileId: current.profileId,
      },
      credentialRevision: current.credentialRevision,
    };
  }
  return {
    selection: {
      kind: 'group',
      serviceId: current.serviceId,
      groupId: current.groupId,
      activeProfileId: current.activeProfileId,
      fallbackProfileId: current.fallbackProfileId,
      generation: current.generation,
    },
    credentialRevision: current.credentialRevision,
  };
}

export async function refreshConnectedServiceRuntimeAuthForTarget(input: Readonly<{
  target: ConnectedServiceRuntimeTarget;
  request: Omit<SessionConnectedServiceRuntimeAuthRefreshInput, 'sessionId'>;
  scope: Readonly<{ sessionId: string }> | Readonly<{ runId: string }>;
  authority?: object;
  acceptSettledCredentialRevision?(revision: ConnectedServiceCredentialRevisionV1): ConnectedServiceRuntimeTarget | null;
  isCurrent(): boolean;
  resolveDaemonAuthBridge: ResolveDaemonAuthBridge;
}>): Promise<SessionConnectedServiceRuntimeAuthRefreshResult> {
    const { target, request } = input;
    const current = target ? resolveCurrentRefreshSelection({
      target,
      serviceId: request.selection.serviceId,
    }) : null;
    if (!input.isCurrent() || !current || !runtimeTargetOwnsConnectedServiceRuntimeAuthRefreshSelection({
      target,
      selection: current.selection,
    })) {
      return { ok: false, errorCode: 'connected_service_session_refresh_forbidden' };
    }

    const resolvedBridge = await input.resolveDaemonAuthBridge(current.selection.serviceId);
    if (!input.isCurrent()) {
      return { ok: false, errorCode: 'connected_service_session_refresh_forbidden' };
    }
    const bridge = readBridgeRegistration(resolvedBridge);
    if (!bridge) {
      return { ok: false, errorCode: 'connected_service_daemon_auth_bridge_unavailable' };
    }

    let bridgeSettlement: ConnectedServiceDaemonAuthBridgeRefreshResult;
    try {
      bridgeSettlement = await bridge.refresh({
        ...input.scope,
        refreshAttemptId: request.refreshAttemptId,
        selection: current.selection,
        ...(request.planType === undefined ? {} : { planType: request.planType }),
        ...(request.failingAccessTokenFingerprint === undefined
          ? {}
          : { failingAccessTokenFingerprint: request.failingAccessTokenFingerprint }),
        expectedCredentialRevision: 'runId' in input.scope ? request.expectedCredentialRevision : current.credentialRevision,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        forceRefresh: true,
      }, { target, authority: input.authority ?? target, isCurrent: input.isCurrent,
        acceptSettledCredentialRevision: input.acceptSettledCredentialRevision });
    } catch (error) {
      const failureCode = readCredentialRefreshFailureCode(error);
      if (!failureCode) throw error;
      bridgeSettlement = { status: 'failed', reason: failureCode };
    }
    if (!input.isCurrent()) {
      return { ok: false, errorCode: 'connected_service_session_refresh_forbidden' };
    }
    return {
      ok: true,
      result: parseDaemonAuthBridgeRefreshSettlement(bridgeSettlement, request.refreshAttemptId),
    };
}

export function createSessionConnectedServiceRuntimeAuthRefreshHandler(input: Readonly<{
  registry: ConnectedServiceRuntimeRegistry;
  resolveDaemonAuthBridge: ResolveDaemonAuthBridge;
  captureSessionAuthority?(target: ConnectedServiceRuntimeTarget): Readonly<{ identity: object; isCurrent(): boolean }> | null;
}>): SessionConnectedServiceRuntimeAuthRefreshHandler {
  return async (request) => {
    let target = input.registry.getBySessionId(request.sessionId);
    if (!target) return { ok: false, errorCode: 'connected_service_session_refresh_forbidden' };
    const authority = input.captureSessionAuthority?.(target);
    if (input.captureSessionAuthority && (!authority || !authority.isCurrent())) {
      return { ok: false, errorCode: 'connected_service_session_refresh_forbidden' };
    }
    const isCurrent = () => (!authority || authority.isCurrent()) && input.registry.getBySessionId(request.sessionId) === target;
    const result = await refreshConnectedServiceRuntimeAuthForTarget({
      target, request, scope: { sessionId: request.sessionId },
      authority: authority?.identity,
      isCurrent,
      ...(authority ? { acceptSettledCredentialRevision: (revision: ConnectedServiceCredentialRevisionV1) => {
        if (!authority.isCurrent() || !target) return null;
        const selection = resolveCurrentRefreshSelection({ target, serviceId: request.selection.serviceId });
        if (!selection) return null;
        const current = input.registry.resolveExactSessionCredentialRevisionTarget({ target,
          serviceId: selection.selection.serviceId, expectedCredentialRevision: selection.credentialRevision,
          credentialRevision: revision });
        if (!authority.isCurrent() || !current) return null;
        target = current;
        return current;
      } } : {}),
      resolveDaemonAuthBridge: input.resolveDaemonAuthBridge,
    });
    if (result.ok && result.result.status === 'refreshed' && 'credentialRevision' in result.result.result) {
      const revision = ConnectedServiceCredentialRevisionV1Schema.safeParse(result.result.result.credentialRevision);
      const current = resolveCurrentRefreshSelection({ target, serviceId: request.selection.serviceId });
      if (!revision.success || !current || !input.registry.adoptExactCredentialRevisionForTarget({
        target, serviceId: current.selection.serviceId, expectedCredentialRevision: current.credentialRevision,
        credentialRevision: revision.data,
      })) return { ok: false, errorCode: 'connected_service_session_refresh_forbidden' };
    }
    return result;
  };
}
