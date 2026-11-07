import { isAbsolute, join, relative, resolve } from 'node:path';

import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';

import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import type { ConnectedServicesProviderMaterializerInput } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import type { ConnectedServiceResolvedSelection } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';

import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { CLAUDE_AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_KEY, CLAUDE_NATIVE_CONFIG_DIR_ENV_KEY } from '@/backends/claude/utils/resolveClaudeLaunchSettingsOverlay';
import { materializeClaudeAnthropicApiKeyAuth } from './materializeClaudeAnthropicApiKeyAuth';
import {
  materializeClaudeSubscriptionNativeAuthHome,
  type ClaudeSubscriptionNativeAuthIdentityDiagnostic,
  type ClaudeSubscriptionNativeAuthSelectionDescriptor,
} from './nativeAuth/materializeClaudeCodeNativeAuth';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';
import { syncClaudeConnectedServiceHome } from './syncClaudeConnectedServiceHome';

export type ClaudeConnectedServiceMaterializationServiceId = Extract<
  ConnectedServiceId,
  'claude-subscription' | 'anthropic'
>;

export type ClaudeConnectedServiceSelectionMaterialization = Readonly<{
  env: Record<string, string>;
  targetMaterializedRoot: string;
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
  identityDiagnostic?: ClaudeSubscriptionNativeAuthIdentityDiagnostic;
}>;

function withoutClaudeConfigDirOverrides(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv = { ...processEnv };
  delete nextEnv.CLAUDE_CONFIG_DIR;
  delete nextEnv.HAPPIER_CLAUDE_CONFIG_DIR;
  return nextEnv;
}

