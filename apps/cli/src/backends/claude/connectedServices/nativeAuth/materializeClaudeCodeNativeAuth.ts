import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import { logger } from '@/ui/logger';
import { replaceDirectoryAtomically } from '@/utils/fs/replaceDirectoryAtomically';

import {
  backfillPreviousClaudeHomeSessionFiles,
  resolveClaudeHomeSharingSettings,
  syncClaudeConnectedServiceHome,
} from '../syncClaudeConnectedServiceHome';
import {
  buildClaudeConnectedServiceHomeProvenance,
  isClaudeConnectedServiceHomeGenerationSuperseded,
  matchesClaudeConnectedServiceHomeProvenance,
  readClaudeConnectedServiceHomeProvenance,
  writeClaudeConnectedServiceHomeProvenance,
} from '../claudeConnectedServiceHomeProvenance';
import {
  readClaudeOauthAccountIdentity,
  readClaudeRootConfigFile,
  reconcileClaudeAccountScopedRootConfigFile,
} from '../claudeRootConfig';
import { materializeClaudeWorkspaceTrust } from '../materializeClaudeWorkspaceTrust';
import {
  buildClaudeCodeCredentialPayload,
  computeClaudeCodeCredentialFingerprint,
  readClaudeCodeNativeCredentialFile,
  resolveClaudeCodeCredentialsFilePath,
  writeClaudeCodeCredentialsFile,
  type ClaudeCodeNativeCredentialPayload,
} from './claudeCodeCredentialFile';
import { stripClaudeCodeCredentialFileRefreshTokenFields } from './claudeCodeCredentialFileRefreshTokenStrip';
import { sweepStaleClaudeCodeMacOsKeychainCredentials } from './claudeCodeMacOsKeychain';
import {
  classifyClaudeCodeCredentialHealth,
  type ClaudeCodeCredentialHealth,
  type ClaudeCodeCredentialHealthStatus,
} from './claudeCodeCredentialHealth';
import { readClaudeSubscriptionCredentialIdentity } from './claudeSubscriptionCredentialIdentity';

const CLAUDE_CODE_KEYCHAIN_STALE_SWEEP_DEFER_MS = 30_000;

export type ClaudeCodeNativeAuthMaterializationResult =
  | Readonly<{
      status: 'materialized';
      env: Record<string, string>;
      diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
      credentialPath: string;
    }>
  | Readonly<{
      status: 'diagnostic';
      env: Record<string, string>;
      diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
    }>;

export type ClaudeSubscriptionNativeAuthSelectionDescriptor =
  | Readonly<{
      kind: 'profile';
      serviceId: 'claude-subscription';
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: 'claude-subscription';
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    }>;

export type ClaudeSubscriptionNativeAuthIdentityDiagnostic = Readonly<{
  serviceId: 'claude-subscription';
  selectionKind: 'profile' | 'group';
  profileId?: string;
  groupId?: string;
  activeProfileId?: string;
  targetRootKind: 'profile_home' | 'group_home';
  credentialHealthStatus: ClaudeCodeCredentialHealthStatus;
  hasProviderAccountId: boolean;
  hasProviderEmail: boolean;
}>;

export type ClaudeSubscriptionNativeAuthHomeMaterializationResult =
  ClaudeCodeNativeAuthMaterializationResult & Readonly<{
    identityDiagnostic: ClaudeSubscriptionNativeAuthIdentityDiagnostic;
  }>;

function diagnosticCodeForHealth(health: ClaudeCodeCredentialHealth): string {
  switch (health.status) {
    case 'missing_required_scope':
      return 'claude_subscription_missing_claude_code_scope';
    case 'unsupported_credential_kind':
      return 'claude_subscription_setup_token_not_supported_for_unified';
    case 'missing_access_token':
    case 'missing_refresh_token':
    case 'unsupported_service':
    case 'ok':
      return 'claude_subscription_native_auth_materialization_failed';
  }
}

