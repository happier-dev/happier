import { readClaudeOauthCredentialOrganizationId } from '@happier-dev/protocol/providers/claude/oauth-profile';
import { readClaudeNativeAccountIdentity, reconcileClaudeNativeAccountConfig } from '../native/accountIdentity.js';
import type {
    OauthCredentialRecord,
    TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { parseCredentialRecord } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  AgentConnectedAccountNativeAuthCodecV1,
  AgentConnectedAccountRuntimeAuthAdapterResultV1,
  AgentConnectedAccountRuntimeAuthHotApplyInputV1,
  AgentConnectedAccountRuntimeAuthTargetV1,
  AgentConnectedAccountRuntimeAuthVerificationInputV1,
  AgentConnectedAccountTransitionVerificationResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  buildClaudeCodeCredentialPayload,
  computeClaudeCodeCredentialAccountProofFingerprint,
  parseClaudeCodeCredentialFile,
} from '../native/credentials.js';
import {
  buildClaudeCodeNativeAuthProvenance,
  CLAUDE_CODE_NATIVE_AUTH_PROVENANCE_FILE_NAME,
  parseClaudeCodeNativeAuthProvenance,
} from '../native/provenance.js';
import { mapClaudeProviderFailureToUsageDetails } from './usage.js';
import type { ClaudeSessionRuntimeIssue } from '../../../runtime/issues/runtimeIssues.js';
import { ClaudeSessionRuntimeUsageLimitDetailsSchema, ClaudeSessionRuntimeTemporaryThrottleDetailsSchema } from '../../../runtime/issues/providerFailureDetails.js';

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
  sourceProviderOrganizationId?: string | null;
  providerReportedOrganizationId?: string | null;
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

export type ClaudeRuntimeAuthTargetInput = AgentConnectedAccountRuntimeAuthTargetV1;
export type ClaudeRuntimeAuthHotApplyInput = AgentConnectedAccountRuntimeAuthHotApplyInputV1;
export type ClaudeRuntimeAuthVerificationInput = AgentConnectedAccountRuntimeAuthVerificationInputV1;

export type ClaudeRuntimeFailureInput = Readonly<{
  target: Readonly<{ agentId: string; targetId?: string | null }>;
  error: unknown;
  selection?: unknown;
  normalizedDetails?: Pick<ClaudeSessionRuntimeIssue, 'usageLimit' | 'temporaryThrottle'>;
}>;

export type ClaudeRuntimeAuthAdapterResult = AgentConnectedAccountRuntimeAuthAdapterResultV1;

export type ClaudeConnectedServiceAccountTransitionVerificationResult =
  AgentConnectedAccountTransitionVerificationResultV1;

export type ClaudeConnectedServiceRuntimeAuthAdapter = Readonly<{
  classifyRuntimeAuthFailure(input: ClaudeRuntimeFailureInput): ClaudeConnectedServiceRuntimeFailureClassification | null;
  materializeActiveProfile(input: ClaudeRuntimeAuthTargetInput): Promise<ClaudeRuntimeAuthAdapterResult>;
  canHotApply(input: ClaudeRuntimeAuthHotApplyInput): ClaudeRuntimeAuthAdapterResult;
  hotApply(input: ClaudeRuntimeAuthHotApplyInput): Promise<ClaudeRuntimeAuthAdapterResult>;
  verifyActiveAccount?(input: ClaudeRuntimeAuthVerificationInput): Promise<ClaudeConnectedServiceAccountTransitionVerificationResult>;
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
  sourceProviderOrganizationId?: string | null;
  providerReportedOrganizationId?: string | null;
  sourceAccountLabel?: string | null;
  error: unknown;
  normalizedDetails?: Pick<ClaudeSessionRuntimeIssue, 'usageLimit' | 'temporaryThrottle'>;
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
    ...(Object.prototype.hasOwnProperty.call(input, 'sourceProviderAccountId') ? {sourceProviderAccountId: input.sourceProviderAccountId ?? null} : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'sourceProviderOrganizationId') ? {sourceProviderOrganizationId: input.sourceProviderOrganizationId ?? null} : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'providerReportedOrganizationId') ? {providerReportedOrganizationId: input.providerReportedOrganizationId ?? null} : {}),
    ...(input.sourceProviderAccountId && input.sourceAccountLabel ? { sourceAccountLabel: input.sourceAccountLabel } : {}),
  };
}

