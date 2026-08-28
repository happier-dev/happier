import {
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedAccountServiceKeySchema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedAccountServiceKey,
} from '@happier-dev/protocol';

import { getConnectedServiceRuntimeAuthAdapter } from '@/daemon/connectedServices/catalogHooks';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { resolveTrackedSessionCatalogAgentId } from '@/daemon/sessions/resolveTrackedSessionCatalogAgentId';
import type { TrackedSession } from '@/daemon/types';
import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeAuthTargetInput,
} from '../runtimeAuth/types';
import type {
  AcceptedConnectedServiceAccountVerification,
  AcceptedConnectedServiceAccountVerificationByServiceId,
} from '../accountTransitions/acceptedConnectedServiceAccountVerification';
import { projectConnectedServiceRuntimeAuthTargetInput } from '../runtimeAuth/projectRuntimeAuthTargetInput';

type HotApplyResult =
  | Readonly<{
      ok: true;
      verificationByServiceId?: AcceptedConnectedServiceAccountVerificationByServiceId;
    }>
  | Readonly<{
      ok: false;
      errorCode:
        | 'hot_apply_unavailable'
        | 'hot_apply_failed'
        | 'hot_apply_restart_required'
        | 'credential_revision_superseded';
      serviceId?: ConnectedAccountServiceKey;
      serviceResultsByServiceId?: Readonly<Record<string, SessionConnectedServiceAuthSwitchServiceResult>>;
    }>;

export type SessionConnectedServiceAuthSwitchServiceResult = Readonly<{
  status: 'applied' | 'failed' | 'not_attempted';
  errorCode?: string;
}>;

function resultApplied(result: Readonly<Record<string, unknown>>): boolean {
  return result.applied === true || result.status === 'applied';
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readAcceptedVerificationFromHotApplyResult(
  result: Readonly<Record<string, unknown>>,
): AcceptedConnectedServiceAccountVerification | null {
  const verification = readRecord(result.verification);
  if (!verification) return null;

  const status = verification.status === 'verified' || verification.status === 'weakly_verified'
    ? verification.status
    : null;
  const proofStrength = verification.proofStrength === 'exact'
    || verification.proofStrength === 'weak'
    || verification.proofStrength === 'diagnostic'
    ? verification.proofStrength
    : null;
  const providerAccountId = readString(verification.providerAccountId);
  const activeAccountId = readString(verification.activeAccountId);
  const sharedAuthSurfaceId = readString(verification.sharedAuthSurfaceId);
  const source = readString(verification.source);
  const reason = readString(verification.reason);
  const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(verification.credentialRevision);
  const credentialFingerprint = readString(verification.credentialFingerprint);
  const generationApplicationRaw = readRecord(verification.generationApplication);
  const generationApplicationServiceId = ConnectedAccountServiceKeySchema.safeParse(generationApplicationRaw?.serviceId);
  const generationApplicationCredentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
    generationApplicationRaw?.credentialRevision,
  );
  const generationApplicationGeneration = generationApplicationRaw?.generation;
  const generationApplication = generationApplicationRaw
    && generationApplicationServiceId.success
    && readString(generationApplicationRaw.groupId)
    && readString(generationApplicationRaw.profileId)
    && typeof generationApplicationGeneration === 'number'
    && Number.isSafeInteger(generationApplicationGeneration)
    && generationApplicationGeneration >= 0
    && generationApplicationCredentialRevision.success
    && readString(generationApplicationRaw.credentialFingerprint)
    ? {
        serviceId: generationApplicationServiceId.data,
        groupId: readString(generationApplicationRaw.groupId)!,
        profileId: readString(generationApplicationRaw.profileId)!,
        generation: generationApplicationGeneration,
        credentialRevision: generationApplicationCredentialRevision.data,
        credentialFingerprint: readString(generationApplicationRaw.credentialFingerprint)!,
      }
    : null;

  const hasExactIdentityMaterial = providerAccountId !== null
    || activeAccountId !== null
    || sharedAuthSurfaceId !== null;

  if (status === 'verified' && proofStrength === 'exact' && !hasExactIdentityMaterial) {
    return null;
  }

  if (status) {
    return {
      status,
      ...(providerAccountId !== null ? { providerAccountId } : {}),
      ...(activeAccountId !== null ? { activeAccountId } : {}),
      ...(sharedAuthSurfaceId !== null ? { sharedAuthSurfaceId } : {}),
      ...(proofStrength !== null ? { proofStrength } : {}),
      ...(source !== null ? { source } : {}),
      ...(reason !== null ? { reason } : {}),
      ...(credentialRevision.success ? { credentialRevision: credentialRevision.data } : {}),
      ...(credentialFingerprint !== null ? { credentialFingerprint } : {}),
      ...(generationApplication !== null ? { generationApplication } : {}),
    };
  }

  if (proofStrength === 'exact' && hasExactIdentityMaterial) {
    return {
      status: 'verified',
      ...(providerAccountId !== null ? { providerAccountId } : {}),
      ...(activeAccountId !== null ? { activeAccountId } : {}),
      ...(sharedAuthSurfaceId !== null ? { sharedAuthSurfaceId } : {}),
      proofStrength: 'exact',
      ...(source !== null ? { source } : {}),
      ...(reason !== null ? { reason } : {}),
      ...(credentialRevision.success ? { credentialRevision: credentialRevision.data } : {}),
      ...(credentialFingerprint !== null ? { credentialFingerprint } : {}),
      ...(generationApplication !== null ? { generationApplication } : {}),
    };
  }

  return null;
}