function credentialRefreshFailureForHealth(
  health: ClaudeCodeCredentialHealth,
): ConnectedServicesMaterializationDiagnostic['credentialRefreshFailure'] {
  switch (health.status) {
    case 'missing_required_scope':
      return {
        category: 'provider_403',
        providerStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      };
    case 'unsupported_credential_kind':
      return {
        category: 'missing_refresh_token',
        providerErrorCode: 'claude_subscription_setup_token_not_supported_for_unified',
      };
    case 'missing_access_token':
      return {
        category: 'missing_access_token',
        providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
      };
    case 'missing_refresh_token':
      return {
        category: 'missing_refresh_token',
        providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
      };
    case 'unsupported_service':
    case 'ok':
      return undefined;
  }
}

function diagnosticForHealth(health: ClaudeCodeCredentialHealth): ConnectedServicesMaterializationDiagnostic {
  const credentialRefreshFailure = credentialRefreshFailureForHealth(health);
  return {
    code: diagnosticCodeForHealth(health),
    providerId: 'claude',
    severity: 'blocking',
    serviceId: 'claude-subscription',
    reason: health.status,
    ...(credentialRefreshFailure ? { credentialRefreshFailure } : {}),
    ...(health.missingScopes.length > 0 ? { entryName: health.missingScopes.join(' ') } : {}),
  };
}

function diagnosticForCredentialFileWriteFailure(): ConnectedServicesMaterializationDiagnostic {
  return {
    code: 'claude_subscription_native_auth_materialization_failed',
    providerId: 'claude',
    severity: 'blocking',
    serviceId: 'claude-subscription',
    reason: 'credential_file_write_failed',
  };
}

function logCredentialMaterializationDecision(params: Readonly<{
  decision: 'refuse';
  diagnosticContext?: Readonly<{
    profileId?: string;
    homeKind?: 'profile' | 'group' | string;
  }>;
  reason: string;
  incomingUpdatedAtMs?: number | null;
}>): void {
  logger.debug('[DAEMON RUN] Claude Code credential materialization decision', {
    event: 'claude_code_credential_materialization_decision',
    ...(params.diagnosticContext ?? {}),
    decision: params.decision,
    comparatorBasis: {
      reason: params.reason,
      incomingUpdatedAtMs: typeof params.incomingUpdatedAtMs === 'number' && Number.isFinite(params.incomingUpdatedAtMs)
        ? Math.trunc(params.incomingUpdatedAtMs)
        : null,
    },
    decidedAtMs: Date.now(),
  });
}

export function diagnoseClaudeCodeNativeAuthMaterialization(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
}>): readonly ConnectedServicesMaterializationDiagnostic[] {
  const built = buildClaudeCodeCredentialPayload(params.record);
  return built.status === 'ok' ? [] : [diagnosticForHealth(built.health)];
}

export async function materializeClaudeCodeNativeAuth(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  claudeConfigDir: string;
  compareCredentialPath?: string;
  preserveNewerExistingCredential?: boolean;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
  diagnosticContext?: Readonly<{
    profileId?: string;
    homeKind?: 'profile' | 'group' | string;
  }>;
}>): Promise<ClaudeCodeNativeAuthMaterializationResult> {
  const built = buildClaudeCodeCredentialPayload(params.record);
  if (built.status !== 'ok') {
    logCredentialMaterializationDecision({
      decision: 'refuse',
      diagnosticContext: params.diagnosticContext ?? {
        profileId: params.record.profileId,
        homeKind: 'unknown',
      },
      reason: built.health.status,
      incomingUpdatedAtMs: params.record.updatedAt,
    });
    return {
      status: 'diagnostic',
      env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
      diagnostics: [diagnosticForHealth(built.health)],
    };
  }
  let credentialPath: string;
  try {
    credentialPath = await writeClaudeCodeCredentialsFile({
      claudeConfigDir: params.claudeConfigDir,
      payload: built.payload,
      incomingUpdatedAtMs: params.record.updatedAt,
      compareCredentialPath: params.compareCredentialPath,
      preserveNewerExistingCredential: params.preserveNewerExistingCredential,
      homeDir: params.homeDir,
      username: params.username,
      diagnosticContext: params.diagnosticContext ?? {
        profileId: params.record.profileId,
        homeKind: 'unknown',
      },
    });
  } catch {
    logCredentialMaterializationDecision({
      decision: 'refuse',
      diagnosticContext: params.diagnosticContext ?? {
        profileId: params.record.profileId,
        homeKind: 'unknown',
      },
      reason: 'credential_file_write_failed',
      incomingUpdatedAtMs: params.record.updatedAt,
    });
    return {
      status: 'diagnostic',
      env: { CLAUDE_CONFIG_DIR: params.claudeConfigDir },
      diagnostics: [diagnosticForCredentialFileWriteFailure()],
    };
  }
  return {
    status: 'materialized',
    env: {
      CLAUDE_CONFIG_DIR: params.claudeConfigDir,
    },
    diagnostics: [],
    credentialPath,
  };
}

