import { readFile } from 'node:fs/promises';

import { classifyClaudeConnectedServiceRuntimeAuthFailure } from './classifyClaudeConnectedServiceRuntimeAuthFailure';
import { mapClaudeRateLimitEventToUsageDetails } from './mapClaudeRateLimitEventToUsageDetails';
import { resolveClaudeConnectedServiceRuntimeAuthSwitchPlan } from './claudeConnectedServiceRuntimeAuthSwitchPlan';
import { resolveClaudeSharedGroupHotApplyTarget } from './claudeSharedGroupHotApplyTarget';
import { materializeClaudeSharedGroupRuntimeAuth } from './materializeClaudeSharedGroupRuntimeAuth';
import { classifyClaudeCodeCredentialHealth } from './nativeAuth/claudeCodeCredentialHealth';
import {
  buildClaudeCodeCredentialPayload,
  computeClaudeCodeCredentialAccountProofFingerprint,
  resolveClaudeCodeCredentialsFilePath,
} from './nativeAuth/claudeCodeCredentialFile';
import type { ClaudeSubscriptionNativeAuthSelectionDescriptor } from './nativeAuth/materializeClaudeCodeNativeAuth';
import { verifyClaudeCodeNativeAuth } from './nativeAuth/verifyClaudeCodeNativeAuth';
import { readClaudeSubscriptionCredentialIdentity } from './nativeAuth/claudeSubscriptionCredentialIdentity';
import { verifyClaudeSharedGroupGenerationApplication } from './verifyClaudeSharedGroupGenerationApplication';
import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeFailureInput,
  ConnectedServiceRuntimeAuthTargetInput,
} from '@/daemon/connectedServices/runtimeAuth/types';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCredentialRecord(input: Readonly<{ selection?: unknown }>): ConnectedServiceCredentialRecordV1 | null {
  const selection = readRecord(input.selection);
  const record = readRecord(selection?.record);
  return record as ConnectedServiceCredentialRecordV1 | null;
}

function readClaudeConfigDir(input: ConnectedServiceRuntimeAuthTargetInput): string | null {
  const selection = readRecord(input.selection);
  const env = readRecord(selection?.targetMaterializedEnv)
    ?? readRecord(selection?.materializedEnv)
    ?? readRecord(selection?.env);
  return readString(env?.CLAUDE_CONFIG_DIR);
}

async function materializedCredentialMatchesRecord(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  claudeConfigDir: string;
}>): Promise<boolean> {
  const built = buildClaudeCodeCredentialPayload(params.record);
  if (built.status !== 'ok') return false;
  try {
    const raw = JSON.parse(await readFile(resolveClaudeCodeCredentialsFilePath(params.claudeConfigDir), 'utf8')) as unknown;
    const actual = computeClaudeCodeCredentialAccountProofFingerprint(raw);
    const expected = computeClaudeCodeCredentialAccountProofFingerprint(built.payload);
    return actual !== null && actual === expected;
  } catch {
    return false;
  }
}

function buildSharedGroupVerification(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  selectionDescriptor: ClaudeSubscriptionNativeAuthSelectionDescriptor;
  materializedIdentity?: Readonly<{
    providerAccountId: string | null;
    providerEmail: string | null;
  }> | null;
}>) {
  if (params.selectionDescriptor.kind !== 'group') return null;
  const recordIdentity = readClaudeSubscriptionCredentialIdentity(params.record);
  return {
    status: 'weakly_verified' as const,
    providerAccountId: params.materializedIdentity?.providerAccountId
      ?? recordIdentity?.providerAccountId
      ?? null,
    activeAccountId: params.materializedIdentity?.providerEmail
      ?? recordIdentity?.providerEmail
      ?? null,
    sharedAuthSurfaceId: params.selectionDescriptor.groupId,
    proofStrength: 'weak' as const,
    source: 'shared_group_auth_surface',
    reason: 'claude_shared_group_auth_surface_rewritten',
  };
}

function attachClaudeSourceAccountIdentity(
  classification: ReturnType<typeof classifyClaudeConnectedServiceRuntimeAuthFailure>,
  input: ConnectedServiceRuntimeFailureInput,
): ReturnType<typeof classifyClaudeConnectedServiceRuntimeAuthFailure> {
  if (!classification || classification.sourceProviderAccountId) return classification;
  const record = readCredentialRecord(input);
  const sourceIdentity = readClaudeSubscriptionCredentialIdentity(record);
  const sourceProviderAccountId = sourceIdentity?.providerAccountId ?? null;
  if (!sourceProviderAccountId) return classification;
  const sourceAccountLabel = sourceIdentity?.providerEmail ?? null;
  return {
    ...classification,
    sourceProviderAccountId,
    ...(sourceAccountLabel ? { sourceAccountLabel } : {}),
  };
}