export function classifyClaudeConnectedServiceRuntimeAuthFailure(
  input: ClassifyClaudeConnectedServiceRuntimeAuthFailureInput,
): ClaudeConnectedServiceRuntimeFailureClassification | null {
  const temporaryThrottle = input.normalizedDetails?.temporaryThrottle;
  if (temporaryThrottle) {
    return {
      kind: 'temporary_throttle', limitCategory: 'temporary_throttle', quotaScope: 'provider',
      serviceId: input.serviceId, profileId: input.profileId, groupId: input.groupId,
      ...runtimeFailureIdentity(input), resetsAtMs: null, retryAfterMs: temporaryThrottle.retryAfterMs,
      planType: null, rateLimits: temporaryThrottle, source: 'structured_provider_error',
    };
  }
  const details = input.normalizedDetails?.usageLimit
    ?? mapClaudeProviderFailureToUsageDetails(input.error);
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
      : details.utilization != null && details.utilization < 100 ? 'rate_limit' : 'usage_limit');
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
    action: details.action?.kind === 'open_url' ? { kind: 'open_url', url: details.action.url } : null,
    planType: details.planType ?? null,
    rateLimits: details,
    source: 'structured_provider_error',
  };
}

function readSelectionIds(selection: unknown): Readonly<{
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
  groupGeneration: number | null;
  credentialRevision: string | null;
  sourceProviderAccountId?: string | null;
  sourceProviderOrganizationId?: string | null;
  sourceAccountLabel: string | null;
  providerReportedOrganizationId?: string | null;
}> {
  const record = readRecord(selection);
  return {
    // Canonical qualified Plugin contribution key; released scalar ingress is
    // normalized by the host sanitize owner before adapter selection.
    serviceId: readString(record?.serviceId) ?? 'happier.agent.claude/claude-subscription',
    profileId: readString(record?.activeProfileId ?? record?.profileId),
    groupId: readString(record?.groupId),
    groupGeneration: readNonnegativeInteger(record?.groupGeneration ?? record?.generation),
    credentialRevision: readString(record?.credentialRevision),
    ...(record && Object.prototype.hasOwnProperty.call(record, 'sourceProviderAccountId') ? {sourceProviderAccountId: readString(record.sourceProviderAccountId)} : {}),
    ...(record && Object.prototype.hasOwnProperty.call(record, 'sourceProviderOrganizationId') ? {sourceProviderOrganizationId: readString(record.sourceProviderOrganizationId)} : {}),
    sourceAccountLabel:
      readString(record?.sourceAccountLabel),
    ...(record && Object.prototype.hasOwnProperty.call(record, 'providerReportedOrganizationId') ? {providerReportedOrganizationId: readString(record.providerReportedOrganizationId)} : {}),
  };
}

function isClaudeSubscriptionGroupOAuthSelection(input: ClaudeRuntimeAuthTargetInput): boolean {
  const record = readRecord(input.selection);
  if (!record) return false;
  const selectionServiceId = readString(record.serviceId);
  // Current hosts address this service by its canonical qualified Plugin
  // contribution key; `null` remains tolerated for selections that omit the id.
  return (
    (selectionServiceId === null || selectionServiceId === 'happier.agent.claude/claude-subscription')
    && readString(record.groupId) !== null
    && readString(record.activeProfileId) !== null
    && readNonnegativeInteger(record.groupGeneration ?? record.generation) !== null
  );
}