function readHotApplyFailureErrorCode(
  result: Readonly<Record<string, unknown>>,
): Exclude<HotApplyResult, Readonly<{ ok: true }>>['errorCode'] {
  if (
    result.status === 'superseded_after_apply'
    || result.reason === 'credential_revision_superseded'
    || result.reason === 'shared_generation_application_superseded'
  ) {
    return 'credential_revision_superseded';
  }
  return result.recovery === 'restart_resume'
    ? 'hot_apply_restart_required'
    : 'hot_apply_failed';
}

export function createSessionConnectedServiceAuthHotApply(deps?: Readonly<{
  resolveRuntimeAuthAdapter?: (agentId: CatalogAgentId) => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;
  validateGroupMutationCurrentness?: (input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    profileId: string;
    generation: number;
    credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  }>) => ReturnType<NonNullable<ConnectedServiceRuntimeAuthTargetInput['validateCurrentBeforeMutation']>>;
}>) {
  const resolveRuntimeAuthAdapter = deps?.resolveRuntimeAuthAdapter
    ?? (async (agentId: CatalogAgentId) => await getConnectedServiceRuntimeAuthAdapter(agentId));

  return async function hotApplySessionConnectedServiceAuth(input: Readonly<{
    tracked: TrackedSession;
    normalizedBindings: ConnectedServiceBindingsV1;
    serviceIds?: ReadonlySet<ConnectedAccountServiceKey>;
    runtimeAuthSelectionsByServiceId?: ReadonlyMap<ConnectedAccountServiceKey, unknown>;
  }>): Promise<HotApplyResult> {
    const agentId = resolveTrackedSessionCatalogAgentId(input.tracked);
    if (!agentId) return { ok: false, errorCode: 'hot_apply_unavailable' };
    const adapter = await resolveRuntimeAuthAdapter(agentId);
    if (!adapter) return { ok: false, errorCode: 'hot_apply_unavailable' };

    const targetBindings = Object.entries(input.normalizedBindings.bindingsByServiceId)
      .flatMap(([serviceIdRaw, binding]) => {
        if (binding.source !== 'connected') return [];
        const serviceId = ConnectedAccountServiceKeySchema.parse(serviceIdRaw);
        if (input.serviceIds && !input.serviceIds.has(serviceId)) return [];
        return [{ serviceId, binding }];
      });
    const serviceResultsByServiceId: Record<string, SessionConnectedServiceAuthSwitchServiceResult> = {};
    const acceptedVerificationsByServiceId: Record<string, AcceptedConnectedServiceAccountVerification> = {};

    for (const [index, { serviceId, binding }] of targetBindings.entries()) {
      const materializedSelection = input.runtimeAuthSelectionsByServiceId?.get(serviceId);
      const materializedSelectionRecord = readRecord(materializedSelection);
      const groupGeneration = materializedSelectionRecord?.groupGeneration ?? materializedSelectionRecord?.generation;
      const credentialRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
        materializedSelectionRecord?.credentialRevision,
      );
      const validateCurrentBeforeMutation = binding.selection === 'group'
        ? async () => {
            const groupId = readString(materializedSelectionRecord?.groupId) ?? readString(binding.groupId);
            const profileId = readString(materializedSelectionRecord?.activeProfileId)
              ?? readString(materializedSelectionRecord?.profileId)
              ?? readString(binding.profileId);
            if (
              !deps?.validateGroupMutationCurrentness
              || !groupId
              || !profileId
              || !Number.isSafeInteger(groupGeneration)
            ) {
              return { current: false as const, reason: 'shared_generation_application_currentness_unavailable' };
            }
            return await deps.validateGroupMutationCurrentness({
              serviceId,
              groupId,
              profileId,
              generation: groupGeneration as number,
              credentialRevision: credentialRevision.success ? credentialRevision.data : null,
            });
          }
        : undefined;
      const request = projectConnectedServiceRuntimeAuthTargetInput({
        agentId,
        materializedSelection,
        fallbackSelection: {
          serviceId,
          binding,
          profileId: binding.profileId,
          ...(binding.selection === 'group'
            ? { groupId: binding.groupId, activeProfileId: binding.profileId }
            : {}),
        },
        ...(validateCurrentBeforeMutation ? { validateCurrentBeforeMutation } : {}),
      });
      const result = await adapter.hotApply(request);
      if (!resultApplied(result)) {
        const errorCode = readHotApplyFailureErrorCode(result);
        serviceResultsByServiceId[serviceId] = { status: 'failed', errorCode };
        for (const remaining of targetBindings.slice(index + 1)) {
          serviceResultsByServiceId[remaining.serviceId] = { status: 'not_attempted' };
        }
        return {
          ok: false,
          errorCode,
          serviceId,
          serviceResultsByServiceId,
        };
      }
      serviceResultsByServiceId[serviceId] = { status: 'applied' };
      const acceptedVerification = readAcceptedVerificationFromHotApplyResult(result);
      if (acceptedVerification) {
        acceptedVerificationsByServiceId[serviceId] = acceptedVerification;
      }
    }

    return {
      ok: true,
      ...(Object.keys(acceptedVerificationsByServiceId).length > 0
        ? { verificationByServiceId: acceptedVerificationsByServiceId }
        : {}),
    };
  };
}
