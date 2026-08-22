import type {
  AgentSessionRuntimeAuthApplyRequest,
  AgentSessionRuntimeAuthApplyResult,
  AgentSessionRuntimeAuthControl,
  AgentSessionRuntimeAuthIdentityRequest,
  AgentSessionRuntimeAuthIdentityResult,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  SessionConnectedServiceAuthApplyGenerationRequestV1,
  SessionConnectedServiceAuthApplyGenerationResponseV1,
  SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
  SessionConnectedServiceAuthReadRuntimeIdentityResponseV1,
} from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function projectExpected(
  expected:
    | SessionConnectedServiceAuthApplyGenerationRequestV1['expected']
    | SessionConnectedServiceAuthReadRuntimeIdentityRequestV1['expected'],
): AgentSessionRuntimeAuthApplyRequest['expected'] {
  if (!expected) return undefined;
  return {
    ...(expected.profileId === undefined ? {} : { profileId: expected.profileId }),
    ...(expected.groupId === undefined ? {} : { groupId: expected.groupId }),
    ...(expected.generation === undefined ? {} : { generation: expected.generation }),
    ...(expected.credentialRevision === undefined
      ? {}
      : { credentialRevision: expected.credentialRevision }),
  };
}

function projectApplyRequest(
  request: SessionConnectedServiceAuthApplyGenerationRequestV1,
): AgentSessionRuntimeAuthApplyRequest | null {
  const parsedAuthGeneration = AgentRuntimeJsonValueSchema.safeParse(request.authGeneration);
  if (
    !parsedAuthGeneration.success
    || !isJsonRecord(parsedAuthGeneration.data)
  ) {
    return null;
  }
  return {
    serviceId: request.serviceId,
    reason: request.reason,
    ...(request.requireDirectLiveHotApply === undefined
      ? {}
      : { requireDirectLiveHotApply: request.requireDirectLiveHotApply }),
    ...(request.expected === undefined ? {} : { expected: projectExpected(request.expected) }),
    authGeneration: parsedAuthGeneration.data,
  };
}

function projectIdentityRequest(
  request: SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
): AgentSessionRuntimeAuthIdentityRequest {
  return {
    serviceId: request.serviceId,
    reason: request.reason,
    ...(request.requireExactProof === undefined
      ? {}
      : { requireExactProof: request.requireExactProof }),
    ...(request.expected === undefined ? {} : { expected: projectExpected(request.expected) }),
  };
}

function projectDurability(
  durability: NonNullable<AgentSessionRuntimeAuthApplyResult['durability']>,
) {
  return {
    persisted: durability.persisted,
    ...(durability.errorCode === undefined ? {} : { errorCode: durability.errorCode }),
  };
}

function projectVerification(
  verification: NonNullable<AgentSessionRuntimeAuthApplyResult['verification']>,
) {
  return {
    ...(verification.activeAccountId === undefined
      ? {}
      : { activeAccountId: verification.activeAccountId }),
    ...(verification.providerAccountId === undefined
      ? {}
      : { providerAccountId: verification.providerAccountId }),
    ...(verification.proofStrength === undefined
      ? {}
      : { proofStrength: verification.proofStrength }),
    ...(verification.source === undefined ? {} : { source: verification.source }),
    ...(verification.generationApplication === undefined
      ? {}
      : {
          generationApplication: {
            serviceId: verification.generationApplication.serviceId,
            groupId: verification.generationApplication.groupId,
            profileId: verification.generationApplication.profileId,
            generation: verification.generationApplication.generation,
            ...(verification.generationApplication.credentialRevision === undefined
              ? {}
              : { credentialRevision: verification.generationApplication.credentialRevision }),
            ...(verification.generationApplication.credentialFingerprint === undefined
              ? {}
              : { credentialFingerprint: verification.generationApplication.credentialFingerprint }),
          },
        }),
  };
}

function projectApplyResult(
  result: AgentSessionRuntimeAuthApplyResult,
): SessionConnectedServiceAuthApplyGenerationResponseV1 {
  if (result.ok) {
    return {
      ok: true,
      appliedVia: result.appliedVia,
      ...(result.activeAccountId === undefined ? {} : { activeAccountId: result.activeAccountId }),
      ...(result.verification === undefined
        ? {}
        : { verification: projectVerification(result.verification) }),
      ...(result.durability === undefined ? {} : { durability: projectDurability(result.durability) }),
    };
  }
  return {
    ok: false,
    error: result.error,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    ...(result.appliedVia === undefined ? {} : { appliedVia: result.appliedVia }),
    ...(result.activeAccountId === undefined ? {} : { activeAccountId: result.activeAccountId }),
    ...(result.recovery === undefined ? {} : { recovery: result.recovery }),
    ...(result.verification === undefined
      ? {}
      : { verification: projectVerification(result.verification) }),
    ...(result.durability === undefined ? {} : { durability: projectDurability(result.durability) }),
  };
}

function projectIdentityResult(
  result: AgentSessionRuntimeAuthIdentityResult,
  serviceId: SessionConnectedServiceAuthReadRuntimeIdentityRequestV1['serviceId'],
): SessionConnectedServiceAuthReadRuntimeIdentityResponseV1 {
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    };
  }
  return {
    ok: true,
    serviceId,
    identity: {
      strategy: result.identity.strategy,
      proofStrength: result.identity.proofStrength,
      ...(result.identity.providerAccountId === undefined
        ? {}
        : { providerAccountId: result.identity.providerAccountId }),
      ...(result.identity.sharedAuthSurfaceId === undefined
        ? {}
        : { sharedAuthSurfaceId: result.identity.sharedAuthSurfaceId }),
      ...(result.identity.accountLabel === undefined
        ? {}
        : { accountLabel: result.identity.accountLabel }),
      ...(result.identity.source === undefined ? {} : { source: result.identity.source }),
    },
    ...(result.runtime === undefined
      ? {}
      : {
          runtime: {
            ...(result.runtime.safeToProbe === undefined
              ? {}
              : { safeToProbe: result.runtime.safeToProbe }),
            ...(result.runtime.safeToApply === undefined
              ? {}
              : { safeToApply: result.runtime.safeToApply }),
            ...(result.runtime.inProviderTurn === undefined
              ? {}
              : { inProviderTurn: result.runtime.inProviderTurn }),
            ...(result.runtime.profileId === undefined ? {} : { profileId: result.runtime.profileId }),
            ...(result.runtime.groupId === undefined ? {} : { groupId: result.runtime.groupId }),
            ...(result.runtime.generation === undefined
              ? {}
              : { generation: result.runtime.generation }),
            ...(result.runtime.credentialRevision === undefined
              ? {}
              : { credentialRevision: result.runtime.credentialRevision }),
          },
        }),
  };
}

export function adaptAgentSessionRuntimeAuthControl(
  control: AgentSessionRuntimeAuthControl,
): Pick<
  SessionRuntimeControls,
  'applyConnectedServiceAuthGeneration' | 'readConnectedServiceRuntimeIdentity'
> {
  return {
    async applyConnectedServiceAuthGeneration(request) {
      const projected = projectApplyRequest(request);
      if (!projected) {
        return {
          ok: false,
          error: 'invalid_request',
          errorCode: 'invalid_request',
        } satisfies SessionConnectedServiceAuthApplyGenerationResponseV1;
      }
      return projectApplyResult(await control.apply(projected));
    },
    async readConnectedServiceRuntimeIdentity(request) {
      return projectIdentityResult(
        await control.readIdentity(projectIdentityRequest(request)),
        request.serviceId,
      );
    },
  };
}
