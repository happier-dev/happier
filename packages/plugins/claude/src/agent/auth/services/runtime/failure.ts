import { readFile } from 'node:fs/promises';

import type {
    OauthCredentialRecord,
    TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { parseCredentialRecord } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

import {
  buildClaudeCodeCredentialPayload,
  computeClaudeCodeCredentialAccountProofFingerprint,
  resolveClaudeCodeCredentialsFilePath,
} from '../native/credentials.js';
import { materializeClaudeCodeNativeAuth } from '../native/materialize.js';
import { verifyClaudeCodeNativeAuth } from '../native/verify.js';
import {
  buildClaudeCodeNativeAuthProvenance,
  readClaudeCodeNativeAuthProvenance,
  writeClaudeCodeNativeAuthProvenance,
} from '../native/provenance.js';
import { mapClaudeRateLimitEventToUsageDetails } from './usage.js';

export type ClaudeConnectedServiceRuntimeFailureKind =
  | 'usage_limit'
  | 'rate_limit'
  | 'temporary_throttle'
  | 'capacity'
  | 'dependency_failure'
  | 'auth_expired'
  | 'account_changed'
  | 'refresh_failed'
  | 'permission_denied'
  | 'plan'
  | 'validation'
  | 'account_disabled'
  | 'unknown';

export function containsDefinitiveClaudeOAuthRevocationEvidence(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    return /\boauth(?: access)? token (?:has been (?:revoked|expired)|has expired)\b/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsDefinitiveClaudeOAuthRevocationEvidence(entry, depth + 1));
  }
  if (typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((entry) =>
    containsDefinitiveClaudeOAuthRevocationEvidence(entry, depth + 1),
  );
}

export type ClaudeConnectedServiceRuntimeFailureClassification = Readonly<{
  kind: ClaudeConnectedServiceRuntimeFailureKind;
  limitCategory?:
    | 'usage_limit'
    | 'rate_limit'
    | 'capacity'
    | 'temporary_throttle'
    | 'auth_invalid'
    | 'plan_invalid'
    | 'validation_failed'
    | 'disabled'
    | 'unknown';
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  groupGeneration?: number | null;
  expectedCredentialRevision?: string | null;
  sourceProviderAccountId?: string | null;
  sourceAccountLabel?: string | null;
  resetsAtMs: number | null;
  retryAfterMs?: number | null;
  planType: string | null;
  providerLimitId?: string | null;
  quotaScope?: 'account' | 'workspace' | 'organization' | 'model' | 'provider' | 'unknown';
  action?: Readonly<{ kind: 'open_url'; url: string }> | null;
  rateLimits: unknown | null;
  source: 'structured_provider_error' | 'stable_provider_message' | 'provider_runtime_marker';
  recoveryAction?:
    | Readonly<{ kind: 'provider_state_sharing_required' }>
    | Readonly<{ kind: 'quota_recovery_required' }>
    | null;
}>;

export type ClaudeRuntimeAuthTargetInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  selection: unknown;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  materializedEnv?: Readonly<Record<string, string>> | null;
  env?: Readonly<Record<string, string>> | null;
}>;

export type ClaudeRuntimeFailureInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  error: unknown;
  selection?: unknown;
}>;

export type ClaudeRuntimeAuthAdapterResult = Readonly<Record<string, unknown>>;

export type ClaudeConnectedServiceAccountTransitionVerificationResult =
  | Readonly<{
      status: 'verified';
      providerAccountId?: string | null;
      activeAccountId?: string | null;
      sharedAuthSurfaceId?: string | null;
      proofStrength?: 'exact' | 'weak' | 'diagnostic';
      source?: string;
      reason?: string;
      generationApplication?: Readonly<{
        serviceId: string;
        groupId: string;
        profileId: string;
        generation: number;
        credentialRevision: string;
        credentialFingerprint: string;
      }>;
    }>
  | Readonly<{
      status: 'weakly_verified';
      providerAccountId?: string | null;
      activeAccountId?: string | null;
      sharedAuthSurfaceId?: string | null;
      proofStrength?: 'exact' | 'weak' | 'diagnostic';
      source?: string;
      reason: string;
    }>
  | Readonly<{
      status: 'mismatch';
      expectedProviderAccountId?: string | null;
      actualProviderAccountId?: string | null;
      retryable: boolean;
      reason?: string;
    }>
  | Readonly<{
      status: 'unavailable';
      retryable: boolean;
      reason: string;
      errorClassification?: unknown;
    }>;