function credentialDiagnosticContextForSelection(
  selectionDescriptor: ClaudeSubscriptionNativeAuthSelectionDescriptor,
): Readonly<{ profileId: string; homeKind: 'profile' | 'group' }> {
  return selectionDescriptor.kind === 'group'
    ? { profileId: selectionDescriptor.activeProfileId, homeKind: 'group' }
    : { profileId: selectionDescriptor.profileId, homeKind: 'profile' };
}

function stripRefreshTokenForCredentialFileFingerprint(
  payload: ClaudeCodeNativeCredentialPayload,
): ClaudeCodeNativeCredentialPayload {
  const { refreshToken: _refreshToken, ...credential } = payload.claudeAiOauth;
  return {
    claudeAiOauth: credential,
  };
}

async function isClaudeSubscriptionNativeCredentialFileCurrent(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  selectionDescriptor: ClaudeSubscriptionNativeAuthSelectionDescriptor;
  targetClaudeConfigDir: string;
}>): Promise<boolean> {
  const expectedProvenance = buildClaudeConnectedServiceHomeProvenance({
    record: params.record,
    selectionDescriptor: params.selectionDescriptor,
  });
  if (
    !matchesClaudeConnectedServiceHomeProvenance(
      expectedProvenance,
      await readClaudeConnectedServiceHomeProvenance(params.targetClaudeConfigDir),
    )
  ) {
    return false;
  }
  const existingCredential = await readClaudeCodeNativeCredentialFile(params.targetClaudeConfigDir);
  if (!existingCredential) return false;
  const builtCredential = buildClaudeCodeCredentialPayload(params.record);
  if (builtCredential.status !== 'ok') return false;
  const expectedFileFingerprint = computeClaudeCodeCredentialFingerprint(
    stripRefreshTokenForCredentialFileFingerprint(builtCredential.payload),
  );
  return computeClaudeCodeCredentialFingerprint(existingCredential.payload) === expectedFileFingerprint;
}

function alreadyMaterializedClaudeCodeNativeAuthResult(
  claudeConfigDir: string,
): ClaudeCodeNativeAuthMaterializationResult {
  return {
    status: 'materialized',
    env: {
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
    diagnostics: [],
    credentialPath: resolveClaudeCodeCredentialsFilePath(claudeConfigDir),
  };
}

function hasNonBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildClaudeSubscriptionNativeAuthIdentityDiagnostic(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  selectionDescriptor: ClaudeSubscriptionNativeAuthSelectionDescriptor;
  credentialHealthStatus: ClaudeCodeCredentialHealthStatus;
}>): ClaudeSubscriptionNativeAuthIdentityDiagnostic {
  const credentialIdentity = readClaudeSubscriptionCredentialIdentity(params.record);
  const base = {
    serviceId: 'claude-subscription' as const,
    credentialHealthStatus: params.credentialHealthStatus,
    hasProviderAccountId: hasNonBlankString(credentialIdentity?.providerAccountId),
    hasProviderEmail: hasNonBlankString(credentialIdentity?.providerEmail),
  };
  if (params.selectionDescriptor.kind === 'group') {
    return {
      ...base,
      selectionKind: 'group',
      groupId: params.selectionDescriptor.groupId,
      activeProfileId: params.selectionDescriptor.activeProfileId,
      targetRootKind: 'group_home',
    };
  }
  return {
    ...base,
    selectionKind: 'profile',
    profileId: params.selectionDescriptor.profileId,
    targetRootKind: 'profile_home',
  };
}

