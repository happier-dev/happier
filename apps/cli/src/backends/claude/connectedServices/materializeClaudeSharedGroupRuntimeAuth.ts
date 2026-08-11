import { join } from 'node:path';

import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import type { ConnectedServiceSharedGenerationAuthoritativeTarget } from '@/daemon/connectedServices/credentials/lifecycleTypes';

import {
  buildClaudeConnectedServiceHomeProvenance,
  isClaudeConnectedServiceHomeGenerationSuperseded,
  matchesClaudeConnectedServiceHomeProvenance,
  readClaudeConnectedServiceHomeProvenance,
  writeClaudeConnectedServiceHomeProvenance,
} from './claudeConnectedServiceHomeProvenance';
import { reconcileClaudeAccountScopedRootConfigFile } from './claudeRootConfig';
import type { ClaudeSharedGroupHotApplyTarget } from './claudeSharedGroupHotApplyTarget';
import { materializeClaudeCodeNativeAuth } from './nativeAuth/materializeClaudeCodeNativeAuth';
import { resolveClaudeCodeCredentialsFilePath } from './nativeAuth/claudeCodeCredentialFile';
import { verifyClaudeCodeNativeAuth } from './nativeAuth/verifyClaudeCodeNativeAuth';
import type { ClaudeCodeNativeAuthMaterializationResult } from './nativeAuth/materializeClaudeCodeNativeAuth';
import { readClaudeSubscriptionCredentialIdentity } from './nativeAuth/claudeSubscriptionCredentialIdentity';

type ClaudeSharedGroupRuntimeAuthMaterializationResult =
  ClaudeCodeNativeAuthMaterializationResult
  & Readonly<{
    authoritativeTarget?: ConnectedServiceSharedGenerationAuthoritativeTarget;
  }>;

/**
 * Live Claude group adoption owns only the stable group's credential surface. Initial spawn
 * materialization may construct the full home, but switching an already-running group must not
 * replace or sanitize unrelated runtime state beneath CLAUDE_CONFIG_DIR.
 */
export async function materializeClaudeSharedGroupRuntimeAuth(
  target: ClaudeSharedGroupHotApplyTarget,
): Promise<ClaudeSharedGroupRuntimeAuthMaterializationResult> {
  return await withConnectedServiceStateSharingDestinationLock(
    target.metadata.runtimeClaudeConfigDir,
    async () => {
      const currentness = await target.validateCurrentBeforeMutation?.();
      if (currentness?.current === false) {
        return {
          status: 'diagnostic' as const,
          env: { CLAUDE_CONFIG_DIR: target.metadata.runtimeClaudeConfigDir },
          diagnostics: [{
            code: 'claude_shared_group_generation_superseded',
            providerId: 'claude' as const,
            serviceId: 'claude-subscription' as const,
            severity: 'blocking' as const,
            reason: 'authoritative_group_target_superseded',
          }],
          ...(currentness.authoritativeTarget
            ? { authoritativeTarget: currentness.authoritativeTarget }
            : {}),
        };
      }
      const expectedProvenance = buildClaudeConnectedServiceHomeProvenance({
        record: target.record,
        selectionDescriptor: target.selectionDescriptor,
        credentialRevision: target.credentialRevision,
      });
      const existingProvenance = await readClaudeConnectedServiceHomeProvenance(
        target.metadata.runtimeClaudeConfigDir,
      );
      if (isClaudeConnectedServiceHomeGenerationSuperseded({
        incomingSelection: target.selectionDescriptor,
        existingProvenance,
      })) {
        return {
          status: 'diagnostic' as const,
          env: { CLAUDE_CONFIG_DIR: target.metadata.runtimeClaudeConfigDir },
          diagnostics: [{
            code: 'claude_shared_group_generation_superseded',
            providerId: 'claude' as const,
            serviceId: 'claude-subscription' as const,
            severity: 'blocking' as const,
            reason: 'authoritative_newer_generation_already_materialized',
          }],
        };
      }
      const exactExistingCredential = matchesClaudeConnectedServiceHomeProvenance(
        expectedProvenance,
        existingProvenance,
      ) && (await verifyClaudeCodeNativeAuth({
          claudeConfigDir: target.metadata.runtimeClaudeConfigDir,
        })).status === 'ok';
      if (exactExistingCredential) {
        const identity = readClaudeSubscriptionCredentialIdentity(target.record);
        await reconcileClaudeAccountScopedRootConfigFile({
          path: join(target.metadata.runtimeClaudeConfigDir, '.claude.json'),
          preserveExistingAccountState: true,
          providerAccountId: identity?.providerAccountId ?? null,
          providerEmail: identity?.providerEmail ?? null,
        });
        return {
          status: 'materialized' as const,
          env: { CLAUDE_CONFIG_DIR: target.metadata.runtimeClaudeConfigDir },
          diagnostics: [],
          credentialPath: resolveClaudeCodeCredentialsFilePath(target.metadata.runtimeClaudeConfigDir),
        };
      }
      const materialized = await materializeClaudeCodeNativeAuth({
        record: target.record,
        claudeConfigDir: target.metadata.runtimeClaudeConfigDir,
        preserveNewerExistingCredential: false,
        homeDir: process.env.HOME,
        username: process.env.USER,
        diagnosticContext: {
          profileId: target.selectionDescriptor.activeProfileId,
          homeKind: 'group',
        },
      });
      if (materialized.status !== 'materialized') return materialized;

      const identity = readClaudeSubscriptionCredentialIdentity(target.record);
      await reconcileClaudeAccountScopedRootConfigFile({
        path: join(target.metadata.runtimeClaudeConfigDir, '.claude.json'),
        preserveExistingAccountState: false,
        providerAccountId: identity?.providerAccountId ?? null,
        providerEmail: identity?.providerEmail ?? null,
      });
      await writeClaudeConnectedServiceHomeProvenance({
        claudeConfigDir: target.metadata.runtimeClaudeConfigDir,
        provenance: expectedProvenance,
      });
      return materialized;
    },
    { providerId: 'claude' },
  );
}