export type ClaudeConnectedServiceRuntimeAuthAdapter = Readonly<{
  resolveDestinationHome?(input: ClaudeRuntimeAuthTargetInput): string | null;
  classifyRuntimeAuthFailure(input: ClaudeRuntimeFailureInput): ClaudeConnectedServiceRuntimeFailureClassification | null;
  materializeActiveProfile(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
  canHotApply(input: ClaudeRuntimeAuthTargetInput): ClaudeRuntimeAuthAdapterResult;
  hotApply(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
  recoverAfterRuntimeAuthSwitch(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
  verifyActiveAccount?(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeConnectedServiceAccountTransitionVerificationResult>;
  probeQuota(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
  refreshActiveProfile(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
}>;

export type ClassifyClaudeConnectedServiceRuntimeAuthFailureInput = Readonly<{
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  groupGeneration?: number | null;
  credentialRevision?: string | null;
  sourceProviderAccountId?: string | null;
  sourceAccountLabel?: string | null;
  error: unknown;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonnegativeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readCredentialRecord(value: unknown): OauthCredentialRecord | TokenCredentialRecord | null {
  const parsed = parseCredentialRecord(value);
  if (!parsed || (parsed.kind !== 'oauth' && parsed.kind !== 'token')) return null;
  const record = readRecord(value);
  if (!record) return null;
  const serviceId = readString(record.serviceId);
  const profileId = readString(record.profileId);
  if (!serviceId || !profileId) return null;
  return parsed;
}

function readCredentialProviderAccountId(record: OauthCredentialRecord | TokenCredentialRecord | null): string | null {
  if (!record) return null;
  return record.kind === 'oauth'
    ? readString(record.oauth.providerAccountId)
    : readString(record.token.providerAccountId);
}

function readCredentialProviderEmail(record: OauthCredentialRecord | TokenCredentialRecord | null): string | null {
  if (!record) return null;
  return record.kind === 'oauth'
    ? readString(record.oauth.providerEmail)
    : readString(record.token.providerEmail);
}

function readExecRuntimeService(value: unknown): ExecService | null {
  const record = readRecord(value);
  return typeof record?.run === 'function'
    && typeof record.spawn === 'function'
    && typeof readRecord(record.clients)?.spawn === 'function'
    && typeof readRecord(record.systemTools)?.resolve === 'function'
    ? record as unknown as ExecService
    : null;
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error ?? '');
}

function hasClaudeAuthFailureEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /auth|credential|login|oauth|token|unauthori[sz]ed|api[_ -]?error[_ -]?status.*401|401/u.test(value);
  }
  if (Array.isArray(value)) return value.some(hasClaudeAuthFailureEvidence);
  const record = readRecord(value);
  if (!record) return false;
  const status =
    record.apiErrorStatus
    ?? record.api_error_status
    ?? record.errorStatus
    ?? record.error_status
    ?? record.status
    ?? record.statusCode
    ?? record.status_code;
  if (status === 401 || status === '401') return true;
  return [
    record.error,
    record.errors,
    record.code,
    record.type,
    record.kind,
    record.message,
    record.detail,
    record.details,
    record.description,
    record.response,
  ].some(hasClaudeAuthFailureEvidence);
}

function classifyGenericRuntimeAuthFailure(
  input: ClassifyClaudeConnectedServiceRuntimeAuthFailureInput,
): ClaudeConnectedServiceRuntimeFailureClassification | null {
  const message = readMessage(input.error).toLowerCase();
  if (/usage\s*limit|rate\s*limit|quota|too many requests/.test(message)) {
    return {
      kind: /rate\s*limit|too many requests/.test(message) ? 'rate_limit' : 'usage_limit',
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      ...runtimeFailureIdentity(input),
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
  }
  if (/auth|credential|login|token/.test(message)) {
    return {
      kind: 'auth_expired',
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      ...runtimeFailureIdentity(input),
      resetsAtMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
  }
  return null;
}

function runtimeFailureIdentity(
  input: ClassifyClaudeConnectedServiceRuntimeAuthFailureInput,
): Partial<ClaudeConnectedServiceRuntimeFailureClassification> {
  return {
    ...(input.groupGeneration !== undefined && input.groupGeneration !== null
      ? { groupGeneration: input.groupGeneration }
      : {}),
    ...(input.credentialRevision ? { expectedCredentialRevision: input.credentialRevision } : {}),
    ...(input.sourceProviderAccountId ? { sourceProviderAccountId: input.sourceProviderAccountId } : {}),
    ...(input.sourceProviderAccountId && input.sourceAccountLabel ? { sourceAccountLabel: input.sourceAccountLabel } : {}),
  };
}

export function classifyClaudeConnectedServiceRuntimeAuthFailure(
  input: ClassifyClaudeConnectedServiceRuntimeAuthFailureInput,
): ClaudeConnectedServiceRuntimeFailureClassification | null {
  const details = mapClaudeRateLimitEventToUsageDetails(input.error);
  if (!details) {
    if (!hasClaudeAuthFailureEvidence(input.error)) return classifyGenericRuntimeAuthFailure(input);
    return {
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: input.serviceId,
      profileId: input.profileId,
      groupId: input.groupId,
      ...runtimeFailureIdentity(input),
      resetsAtMs: null,
      retryAfterMs: null,
      planType: null,
      rateLimits: null,
      source: 'structured_provider_error',
    };
  }
  const limitCategory = details.limitCategory
    ?? (details.providerLimitId === 'transient'
      ? 'rate_limit'
      : details.utilization !== null && details.utilization < 100 ? 'rate_limit' : 'usage_limit');
  return {
    kind: details.providerLimitId === 'transient'
      ? 'temporary_throttle'
      : limitCategory === 'capacity'
        ? 'capacity'
        : limitCategory === 'rate_limit'
          ? 'rate_limit'
          : 'usage_limit',
    limitCategory,
    serviceId: input.serviceId,
    profileId: input.profileId,
    groupId: input.groupId,
    ...runtimeFailureIdentity(input),
    resetsAtMs: details.resetAtMs,
    retryAfterMs: details.retryAfterMs,
    providerLimitId: details.providerLimitId ?? null,
    quotaScope: details.quotaScope,
    action: details.action,
    planType: details.planType,
    rateLimits: details,
    source: 'structured_provider_error',
  };
}

function readMaterializedClaudeConfigDir(input: Readonly<{
  selection?: unknown;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  materializedEnv?: Readonly<Record<string, string>> | null;
  env?: Readonly<Record<string, string>> | null;
}>): string | null {
  const selection = readRecord(input.selection);
  const selectionTargetMaterializedEnv = readRecord(selection?.targetMaterializedEnv);
  const selectionMaterializedEnv = readRecord(selection?.materializedEnv);
  const selectionEnv = readRecord(selection?.env);
  const raw =
    readString(selectionTargetMaterializedEnv?.CLAUDE_CONFIG_DIR)
    ?? readString(selectionMaterializedEnv?.CLAUDE_CONFIG_DIR)
    ?? readString(selectionEnv?.CLAUDE_CONFIG_DIR)
    ?? readString(selection?.targetMaterializedRoot)
    ?? input.targetMaterializedEnv?.CLAUDE_CONFIG_DIR
    ?? input.materializedEnv?.CLAUDE_CONFIG_DIR
    ?? input.env?.CLAUDE_CONFIG_DIR
    ?? null;
  return readString(raw);
}

function readSelectionIds(selection: unknown): Readonly<{
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  groupGeneration: number | null;
  credentialRevision: string | null;
  sourceProviderAccountId: string | null;
  sourceAccountLabel: string | null;
}> {
  const record = readRecord(selection);
  const credential = readCredentialRecord(record?.record);
  return {
    serviceId: readString(record?.serviceId) ?? 'claude-subscription',
    profileId: readString(record?.activeProfileId ?? record?.profileId),
    groupId: readString(record?.groupId),
    groupGeneration: readNonnegativeInteger(record?.groupGeneration ?? record?.generation),
    credentialRevision: readString(record?.credentialRevision),
    sourceProviderAccountId:
      readString(record?.sourceProviderAccountId)
      ?? readCredentialProviderAccountId(credential),
    sourceAccountLabel:
      readString(record?.sourceAccountLabel)
      ?? readCredentialProviderEmail(credential),
  };
}

function isClaudeSubscriptionGroupOAuthSelection(selection: unknown): selection is Record<string, unknown> {
  const record = readRecord(selection);
  if (!record) return false;
  const selectionServiceId = readString(record.serviceId);
  const credential = readCredentialRecord(record?.record);
  return (
    (selectionServiceId === null || selectionServiceId === 'claude-subscription')
    && readString(record.groupId) !== null
    && readString(record.activeProfileId) !== null
    && readNonnegativeInteger(record.groupGeneration ?? record.generation) !== null
    && credential !== null
    && readString(credential.serviceId) === 'claude-subscription'
    && credential.kind === 'oauth'
  );
}

async function materializedCredentialMatchesRecord(params: Readonly<{
  record: OauthCredentialRecord | TokenCredentialRecord;
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
  record: OauthCredentialRecord | TokenCredentialRecord;
  groupId: string;
  generationApplication?: Readonly<{
    generation: number;
    credentialRevision: string;
    credentialFingerprint: string;
  }>;
}>) {
  return {
    status: 'weakly_verified' as const,
    providerAccountId: readCredentialProviderAccountId(params.record),
    activeAccountId: readCredentialProviderEmail(params.record),
    sharedAuthSurfaceId: params.groupId,
    proofStrength: 'weak' as const,
    source: 'shared_group_auth_surface',
    reason: 'claude_shared_group_auth_surface_rewritten',
    ...(params.generationApplication ? {
      status: 'verified' as const,
      proofStrength: 'exact' as const,
      generationApplication: {
        serviceId: 'claude-subscription',
        groupId: params.groupId,
        profileId: params.record.profileId,
        ...params.generationApplication,
      },
    } : {}),
  };
}

async function verifyClaudeSharedGroupApplication(params: Readonly<{
  claudeConfigDir: string;
  record: OauthCredentialRecord | TokenCredentialRecord;
  groupId: string;
  generation: number;
  credentialRevision: string;
}>): Promise<ClaudeConnectedServiceAccountTransitionVerificationResult> {
  const nativeVerification = await verifyClaudeCodeNativeAuth({ claudeConfigDir: params.claudeConfigDir });
  if (nativeVerification.status !== 'ok') {
    return {
      status: 'unavailable',
      retryable: nativeVerification.status === 'expired',
      reason: nativeVerification.status,
    };
  }
  const provenance = await readClaudeCodeNativeAuthProvenance(params.claudeConfigDir);
  if (
    provenance?.groupId !== params.groupId
    || provenance.credentialProfileId !== params.record.profileId
    || provenance.generation !== params.generation
    || provenance.credentialRevision !== params.credentialRevision
    || provenance.credentialFingerprint === undefined
    || !await materializedCredentialMatchesRecord({ record: params.record, claudeConfigDir: params.claudeConfigDir })
  ) {
    return {
      status: 'unavailable',
      retryable: true,
      reason: 'claude_code_runtime_account_adoption_unproven',
    };
  }
  return buildSharedGroupVerification({
    record: params.record,
    groupId: params.groupId,
    generationApplication: {
      generation: params.generation,
      credentialRevision: params.credentialRevision,
      credentialFingerprint: provenance.credentialFingerprint,
    },
  });
}

export function createClaudeConnectedServiceRuntimeAuthAdapter(): ClaudeConnectedServiceRuntimeAuthAdapter {
  return {
    resolveDestinationHome(input) {
      return readMaterializedClaudeConfigDir(input);
    },
    classifyRuntimeAuthFailure(input) {
      return classifyClaudeConnectedServiceRuntimeAuthFailure({
        ...readSelectionIds(input.selection),
        error: input.error,
      });
    },
    async materializeActiveProfile() {
      return { supported: false, recovery: 'restart_resume' };
    },
    canHotApply(input) {
      const claudeConfigDir = readMaterializedClaudeConfigDir(input);
      if (claudeConfigDir && isClaudeSubscriptionGroupOAuthSelection(input.selection)) {
        return {
          supported: true,
          mode: 'claude_subscription_shared_group_auth_surface_rewrite',
        };
      }
      return { supported: false, reason: 'hot_apply_unsupported', recovery: 'restart_resume' };
    },
    async hotApply(input) {
      const claudeConfigDir = readMaterializedClaudeConfigDir(input);
      if (!claudeConfigDir || !isClaudeSubscriptionGroupOAuthSelection(input.selection)) {
        return { applied: false, reason: 'hot_apply_unsupported', recovery: 'restart_resume' };
      }
      const selection = readRecord(input.selection)!;
      const record = readCredentialRecord(selection.record)!;
      const groupId = readString(selection.groupId)!;
      const generation = readNonnegativeInteger(selection.groupGeneration ?? selection.generation);
      const credentialRevision = readString(selection.credentialRevision);
      const result = await materializeClaudeCodeNativeAuth({
        exec: readExecRuntimeService(selection.exec),
        record,
        claudeConfigDir,
      });
      if (result.status !== 'materialized' || result.diagnostics.some((diagnostic) => diagnostic.severity === 'blocking')) {
        return {
          applied: false,
          reason: result.diagnostics[0]?.code ?? 'claude_shared_group_auth_surface_materialization_failed',
          recovery: 'restart_resume',
          diagnostics: result.diagnostics,
        };
      }
      if (generation === null || credentialRevision === null) {
        return { applied: false, reason: 'claude_shared_group_auth_surface_epoch_missing', recovery: 'restart_resume' };
      }
      const built = buildClaudeCodeCredentialPayload(record);
      if (built.status !== 'ok') {
        return { applied: false, reason: 'claude_shared_group_auth_surface_provenance_unavailable', recovery: 'restart_resume' };
      }
      const provenance = buildClaudeCodeNativeAuthProvenance({
        record,
        payload: built.payload,
        groupId,
        generation,
        credentialRevision,
      });
      await writeClaudeCodeNativeAuthProvenance({ claudeConfigDir, provenance });
      const verification = await verifyClaudeSharedGroupApplication({
        claudeConfigDir,
        record,
        groupId,
        generation,
        credentialRevision,
      });
      if (verification.status !== 'verified') {
        return { applied: false, reason: verification.reason, recovery: 'restart_resume' };
      }
      return {
        applied: true,
        reason: 'claude_shared_group_auth_surface_rewritten',
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
        verification,
      };
    },
    async recoverAfterRuntimeAuthSwitch(input) {
      const selection = readRecord(input.selection);
      const restartAndResume = selection?.restartAndResume;
      if (typeof restartAndResume !== 'function') {
        return { recovered: false, reason: 'missing_restart_resume' };
      }
      await restartAndResume();
      return { recovered: true, recovery: 'restart_resume' };
    },
    async verifyActiveAccount(input) {
      const claudeConfigDir = readMaterializedClaudeConfigDir(input);
      if (!claudeConfigDir) {
        return {
          status: 'unavailable',
          retryable: false,
          reason: 'missing_materialized_claude_config_dir',
        };
      }
      if (!isClaudeSubscriptionGroupOAuthSelection(input.selection)) {
        const verification = await verifyClaudeCodeNativeAuth({ claudeConfigDir });
        return verification.status === 'ok'
          ? { status: 'unavailable', retryable: true, reason: 'claude_code_runtime_account_adoption_unproven' }
          : { status: 'unavailable', retryable: verification.status === 'expired', reason: verification.status };
      }
      const selection = readRecord(input.selection)!;
      const generation = readNonnegativeInteger(selection.groupGeneration ?? selection.generation);
      const credentialRevision = readString(selection.credentialRevision);
      if (generation === null || credentialRevision === null) {
        return { status: 'unavailable', retryable: true, reason: 'claude_shared_group_auth_surface_epoch_missing' };
      }
      return await verifyClaudeSharedGroupApplication({
        claudeConfigDir,
        record: readCredentialRecord(selection.record)!,
        groupId: readString(selection.groupId)!,
        generation,
        credentialRevision,
      });
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}