export function createClaudeConnectedServiceRuntimeAuthAdapter(): ConnectedServiceProviderRuntimeAuthAdapter {
  return {
    classifyRuntimeAuthFailure(input) {
      const authClassification = classifyClaudeConnectedServiceRuntimeAuthFailure({
        error: input.error,
        selection: input.selection,
      });
      if (authClassification) return attachClaudeSourceAccountIdentity(authClassification, input);

      const details = mapClaudeRateLimitEventToUsageDetails(input.error);
      // The raw payload rides along even when details mapped, so the classifier can recover reset
      // timing the mapper could not place in the details (INC-4).
      return attachClaudeSourceAccountIdentity(classifyClaudeConnectedServiceRuntimeAuthFailure({
        ...(details ? { details } : {}),
        error: input.error,
        selection: input.selection,
      }), input);
    },
    async materializeActiveProfile() {
      return { supported: true };
    },
    canHotApply(input) {
      if (resolveClaudeSharedGroupHotApplyTarget(input.selection)) {
        return {
          supported: true,
          mode: 'claude_subscription_shared_group_auth_surface_rewrite',
        };
      }
      return { supported: false, recovery: 'restart_rematerialize' };
    },
    async hotApply(input) {
      const target = resolveClaudeSharedGroupHotApplyTarget(input.selection);
      if (!target) {
        return { applied: false, reason: 'hot_apply_unsupported', recovery: 'restart_rematerialize' };
      }
      const materialized = await materializeClaudeSharedGroupRuntimeAuth({
        ...target,
        ...(input.validateCurrentBeforeMutation
          ? { validateCurrentBeforeMutation: input.validateCurrentBeforeMutation }
          : {}),
      });
      const blockingDiagnostics = materialized.diagnostics.filter((diagnostic) => diagnostic.severity === 'blocking');
      if (blockingDiagnostics.length > 0 || materialized.status !== 'materialized') {
        const superseded = blockingDiagnostics[0]?.code === 'claude_shared_group_generation_superseded';
        return {
          applied: false,
          ...('authoritativeTarget' in materialized && materialized.authoritativeTarget
            ? {
                status: 'superseded_after_apply',
                activeProfileId: materialized.authoritativeTarget.profileId,
                generation: materialized.authoritativeTarget.generation,
                credentialRevision: materialized.authoritativeTarget.credentialRevision,
              }
            : {}),
          reason: blockingDiagnostics[0]?.code ?? 'claude_shared_group_auth_surface_materialization_failed',
          recovery: superseded ? 'none' : 'restart_resume',
          diagnostics: materialized.diagnostics,
        };
      }
      return {
        applied: true,
        reason: 'claude_shared_group_auth_surface_rewritten',
        targetMaterializedRoot: target.metadata.runtimeMaterializedRoot,
        targetMaterializedEnv: {
          CLAUDE_CONFIG_DIR: target.metadata.runtimeClaudeConfigDir,
        },
        verification: buildSharedGroupVerification({
          record: target.record,
          selectionDescriptor: target.selectionDescriptor,
        }),
      };
    },
    async recoverAfterRuntimeAuthSwitch(input) {
      const record = readCredentialRecord(input);
      return {
        recovered: false,
        recovery: 'restart_rematerialize',
        ...(record ? { plan: resolveClaudeConnectedServiceRuntimeAuthSwitchPlan(record) } : {}),
      };
    },
    async verifyActiveAccount(input) {
      const record = readCredentialRecord(input);
      if (!record) {
        return {
          status: 'unavailable',
          retryable: true,
          reason: 'missing_connected_service_record',
        };
      }
      if (record.serviceId === 'anthropic') {
        return {
          status: 'verified',
          providerAccountId: record.kind === 'token' ? record.token.providerAccountId : record.oauth.providerAccountId,
          reason: 'anthropic_api_key_materialized',
        };
      }
      const recordHealth = classifyClaudeCodeCredentialHealth(record);
      if (recordHealth.status !== 'ok') {
        return {
          status: 'unavailable',
          retryable: false,
          reason: recordHealth.status,
          errorClassification: {
            missingScopes: [...recordHealth.missingScopes],
          },
        };
      }
      const claudeConfigDir = readClaudeConfigDir(input);
      if (!claudeConfigDir) {
        return {
          status: 'unavailable',
          retryable: false,
          reason: 'missing_materialized_claude_config_dir',
          errorClassification: {
            missingScopes: [],
          },
        };
      }
      const nativeAuth = await verifyClaudeCodeNativeAuth({ claudeConfigDir });
      if (nativeAuth.status !== 'ok') {
        return {
          status: 'unavailable',
          // An expired materialized credential is recoverable via a fresh credential
          // refresh + rematerialize; shape/scope defects are not.
          retryable: nativeAuth.status === 'expired',
          reason: nativeAuth.status,
          errorClassification: {
            missingScopes: [...nativeAuth.missingScopes],
          },
        };
      }
      const target = resolveClaudeSharedGroupHotApplyTarget(input.selection);
      if (target && await materializedCredentialMatchesRecord({ record, claudeConfigDir })) {
        const proof = await verifyClaudeSharedGroupGenerationApplication({
          serviceId: 'claude-subscription',
          groupId: target.selectionDescriptor.groupId,
          profileId: target.selectionDescriptor.activeProfileId,
          generation: target.selectionDescriptor.generation,
          credentialRevision: target.credentialRevision,
          environmentVariables: { CLAUDE_CONFIG_DIR: claudeConfigDir },
        });
        if (proof.status === 'verified') {
          const recordIdentity = readClaudeSubscriptionCredentialIdentity(record);
          return {
            ...proof,
            proofStrength: 'exact' as const,
            providerAccountId: recordIdentity?.providerAccountId ?? null,
            activeAccountId: recordIdentity?.providerEmail ?? null,
          };
        }
      }
      return {
        status: 'unavailable',
        retryable: true,
        reason: 'claude_code_runtime_account_adoption_unproven',
        errorClassification: {
          missingScopes: [],
        },
      };
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