function parseJsonFile(files: Readonly<Record<string, Uint8Array>>, fileId: string): unknown {
  const bytes = files[fileId];
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function materializedCredentialMatchesRecord(params: Readonly<{
  record: OauthCredentialRecord | TokenCredentialRecord;
  files: Readonly<Record<string, Uint8Array>>;
}>): boolean {
  const built = buildClaudeCodeCredentialPayload(params.record);
  if (built.status !== 'ok') return false;
  const rootIdentity = readClaudeNativeAccountIdentity(parseJsonFile(params.files, '.claude.json'));
  const expectedOrganizationId = params.record.kind === 'oauth'
    ? readClaudeOauthCredentialOrganizationId(params.record.oauth.raw) : null;
  const expectedAccountId = readCredentialProviderAccountId(params.record);
  if ((expectedAccountId && rootIdentity?.providerAccountId !== expectedAccountId)
    || (expectedOrganizationId && rootIdentity?.providerOrganizationId !== expectedOrganizationId)) return false;
  const raw = parseJsonFile(params.files, '.credentials.json');
  const actual = computeClaudeCodeCredentialAccountProofFingerprint(raw);
  const expected = computeClaudeCodeCredentialAccountProofFingerprint(built.payload);
  return actual !== null && actual === expected;
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
  if (params.generationApplication) {
    return {
      status: 'verified' as const,
      providerAccountId: readCredentialProviderAccountId(params.record),
      activeAccountId: readCredentialProviderEmail(params.record),
      sharedAuthSurfaceId: params.groupId,
      proofStrength: 'exact' as const,
      source: 'shared_group_auth_surface',
      reason: 'claude_shared_group_auth_surface_rewritten',
      generationApplication: {
        // Canonical qualified Plugin contribution key (SDK verification contract).
        serviceId: 'happier.agent.claude/claude-subscription' as const,
        groupId: params.groupId,
        profileId: params.record.profileId,
        ...params.generationApplication,
      },
    };
  }
  return {
    status: 'weakly_verified' as const,
    providerAccountId: readCredentialProviderAccountId(params.record),
    activeAccountId: readCredentialProviderEmail(params.record),
    sharedAuthSurfaceId: params.groupId,
    proofStrength: 'weak' as const,
    source: 'shared_group_auth_surface',
    reason: 'claude_shared_group_auth_surface_rewritten',
  };
}

function verifyClaudeSharedGroupApplication(params: Readonly<{
  files: Readonly<Record<string, Uint8Array>>;
  record: OauthCredentialRecord | TokenCredentialRecord;
  groupId: string;
  generation: number;
  credentialRevision: string;
}>): ClaudeConnectedServiceAccountTransitionVerificationResult {
  const files = params.files;
  const nativeCredential = parseClaudeCodeCredentialFile(
    parseJsonFile(files, '.credentials.json'),
  );
  if (nativeCredential.status !== 'ok' || !nativeCredential.hasAccessToken) {
    return {
      status: 'unavailable',
      retryable: false,
      reason: nativeCredential.status,
    };
  }
  const provenance = parseClaudeCodeNativeAuthProvenance(
    parseJsonFile(files, CLAUDE_CODE_NATIVE_AUTH_PROVENANCE_FILE_NAME),
  );
  if (
    provenance?.groupId !== params.groupId
    || provenance.credentialProfileId !== params.record.profileId
    || provenance.generation !== params.generation
    || provenance.credentialRevision !== params.credentialRevision
    || provenance.credentialFingerprint === undefined
    || !materializedCredentialMatchesRecord({ record: params.record, files })
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
    classifyRuntimeAuthFailure(input) {
      const diagnosticDetails = readRecord(readRecord(input.error)?.details);
      const usageLimit = ClaudeSessionRuntimeUsageLimitDetailsSchema.safeParse(diagnosticDetails?.usageLimit);
      const temporaryThrottle = ClaudeSessionRuntimeTemporaryThrottleDetailsSchema.safeParse(diagnosticDetails?.temporaryThrottle);
      return classifyClaudeConnectedServiceRuntimeAuthFailure({
        ...readSelectionIds(input.selection),
        error: input.error,
        normalizedDetails: input.normalizedDetails ?? {
          ...(usageLimit.success ? { usageLimit: usageLimit.data } : {}),
          ...(temporaryThrottle.success ? { temporaryThrottle: temporaryThrottle.data } : {}),
        },
      });
    },
    async materializeActiveProfile(input) {
      const selection = readSelectionIds(input.selection);
      if (selection.serviceId === 'happier.agent.claude/claude-subscription'
        && selection.groupId && selection.profileId) {
        // The host rewrites the pool's shared Claude home; Claude reads its new
        // credentials between requests, including within a turn. Actual hot apply
        // still requires the generation-bound native-auth writer and verifier.
        return { supported: true, supportsInTurnApply: true };
      }
      return { supported: false, recovery: 'restart_resume' };
    },
    canHotApply(input) {
      if (input.materializeNativeAuth && isClaudeSubscriptionGroupOAuthSelection(input)) {
        return {
          supported: true,
        };
      }
      return { supported: false, reason: 'hot_apply_unsupported', recovery: 'restart_resume' };
    },
    async hotApply(input) {
      if (!input.materializeNativeAuth || !isClaudeSubscriptionGroupOAuthSelection(input)) {
        return { applied: false, reason: 'hot_apply_unsupported', recovery: 'restart_resume' };
      }
      const verification = await input.materializeNativeAuth();
      if (verification.status !== 'verified') {
        return { applied: false, reason: verification.reason, recovery: 'restart_resume' };
      }
      return {
        applied: true,
        reason: 'claude_shared_group_auth_surface_rewritten',
        verification,
      };
    },
    async verifyActiveAccount(input) {
      if (!input.inspectNativeAuth) {
        return {
          status: 'unavailable',
          retryable: false,
          reason: 'missing_materialized_claude_config_dir',
        };
      }
      if (!isClaudeSubscriptionGroupOAuthSelection(input)) {
        return {
          status: 'unavailable',
          retryable: false,
          reason: 'claude_code_runtime_account_adoption_unproven',
        };
      }
      return await input.inspectNativeAuth();
    },
    async probeQuota() {
      return { status: 'unsupported' };
    },
    async refreshActiveProfile() {
      return { status: 'unsupported' };
    },
  };
}

export function createClaudeConnectedAccountNativeAuthCodec(): AgentConnectedAccountNativeAuthCodecV1 {
  return {
    materialize({ credential, selection, files }) {
      const record = readCredentialRecord(credential);
      const groupId = readString(selection.groupId);
      const generation = readNonnegativeInteger(selection.groupGeneration ?? selection.generation);
      const credentialRevision = readString(selection.credentialRevision);
      if (!record || record.kind !== 'oauth' || record.serviceId !== 'claude-subscription'
        || !groupId || generation === null || !credentialRevision) {
        throw new TypeError('Claude native auth materialization requires an OAuth group generation');
      }
      const built = buildClaudeCodeCredentialPayload(record);
      if (built.status !== 'ok') {
        throw new TypeError('Claude native auth materialization requires a supported OAuth credential');
      }
      const provenance = buildClaudeCodeNativeAuthProvenance({
        record,
        payload: built.payload,
        groupId,
        generation,
        credentialRevision,
      });
      const encoder = new TextEncoder();
      return {
        files: {
          '.credentials.json': encoder.encode(`${JSON.stringify(built.payload)}\n`),
          '.claude.json': encoder.encode(`${JSON.stringify(reconcileClaudeNativeAccountConfig({
            rootConfig: parseJsonFile(files ?? {}, '.claude.json'),
            nativeCredential: built.payload,
            previousCredential: parseJsonFile(files ?? {}, '.credentials.json'),
            providerAccountId: readCredentialProviderAccountId(record),
            providerEmail: readCredentialProviderEmail(record),
            providerOrganizationId: readClaudeOauthCredentialOrganizationId(record.oauth.raw),
          }))}\n`),
          [CLAUDE_CODE_NATIVE_AUTH_PROVENANCE_FILE_NAME]: encoder.encode(`${JSON.stringify(provenance)}\n`),
        },
      };
    },
    inspect({ credential, selection, files }) {
      const record = readCredentialRecord(credential);
      const groupId = readString(selection.groupId);
      const generation = readNonnegativeInteger(selection.groupGeneration ?? selection.generation);
      const credentialRevision = readString(selection.credentialRevision);
      if (!groupId && selection.kind !== 'group' && record?.kind === 'oauth'
        && record.serviceId === 'claude-subscription' && credentialRevision
        && readString(selection.profileId) === record.profileId) {
        if (!materializedCredentialMatchesRecord({ record, files })) {
          return { status: 'unavailable', retryable: true, reason: 'claude_code_runtime_account_adoption_unproven' };
        }
        const credentialFingerprint = computeClaudeCodeCredentialAccountProofFingerprint(parseJsonFile(files, '.credentials.json'));
        if (!credentialFingerprint) {
          return { status: 'unavailable', retryable: true, reason: 'claude_code_runtime_account_adoption_unproven' };
        }
        return { status: 'verified', providerAccountId: readCredentialProviderAccountId(record),
          activeAccountId: readCredentialProviderEmail(record), credentialRevision, credentialFingerprint,
          proofStrength: 'exact', source: 'materialized_native_auth' };
      }
      if (!record || !groupId || generation === null || !credentialRevision) {
        return { status: 'unavailable', retryable: false, reason: 'claude_shared_group_auth_surface_epoch_missing' };
      }
      return verifyClaudeSharedGroupApplication({
        files,
        record,
        groupId,
        generation,
        credentialRevision,
      });
    },
  };
}