function isClaudeManagedConnectedServiceConfigDir(params: Readonly<{
  activeServerDir: string;
  claudeConfigDir: string;
}>): boolean {
  const managedHomesRoot = resolve(
    join(params.activeServerDir, 'daemon', 'connected-services', 'homes', 'claude-subscription'),
  );
  const rel = relative(managedHomesRoot, resolve(params.claudeConfigDir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveClaudeConfigurationSourceEnv(params: Readonly<{
  activeServerDir: string;
  processEnv: NodeJS.ProcessEnv;
  targetClaudeConfigDir: string;
}>): NodeJS.ProcessEnv {
  const nativeConfigDir = params.processEnv[CLAUDE_NATIVE_CONFIG_DIR_ENV_KEY]?.trim();
  if (nativeConfigDir) {
    return { ...params.processEnv, CLAUDE_CONFIG_DIR: nativeConfigDir };
  }
  // Credential provenance governs auth preservation, not configuration freshness. Always
  // reconcile from the configured native home, never an earlier materialized copy of it.
  const configuredClaudeConfigDir = resolveConfiguredClaudeConfigDir({ env: params.processEnv });
  if (
    resolve(configuredClaudeConfigDir) === resolve(params.targetClaudeConfigDir)
    || isClaudeManagedConnectedServiceConfigDir({
      activeServerDir: params.activeServerDir,
      claudeConfigDir: configuredClaudeConfigDir,
    })
  ) {
    return withoutClaudeConfigDirOverrides(params.processEnv);
  }
  return params.processEnv;
}

export function buildClaudeSubscriptionNativeAuthSelectionDescriptor(params: Readonly<{
  fallbackProfileId: string;
  selection: ConnectedServiceResolvedSelection | null | undefined;
}>): ClaudeSubscriptionNativeAuthSelectionDescriptor {
  if (params.selection?.kind === 'group') {
    return {
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId: params.selection.groupId,
      activeProfileId: params.selection.activeProfileId,
      fallbackProfileId: params.selection.fallbackProfileId,
      generation: params.selection.generation,
      credentialRevision: params.selection.credentialRevision ?? null,
    };
  }
  return {
    kind: 'profile',
    serviceId: 'claude-subscription',
    profileId: params.selection?.kind === 'profile' ? params.selection.profileId : params.fallbackProfileId,
  };
}

function hasBlockingDiagnostics(diagnostics: readonly ConnectedServicesMaterializationDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'blocking');
}

function dedupeDiagnostics<T extends Readonly<{
  code: string;
  serviceId?: string;
  reason?: string;
  entryName?: string;
}>>(diagnostics: readonly T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.code,
      diagnostic.serviceId ?? '',
      diagnostic.reason ?? '',
      diagnostic.entryName ?? '',
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(diagnostic);
  }
  return deduped;
}

export async function materializeClaudeConnectedServiceSelection(params: Readonly<{
  activeServerDir: string;
  probeConfigDir?: string;
  serviceId: ClaudeConnectedServiceMaterializationServiceId;
  record: ConnectedServiceCredentialRecordV1;
  fallbackProfileId: string;
  selection?: ConnectedServiceResolvedSelection | null | undefined;
  processEnv: NodeJS.ProcessEnv;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  sessionDirectory?: string | null;
  vendorResumeId?: string | null;
  candidatePersistedSessionFile?: string | null;
  sessionStateMode?: 'existing';
  validateGroupMutationCurrentness?: ConnectedServicesProviderMaterializerInput['validateGroupMutationCurrentness'];
}>): Promise<ClaudeConnectedServiceSelectionMaterialization | null> {
  const claudeConfigDir = params.probeConfigDir ?? resolveClaudeConnectedServiceStableConfigDir({
    activeServerDir: params.activeServerDir,
    serviceId: params.serviceId,
    fallbackProfileId: params.fallbackProfileId,
    selection: params.selection ?? null,
  });
  if (!claudeConfigDir) return null;
  const nativeSourceEnv = resolveClaudeConfigurationSourceEnv({
    activeServerDir: params.activeServerDir,
    processEnv: params.processEnv,
    targetClaudeConfigDir: claudeConfigDir,
  });
  const nativeLaunchEnv = {
    [CLAUDE_NATIVE_CONFIG_DIR_ENV_KEY]: resolveConfiguredClaudeConfigDir({ env: nativeSourceEnv }),
  };
  const poolPolicy = params.selection?.kind === 'group'
    ? ConnectedServiceAuthGroupPolicyV1Schema.parse(params.selection.policy ?? {})
    : null;
  const poolLaunchEnv: Record<string, string> = poolPolicy
    ? { [CLAUDE_AUTO_CONTINUE_AT_USAGE_LIMIT_ENV_KEY]: poolPolicy.claudeCodeAutoContinueAtUsageLimit === true ? '1' : '0' }
    : {};

  if (params.serviceId === 'claude-subscription') {
    const selectionDescriptor = buildClaudeSubscriptionNativeAuthSelectionDescriptor({
      fallbackProfileId: params.fallbackProfileId,
      selection: params.selection ?? null,
    });
    let groupSourceEnv: NodeJS.ProcessEnv | null = null;
    let groupSourceDiagnostics: readonly ConnectedServicesMaterializationDiagnostic[] = [];
    if (selectionDescriptor.kind === 'group' && !params.probeConfigDir) {
      const profileClaudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
        activeServerDir: params.activeServerDir,
        serviceId: params.serviceId,
        fallbackProfileId: selectionDescriptor.activeProfileId,
        selection: {
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: selectionDescriptor.activeProfileId,
          record: params.record,
        },
      });
      if (profileClaudeConfigDir) {
        const canonicalProfileSelectionDescriptor = {
          kind: 'profile' as const,
          serviceId: 'claude-subscription' as const,
          profileId: selectionDescriptor.activeProfileId,
        };
        const canonicalProfileMaterialized = await materializeClaudeSubscriptionNativeAuthHome({
          record: params.record,
          targetClaudeConfigDir: profileClaudeConfigDir,
          sourceEnv: resolveClaudeConfigurationSourceEnv({
            activeServerDir: params.activeServerDir,
            processEnv: params.processEnv,
            targetClaudeConfigDir: profileClaudeConfigDir,
          }),
          accountSettings: params.accountSettings ?? null,
          sessionDirectory: params.sessionDirectory ?? null,
          vendorResumeId: params.vendorResumeId ?? null,
          candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
          sessionStateMode: params.sessionStateMode,
          selectionDescriptor: canonicalProfileSelectionDescriptor,
          validateGroupMutationCurrentness: params.validateGroupMutationCurrentness,
        });
        groupSourceDiagnostics = canonicalProfileMaterialized.diagnostics;
        if (
          canonicalProfileMaterialized.status === 'diagnostic'
          || hasBlockingDiagnostics(canonicalProfileMaterialized.diagnostics)
        ) {
          return {
            env: { CLAUDE_CONFIG_DIR: claudeConfigDir, ...nativeLaunchEnv },
            targetMaterializedRoot: claudeConfigDir,
            diagnostics: canonicalProfileMaterialized.diagnostics,
            identityDiagnostic: canonicalProfileMaterialized.identityDiagnostic,
          };
        }
        groupSourceEnv = {
          ...params.processEnv,
          ...canonicalProfileMaterialized.env,
        };
      }
    }
    const sourceEnv = groupSourceEnv ?? resolveClaudeConfigurationSourceEnv({
      activeServerDir: params.activeServerDir,
      processEnv: params.processEnv,
      targetClaudeConfigDir: claudeConfigDir,
    });
    const materialized = await materializeClaudeSubscriptionNativeAuthHome({
      record: params.record,
      targetClaudeConfigDir: claudeConfigDir,
      sourceEnv,
      accountSettings: params.accountSettings ?? null,
      sessionDirectory: params.sessionDirectory ?? null,
      vendorResumeId: params.vendorResumeId ?? null,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      sessionStateMode: params.sessionStateMode,
      selectionDescriptor,
      validateGroupMutationCurrentness: params.validateGroupMutationCurrentness,
    });
    return {
      env: { ...materialized.env, ...poolLaunchEnv, ...nativeLaunchEnv },
      targetMaterializedRoot: claudeConfigDir,
      diagnostics: dedupeDiagnostics([...groupSourceDiagnostics, ...materialized.diagnostics]),
      identityDiagnostic: materialized.identityDiagnostic,
    };
  }

  const diagnostics = params.sessionStateMode === 'existing' ? [] : (await syncClaudeConnectedServiceHome({
    sourceEnv: nativeSourceEnv,
    targetDir: claudeConfigDir,
    accountSettings: params.accountSettings ?? null,
    sessionDirectory: params.sessionDirectory ?? null,
  })).diagnostics;
  const materialized = materializeClaudeAnthropicApiKeyAuth({ record: params.record });
  return {
    env: {
      ...materialized.env,
      ...poolLaunchEnv,
      ...nativeLaunchEnv,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
    targetMaterializedRoot: claudeConfigDir,
    diagnostics,
  };
}
