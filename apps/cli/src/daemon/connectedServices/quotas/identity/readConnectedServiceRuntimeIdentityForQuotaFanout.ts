import type { SessionConnectedServiceAuthReadRuntimeIdentityResponseV1 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import {
  createSessionConnectedServiceAuthTransport,
  type SessionConnectedServiceAuthTransportResult,
} from '@/session/runtime/control/transport';
import type {
  RuntimeAccountIdentityFanoutProbeResult,
  RuntimeAccountIdentityFanoutReader,
} from './runtimeAccountIdentityTypes';

type RuntimeIdentityTransportFactory = (input: Readonly<{
  credentials: StoredCredentials | null | undefined;
  sessionId: string;
}>) => Readonly<{
  readConnectedServiceRuntimeIdentity: ReturnType<
    typeof createSessionConnectedServiceAuthTransport
  >['readConnectedServiceRuntimeIdentity'];
}>;

type RuntimeIdentityTransportResult =
  SessionConnectedServiceAuthTransportResult<SessionConnectedServiceAuthReadRuntimeIdentityResponseV1>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeNullableGeneration(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : null;
}

function mapRuntimeFailure(result: RuntimeIdentityTransportResult): RuntimeAccountIdentityFanoutProbeResult {
  if (result.ok) return { status: 'failed', reason: 'same_account_fanout_unexpected_transport_success_mapping' };
  if (result.code === 'session_transport_unavailable') {
    return { status: 'unavailable', reason: 'same_account_fanout_session_transport_unavailable' };
  }
  if (result.code === 'runtime_control_aborted') {
    return { status: 'failed', reason: 'same_account_fanout_runtime_identity_probe_aborted' };
  }
  return { status: 'failed', reason: readNonEmptyString(result.error) ?? 'same_account_fanout_runtime_identity_probe_failed' };
}

function mapProviderFailure(
  response: Extract<SessionConnectedServiceAuthReadRuntimeIdentityResponseV1, Readonly<{ ok: false }>>,
): RuntimeAccountIdentityFanoutProbeResult {
  const code = readNonEmptyString(response.errorCode) ?? readNonEmptyString(response.error);
  if (code?.includes('generation_mismatch')) {
    return { status: 'generation_mismatch', reason: 'same_account_fanout_candidate_stale_generation' };
  }
  if (code?.includes('unavailable') || code?.includes('unsupported')) {
    return { status: 'unavailable', reason: 'same_account_fanout_no_live_identity' };
  }
  return { status: 'failed', reason: code ?? 'same_account_fanout_runtime_identity_probe_failed' };
}

export function createConnectedServiceRuntimeIdentityFanoutReader(params: Readonly<{
  credentials: StoredCredentials | null | undefined;
  createTransport?: RuntimeIdentityTransportFactory;
}>): RuntimeAccountIdentityFanoutReader {
  const createTransport = params.createTransport ?? createSessionConnectedServiceAuthTransport;
  return async (input) => {
    if (!params.credentials) {
      return { status: 'unavailable', reason: 'same_account_fanout_session_transport_unavailable' };
    }
    const sessionId = readNonEmptyString(input.sessionId);
    if (!sessionId) {
      return { status: 'missing', reason: 'same_account_fanout_missing_session_id' };
    }

    const transport = createTransport({ credentials: params.credentials, sessionId });
    const result = await transport.readConnectedServiceRuntimeIdentity({
      serviceId: input.serviceId,
      reason: input.reason,
      requireExactProof: true,
      expected: {
        groupId: input.groupId,
      },
    });
    if (!result.ok) return mapRuntimeFailure(result);

    const response = result.value;
    if (!response.ok) return mapProviderFailure(response);
    if (response.serviceId !== input.serviceId) {
      return { status: 'generation_mismatch', reason: 'same_account_fanout_service_mismatch' };
    }
    if (response.identity.proofStrength !== 'exact') {
      return { status: 'inexact', reason: 'same_account_fanout_runtime_identity_probe_inexact' };
    }
    if (response.runtime?.safeToProbe === false) {
      return { status: 'unavailable', reason: 'same_account_fanout_runtime_identity_probe_unsafe' };
    }
    const runtimeGroupId = readNonEmptyString(response.runtime?.groupId);
    if (runtimeGroupId && runtimeGroupId !== input.groupId) {
      return { status: 'generation_mismatch', reason: 'same_account_fanout_group_mismatch' };
    }

    const strategy = response.identity.strategy;
    if (strategy !== 'provider_account_id' && strategy !== 'shared_group_auth_surface') {
      return { status: 'inexact', reason: 'same_account_fanout_runtime_identity_strategy_unsupported' };
    }
    const providerAccountId = strategy === 'provider_account_id'
      ? readNonEmptyString(response.identity.providerAccountId)
      : null;
    const sharedAuthSurfaceId = strategy === 'shared_group_auth_surface'
      ? readNonEmptyString(response.identity.sharedAuthSurfaceId)
      : null;
    if (
      (strategy === 'provider_account_id' && !providerAccountId)
      || (strategy === 'shared_group_auth_surface' && !sharedAuthSurfaceId)
    ) {
      return { status: 'inexact', reason: 'same_account_fanout_runtime_identity_probe_inexact' };
    }
    return {
      status: 'exact',
      strategy,
      ...(providerAccountId ? { providerAccountId } : {}),
      ...(sharedAuthSurfaceId ? { sharedAuthSurfaceId } : {}),
      accountLabel: readNonEmptyString(response.identity.accountLabel),
      profileId: readNonEmptyString(response.runtime?.profileId) || input.expectedProfileId,
      groupId: runtimeGroupId || input.groupId,
      groupGeneration: response.runtime?.generation === undefined
        ? input.expectedGroupGeneration
        : normalizeNullableGeneration(response.runtime.generation),
      inProviderTurn: response.runtime?.inProviderTurn === true,
      ...(typeof response.runtime?.safeToApply === 'boolean'
        ? { safeToApply: response.runtime.safeToApply }
        : {}),
    };
  };
}

export type {
  RuntimeIdentityTransportFactory,
};