const scheduledStaleClaudeCodeMacOsKeychainSweepKeys = new Set<string>();

/** AT-4: reset the module-level sweep dedupe between tests (darwin-only path; order-determinism). */
export function resetScheduledStaleClaudeCodeMacOsKeychainSweepKeysForTests(): void {
  scheduledStaleClaudeCodeMacOsKeychainSweepKeys.clear();
}

/**
 * Reconcile the login keychain: delete every obsolete Happier-managed derived (suffixed) item for the
 * current user account. Under the file-only design nothing writes or reads a derived item, so any that
 * survive are legacy cruft (e.g. items written before the writer was removed) — they must be removed so
 * a stale token can never shadow the authoritative `.credentials.json`. Deferred off the spawn hot path,
 * deduped per (home, user) while in flight, and idempotent (missing item ⇒ no-op). The user's global
 * `Claude Code-credentials` login and other-account items are never touched (see classifier).
 */
function scheduleStaleClaudeCodeMacOsKeychainCredentialSweep(params: Readonly<{
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
}>): void {
  if (process.platform !== 'darwin') return;
  const key = JSON.stringify({
    homeDir: params.homeDir ?? null,
    username: params.username ?? null,
  });
  if (scheduledStaleClaudeCodeMacOsKeychainSweepKeys.has(key)) return;
  scheduledStaleClaudeCodeMacOsKeychainSweepKeys.add(key);
  const timer = setTimeout(() => {
    void sweepStaleClaudeCodeMacOsKeychainCredentials({
      homeDir: params.homeDir,
      username: params.username,
    }).catch((error) => {
      logger.debug('[DAEMON RUN] Claude Code keychain stale credential sweep failed after spawn hot path', error);
    }).finally(() => {
      scheduledStaleClaudeCodeMacOsKeychainSweepKeys.delete(key);
    });
  }, CLAUDE_CODE_KEYCHAIN_STALE_SWEEP_DEFER_MS);
  timer.unref?.();
}

async function shouldPreserveNewerExistingCredential(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  selectionDescriptor: ClaudeSubscriptionNativeAuthSelectionDescriptor;
  targetClaudeConfigDir: string;
}>): Promise<boolean> {
  const existingProvenance = await readClaudeConnectedServiceHomeProvenance(params.targetClaudeConfigDir);
  return isClaudeConnectedServiceHomeGenerationSuperseded({
    incomingSelection: params.selectionDescriptor,
    existingProvenance,
  }) || matchesClaudeConnectedServiceHomeProvenance(
    buildClaudeConnectedServiceHomeProvenance({
      record: params.record,
      selectionDescriptor: params.selectionDescriptor,
    }),
    existingProvenance,
  );
}

async function shouldPreserveClaudeAccountScopedState(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  targetClaudeConfigDir: string;
}>): Promise<boolean> {
  const credentialIdentity = readClaudeSubscriptionCredentialIdentity(params.record);
  if (!credentialIdentity) return false;
  const provenance = await readClaudeConnectedServiceHomeProvenance(params.targetClaudeConfigDir);
  if (provenance?.credentialProfileId !== params.record.profileId) return false;
  const existingCredential = await readClaudeCodeNativeCredentialFile(params.targetClaudeConfigDir);
  const incomingCredential = buildClaudeCodeCredentialPayload(params.record);
  if (!existingCredential || incomingCredential.status !== 'ok') return false;
  const existingOauth = existingCredential.payload.claudeAiOauth;
  const incomingOauth = incomingCredential.payload.claudeAiOauth;
  if (
    existingOauth.subscriptionType !== incomingOauth.subscriptionType
    || existingOauth.rateLimitTier !== incomingOauth.rateLimitTier
  ) return false;
  const root = await readClaudeRootConfigFile(join(params.targetClaudeConfigDir, '.claude.json'));
  const identity = readClaudeOauthAccountIdentity(root?.oauthAccount);
  if (credentialIdentity.providerAccountId && identity.accountId !== credentialIdentity.providerAccountId) return false;
  if (credentialIdentity.providerEmail && identity.email !== credentialIdentity.providerEmail) return false;
  return true;
}

