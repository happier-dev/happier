import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol';

import type { ConnectedServiceProviderRuntimeAuthAdapter } from '../../runtimeAuth/types';
import type {
  ConnectedServiceAuthGroupCommittedGenerationFact,
  ConnectedServiceProviderAdoptedGenerationTarget,
} from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { resolveConnectedServiceTargetMaterializedRoot } from '../../materialize/resolveConnectedServiceTargetMaterializedRoot';
import { createConnectedServiceRuntimeAuthNativeHome } from '../../runtimeAuth/createRuntimeAuthNativeHome';
import { logger } from '@/ui/logger';

export async function resolveSharedGenerationApplicationProof(input: Readonly<{
  agentId: CatalogAgentId;
  targetMaterializedEnv: Readonly<Record<string, string>>;
  committedGeneration: ConnectedServiceAuthGroupCommittedGenerationFact;
  resolveCredentialResolution(input: Readonly<{
    serviceId: ConnectedServiceAuthGroupCommittedGenerationFact['decisionCommittedTarget']['serviceId'];
    profileId: string;
  }>): Promise<Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
  }> | null>;
  resolveRuntimeAuthAdapter(agentId: string): Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;
}>): Promise<ConnectedServiceProviderAdoptedGenerationTarget | null> {
  const target = input.committedGeneration.decisionCommittedTarget;

  let resolution: Awaited<ReturnType<typeof input.resolveCredentialResolution>>;
  try {
    resolution = await input.resolveCredentialResolution({
      serviceId: target.serviceId,
      profileId: target.profileId,
    });
  } catch {
    logger.warn('[Connected Services] credential_revision_read_failed');
    return null;
  }
  if (!resolution) return null;

  let adapter: Awaited<ReturnType<typeof input.resolveRuntimeAuthAdapter>>;
  try {
    adapter = await input.resolveRuntimeAuthAdapter(input.agentId);
  } catch {
    logger.warn('[Connected Services] runtime_auth_adapter_unavailable');
    return null;
  }
  if (!adapter?.verifyActiveAccount) return null;
  const targetMaterializedRoot = resolveConnectedServiceTargetMaterializedRoot({
    agentId: input.agentId,
    targetMaterializedEnv: input.targetMaterializedEnv,
  });
  const nativeHome = targetMaterializedRoot
    ? await createConnectedServiceRuntimeAuthNativeHome({
        agentId: input.agentId,
        root: targetMaterializedRoot,
      })
    : null;
  let verification: Awaited<ReturnType<NonNullable<typeof adapter.verifyActiveAccount>>>;
  try {
    verification = await adapter.verifyActiveAccount({
      target: { agentId: input.agentId },
      selection: {
        serviceId: target.serviceId,
        groupId: target.groupId,
        activeProfileId: target.profileId,
        profileId: target.profileId,
        groupGeneration: target.generation,
        credentialRevision: resolution.credentialRevision,
      },
      credential: resolution.record,
      ...(nativeHome ? { nativeHome } : {}),
    });
  } catch {
    logger.warn('[Connected Services] shared_application_verification_failed');
    return null;
  }
  if (
    verification.status !== 'verified'
    || verification.source !== 'shared_group_auth_surface'
    || verification.sharedAuthSurfaceId !== target.groupId
    || verification.generationApplication?.serviceId !== target.serviceId
    || verification.generationApplication.groupId !== target.groupId
    || verification.generationApplication.profileId !== target.profileId
    || verification.generationApplication.generation !== target.generation
    || verification.generationApplication.credentialRevision !== resolution.credentialRevision
  ) {
    return null;
  }

  return {
    ...target,
    credentialRevision: resolution.credentialRevision,
    proof: {
      status: 'verified',
      source: verification.source,
      ...(verification.providerAccountId == null ? {} : { providerAccountId: verification.providerAccountId }),
      ...(verification.activeAccountId == null ? {} : { activeAccountId: verification.activeAccountId }),
      sharedAuthSurfaceId: verification.sharedAuthSurfaceId,
      credentialRevision: verification.generationApplication.credentialRevision,
      credentialFingerprint: verification.generationApplication.credentialFingerprint,
    },
  };
}
