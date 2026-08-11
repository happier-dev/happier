import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';
import { buildClaudeRuntimeAuthSharedGroupSurfaceMetadata } from './claudeRuntimeAuthSharedGroupSurfaceMetadata';
import { materializeClaudeSharedGroupRuntimeAuth } from './materializeClaudeSharedGroupRuntimeAuth';
import { verifyClaudeSharedGroupGenerationApplication } from './verifyClaudeSharedGroupGenerationApplication';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { isHealthyClaudeSubscriptionNativeAuthCredentialRecord } from './nativeAuth/claudeCodeCredentialHealth';

type ApplySharedGenerationApplication = NonNullable<
  ConnectedServiceCredentialLifecycleDescriptor['applySharedGenerationApplication']
>;

export const applyClaudeSharedGroupGenerationApplication: ApplySharedGenerationApplication = async (input) => {
  const record = input.record;
  if (
    input.serviceId !== 'claude-subscription'
    || !isHealthyClaudeSubscriptionNativeAuthCredentialRecord(record)
  ) {
    return { status: 'unavailable' };
  }
  const selectionDescriptor = {
    kind: 'group' as const,
    serviceId: 'claude-subscription' as const,
    groupId: input.groupId,
    activeProfileId: input.profileId,
    fallbackProfileId: input.profileId,
    generation: input.generation,
  };
  const runtimeClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
    activeServerDir: input.activeServerDir,
    serviceId: 'claude-subscription',
    fallbackProfileId: input.profileId,
    selection: { ...selectionDescriptor, record, policy: null },
  });
  const sourceClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
    activeServerDir: input.activeServerDir,
    serviceId: 'claude-subscription',
    fallbackProfileId: input.profileId,
    selection: {
      kind: 'profile',
      serviceId: 'claude-subscription',
      profileId: input.profileId,
      record,
    },
  });
  if (!runtimeClaudeConfigDir) return { status: 'unavailable' };
  const metadata = buildClaudeRuntimeAuthSharedGroupSurfaceMetadata({
    runtimeClaudeConfigDir,
    runtimeMaterializedRoot: runtimeClaudeConfigDir,
    sourceClaudeConfigDir,
  });
  if (!metadata) return { status: 'unavailable' };
  const materialized = await materializeClaudeSharedGroupRuntimeAuth({
    record,
    metadata,
    selectionDescriptor,
    credentialRevision: input.credentialRevision,
    validateCurrentBeforeMutation: input.validateCurrentBeforeMutation,
  });
  if ('authoritativeTarget' in materialized && materialized.authoritativeTarget) {
    return {
      status: 'superseded_after_apply',
      activeProfileId: materialized.authoritativeTarget.profileId,
      generation: materialized.authoritativeTarget.generation,
      credentialRevision: materialized.authoritativeTarget.credentialRevision,
    };
  }
  if (materialized.status !== 'materialized' || materialized.diagnostics.some((entry) => entry.severity === 'blocking')) {
    return { status: 'unavailable' };
  }
  return await verifyClaudeSharedGroupGenerationApplication({
    serviceId: input.serviceId,
    groupId: input.groupId,
    profileId: input.profileId,
    generation: input.generation,
    credentialRevision: input.credentialRevision,
    environmentVariables: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
  });
};