async function stripLegacyRefreshTokensFromManagedClaudeHome(claudeConfigDir: string): Promise<void> {
  if (!await readClaudeConnectedServiceHomeProvenance(claudeConfigDir)) return;
  await stripClaudeCodeCredentialFileRefreshTokenFields(claudeConfigDir);
}

export async function materializeClaudeSubscriptionNativeAuthHome(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  targetClaudeConfigDir: string;
  sourceEnv: NodeJS.ProcessEnv;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  sessionDirectory?: string | null;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  /** Ambient native store root for self-source sharing-policy reconciliation (RD-MAT-2). */
  ambientStateSourceDir?: string | null;
  selectionDescriptor: ClaudeSubscriptionNativeAuthSelectionDescriptor;
  validateGroupMutationCurrentness?: (
    input: Readonly<{
      serviceId: 'claude-subscription';
      groupId: string;
      profileId: string;
      generation: number;
      credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    }>,
  ) => Promise<Readonly<{ current: boolean }>>;
}>): Promise<ClaudeSubscriptionNativeAuthHomeMaterializationResult> {
  const validateGroupMutationCurrentness = async (): Promise<boolean> => {
    if (params.selectionDescriptor.kind !== 'group' || !params.validateGroupMutationCurrentness) return true;
    const result = await params.validateGroupMutationCurrentness({
      serviceId: 'claude-subscription',
      groupId: params.selectionDescriptor.groupId,
      profileId: params.selectionDescriptor.activeProfileId,
      generation: params.selectionDescriptor.generation,
      credentialRevision: params.selectionDescriptor.credentialRevision ?? null,
    });
    return result.current;
  };
  const supersededResult = (): ClaudeSubscriptionNativeAuthHomeMaterializationResult => ({
    status: 'diagnostic',
    env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
    diagnostics: [{
      code: 'claude_connected_service_generation_superseded',
      providerId: 'claude',
      serviceId: 'claude-subscription',
      severity: 'blocking',
      reason: 'authoritative_group_target_changed_before_materialization',
    }],
    identityDiagnostic: buildClaudeSubscriptionNativeAuthIdentityDiagnostic({
      record: params.record,
      selectionDescriptor: params.selectionDescriptor,
      credentialHealthStatus: classifyClaudeCodeCredentialHealth(params.record).status,
    }),
  });
  if (params.selectionDescriptor.kind === 'profile') {
    await stripLegacyRefreshTokensFromManagedClaudeHome(params.targetClaudeConfigDir);
  }
  // Reconcile obsolete Happier-managed derived keychain items once we materialize a managed home. The
  // sweep is deferred, deduped and never touches the global login or other-account items.
  scheduleStaleClaudeCodeMacOsKeychainCredentialSweep({
    homeDir: params.sourceEnv.HOME,
    username: params.sourceEnv.USER,
  });
  const health = classifyClaudeCodeCredentialHealth(params.record);
  const builtCredentialPayload = buildClaudeCodeCredentialPayload(params.record);
  const preserveNewerExistingCredential = await shouldPreserveNewerExistingCredential({
    record: params.record,
    selectionDescriptor: params.selectionDescriptor,
    targetClaudeConfigDir: params.targetClaudeConfigDir,
  });
  const preserveExistingAccountState = await shouldPreserveClaudeAccountScopedState({
    record: params.record,
    targetClaudeConfigDir: params.targetClaudeConfigDir,
  });
  const oauthIdentity = readClaudeSubscriptionCredentialIdentity(params.record)
    ?? { providerAccountId: null, providerEmail: null };
  const identityDiagnostic = buildClaudeSubscriptionNativeAuthIdentityDiagnostic({
    record: params.record,
    selectionDescriptor: params.selectionDescriptor,
    credentialHealthStatus: health.status,
  });
  if (health.status !== 'ok') {
    if (params.selectionDescriptor.kind === 'group') {
      return await withConnectedServiceStateSharingDestinationLock(params.targetClaudeConfigDir, async () => {
        if (!await validateGroupMutationCurrentness()) return supersededResult();
        await stripLegacyRefreshTokensFromManagedClaudeHome(params.targetClaudeConfigDir);
        const materialized = await materializeClaudeCodeNativeAuth({
          record: params.record,
          claudeConfigDir: params.targetClaudeConfigDir,
          preserveNewerExistingCredential: false,
          homeDir: params.sourceEnv.HOME,
          username: params.sourceEnv.USER,
          diagnosticContext: credentialDiagnosticContextForSelection(params.selectionDescriptor),
        });
        return { ...materialized, identityDiagnostic };
      }, { providerId: 'claude' });
    }
    const materialized = await materializeClaudeCodeNativeAuth({
      record: params.record,
      claudeConfigDir: params.targetClaudeConfigDir,
      preserveNewerExistingCredential: false,
      homeDir: params.sourceEnv.HOME,
      username: params.sourceEnv.USER,
      diagnosticContext: credentialDiagnosticContextForSelection(params.selectionDescriptor),
    });
    return {
      ...materialized,
      identityDiagnostic,
    };
  }
  if (builtCredentialPayload.status !== 'ok') {
    return {
      status: 'diagnostic',
      env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
      diagnostics: [diagnosticForHealth(builtCredentialPayload.health)],
      identityDiagnostic,
    };
  }

  const sharingPolicy = resolveClaudeHomeSharingSettings(params.accountSettings ?? null);
  const sourceClaudeConfigDir = resolveConfiguredClaudeConfigDir({ env: params.sourceEnv });
  if (resolve(sourceClaudeConfigDir) === resolve(params.targetClaudeConfigDir)) {
    return await withConnectedServiceStateSharingDestinationLock(params.targetClaudeConfigDir, async () => {
      if (!await validateGroupMutationCurrentness()) return supersededResult();
      await stripLegacyRefreshTokensFromManagedClaudeHome(params.targetClaudeConfigDir);
      // The source and destination may be the same shared group home for an already-running
      // session. Re-read provenance only after acquiring the canonical destination lock so a
      // delayed older generation cannot overwrite a newer fan-out/materialization.
      const existingProvenance = await readClaudeConnectedServiceHomeProvenance(
        params.targetClaudeConfigDir,
      );
      if (isClaudeConnectedServiceHomeGenerationSuperseded({
        incomingSelection: params.selectionDescriptor,
        existingProvenance,
      })) {
        return {
          ...alreadyMaterializedClaudeCodeNativeAuthResult(params.targetClaudeConfigDir),
          identityDiagnostic,
        };
      }
      const syncResult = await syncClaudeConnectedServiceHome({
        sourceEnv: params.sourceEnv,
        targetDir: params.targetClaudeConfigDir,
        accountSettings: params.accountSettings ?? null,
        sessionDirectory: params.sessionDirectory ?? null,
        preserveNativeCredentialFile: true,
        sharingPolicyOverride: {
          configMode: 'copied',
          stateMode: sharingPolicy.stateMode,
        },
        vendorResumeId: params.vendorResumeId ?? null,
        candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
        ambientStateSourceDir: params.ambientStateSourceDir ?? null,
        destinationLockAlreadyHeld: true,
      });
      await mkdir(params.targetClaudeConfigDir, { recursive: true });
      await materializeClaudeWorkspaceTrust({
        sourceEnv: params.sourceEnv,
        targetDir: params.targetClaudeConfigDir,
        sessionDirectory: params.sessionDirectory ?? null,
        preserveExistingOauthAccountProjection: true,
      });
      const credentialFileAlreadyCurrent = await isClaudeSubscriptionNativeCredentialFileCurrent({
        record: params.record,
        selectionDescriptor: params.selectionDescriptor,
        targetClaudeConfigDir: params.targetClaudeConfigDir,
      });
      const materialized = credentialFileAlreadyCurrent
        ? alreadyMaterializedClaudeCodeNativeAuthResult(params.targetClaudeConfigDir)
        : await materializeClaudeCodeNativeAuth({
            record: params.record,
            claudeConfigDir: params.targetClaudeConfigDir,
            preserveNewerExistingCredential: false,
            homeDir: params.sourceEnv.HOME,
            username: params.sourceEnv.USER,
            diagnosticContext: credentialDiagnosticContextForSelection(params.selectionDescriptor),
          });
      if (materialized.status !== 'materialized') {
        return {
          ...materialized,
          diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
          identityDiagnostic,
        };
      }
      await reconcileClaudeAccountScopedRootConfigFile({
        path: join(params.targetClaudeConfigDir, '.claude.json'),
        preserveExistingAccountState,
        ...oauthIdentity,
      });
      if (!credentialFileAlreadyCurrent) {
        await writeClaudeConnectedServiceHomeProvenance({
          claudeConfigDir: params.targetClaudeConfigDir,
          provenance: buildClaudeConnectedServiceHomeProvenance({
            record: params.record,
            selectionDescriptor: params.selectionDescriptor,
          }),
        });
      }
      return {
        ...materialized,
        env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
        credentialPath: join(params.targetClaudeConfigDir, '.credentials.json'),
        diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
        identityDiagnostic,
      };
    }, { providerId: 'claude' });
  }

  if (preserveNewerExistingCredential) {
    return await withConnectedServiceStateSharingDestinationLock(params.targetClaudeConfigDir, async () => {
      if (!await validateGroupMutationCurrentness()) return supersededResult();
      await stripLegacyRefreshTokensFromManagedClaudeHome(params.targetClaudeConfigDir);
      const existingProvenance = await readClaudeConnectedServiceHomeProvenance(params.targetClaudeConfigDir);
      if (isClaudeConnectedServiceHomeGenerationSuperseded({
        incomingSelection: params.selectionDescriptor,
        existingProvenance,
      })) {
        return {
          ...alreadyMaterializedClaudeCodeNativeAuthResult(params.targetClaudeConfigDir),
          identityDiagnostic,
        };
      }
      const syncResult = await syncClaudeConnectedServiceHome({
        sourceEnv: params.sourceEnv,
        targetDir: params.targetClaudeConfigDir,
        accountSettings: params.accountSettings ?? null,
        sessionDirectory: params.sessionDirectory ?? null,
        preserveNativeCredentialFile: true,
        sharingPolicyOverride: {
          configMode: 'copied',
          stateMode: sharingPolicy.stateMode,
        },
        vendorResumeId: params.vendorResumeId ?? null,
        candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
        ambientStateSourceDir: params.ambientStateSourceDir ?? null,
        destinationLockAlreadyHeld: true,
      });
      await materializeClaudeWorkspaceTrust({
        sourceEnv: params.sourceEnv,
        targetDir: params.targetClaudeConfigDir,
        sessionDirectory: params.sessionDirectory ?? null,
        preserveExistingOauthAccountProjection: true,
      });
      const credentialFileAlreadyCurrent = await isClaudeSubscriptionNativeCredentialFileCurrent({
        record: params.record,
        selectionDescriptor: params.selectionDescriptor,
        targetClaudeConfigDir: params.targetClaudeConfigDir,
      });
      const materialized = credentialFileAlreadyCurrent
        ? alreadyMaterializedClaudeCodeNativeAuthResult(params.targetClaudeConfigDir)
        : await materializeClaudeCodeNativeAuth({
            record: params.record,
            claudeConfigDir: params.targetClaudeConfigDir,
            preserveNewerExistingCredential: false,
            homeDir: params.sourceEnv.HOME,
            username: params.sourceEnv.USER,
            diagnosticContext: credentialDiagnosticContextForSelection(params.selectionDescriptor),
          });
      if (materialized.status !== 'materialized') {
        return {
          ...materialized,
          diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
          identityDiagnostic,
        };
      }
      await reconcileClaudeAccountScopedRootConfigFile({
        path: join(params.targetClaudeConfigDir, '.claude.json'),
        preserveExistingAccountState,
        ...oauthIdentity,
      });
      if (!credentialFileAlreadyCurrent) {
        await writeClaudeConnectedServiceHomeProvenance({
          claudeConfigDir: params.targetClaudeConfigDir,
          provenance: buildClaudeConnectedServiceHomeProvenance({
            record: params.record,
            selectionDescriptor: params.selectionDescriptor,
          }),
        });
      }
      return {
        ...materialized,
        env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
        credentialPath: join(params.targetClaudeConfigDir, '.credentials.json'),
        diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
        identityDiagnostic,
      };
    }, { providerId: 'claude' });
  }

  await mkdir(dirname(params.targetClaudeConfigDir), { recursive: true });
  // RD-MAT-8: hold the destination lock on the REAL target home across stage-build + swap so a
  // concurrent self-source materialization of the same profile home cannot interleave in-place
  // writes with the staged replacement. The inner sync locks only the staged dir (distinct key).
  return await withConnectedServiceStateSharingDestinationLock(params.targetClaudeConfigDir, async () => {
    if (!await validateGroupMutationCurrentness()) return supersededResult();
    await stripLegacyRefreshTokensFromManagedClaudeHome(params.targetClaudeConfigDir);
    const existingProvenance = await readClaudeConnectedServiceHomeProvenance(params.targetClaudeConfigDir);
    if (isClaudeConnectedServiceHomeGenerationSuperseded({
      incomingSelection: params.selectionDescriptor,
      existingProvenance,
    })) {
      return {
        ...alreadyMaterializedClaudeCodeNativeAuthResult(params.targetClaudeConfigDir),
        identityDiagnostic,
      };
    }
    const stagedClaudeConfigDir = await mkdtemp(join(dirname(params.targetClaudeConfigDir), '.happier-claude-config-'));
    try {
      const syncResult = await syncClaudeConnectedServiceHome({
        sourceEnv: params.sourceEnv,
        targetDir: stagedClaudeConfigDir,
        accountSettings: params.accountSettings ?? null,
        sessionDirectory: params.sessionDirectory ?? null,
        preserveNativeCredentialFile: true,
        sharingPolicyOverride: {
          configMode: 'copied',
          stateMode: sharingPolicy.stateMode,
        },
        vendorResumeId: params.vendorResumeId ?? null,
        candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      });
      const materialized = await materializeClaudeCodeNativeAuth({
        record: params.record,
        claudeConfigDir: stagedClaudeConfigDir,
        compareCredentialPath: resolveClaudeCodeCredentialsFilePath(params.targetClaudeConfigDir),
        preserveNewerExistingCredential,
        homeDir: params.sourceEnv.HOME,
        username: params.sourceEnv.USER,
        diagnosticContext: credentialDiagnosticContextForSelection(params.selectionDescriptor),
      });
      if (materialized.status !== 'materialized') {
        return {
          ...materialized,
          env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
          diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
          identityDiagnostic,
        };
      }
      await reconcileClaudeAccountScopedRootConfigFile({
        path: join(stagedClaudeConfigDir, '.claude.json'),
        preserveExistingAccountState,
        ...oauthIdentity,
      });
      await writeClaudeConnectedServiceHomeProvenance({
        claudeConfigDir: stagedClaudeConfigDir,
        provenance: buildClaudeConnectedServiceHomeProvenance({
          record: params.record,
          selectionDescriptor: params.selectionDescriptor,
        }),
      });
      // RD-CLD-2: preserve the previous home's physical session files before the staged swap
      // destroys them — sibling sessions resting in that home are NOT covered by the candidate
      // session-file import of the session being resumed.
      await backfillPreviousClaudeHomeSessionFiles({
        previousClaudeConfigDir: params.targetClaudeConfigDir,
        stagedClaudeConfigDir,
        effectiveStateMode: syncResult.effectiveStateMode,
        sharedSourceProjectsRoot: join(sourceClaudeConfigDir, 'projects'),
      });
      await replaceDirectoryAtomically({
        stagedDir: stagedClaudeConfigDir,
        targetDir: params.targetClaudeConfigDir,
      });
      return {
        ...materialized,
        env: { CLAUDE_CONFIG_DIR: params.targetClaudeConfigDir },
        credentialPath: join(params.targetClaudeConfigDir, '.credentials.json'),
        diagnostics: [...syncResult.diagnostics, ...materialized.diagnostics],
        identityDiagnostic,
      };
    } finally {
      await rm(stagedClaudeConfigDir, { recursive: true, force: true }).catch(() => {});
    }
  }, { providerId: 'claude' });
}
