import type { AgentId } from '@happier-dev/agents';
import { randomUUID } from 'node:crypto';
import { consumeSessionInitialAccessFile } from '@/daemon/spawn/sessionInitialAccessFile';
import { errorFrame, warn } from '@happier-dev/cli-common/output';
import { isLaunchProfileV2 } from '@happier-dev/protocol/profiles/read';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import type { BackendTargetRefV2Input, PluginSourceCustodyV1, ProviderErrorV1 } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { readStoredCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded, ensureMachineIdForCredentials } from '@/ui/auth';
import type { CommandContext } from '@/cli/commandRegistry';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '@/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { resolveSessionStartAccountSettingsRefreshMode } from '@/settings/accountSettings/resolveSessionStartAccountSettingsRefreshMode';
import { ensureDaemonRunningForSessionCommand, shouldAutoStartDaemonAfterAuth } from '@/daemon/ensureDaemon';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import {
  buildProfileEnvOverlay,
  expandProfileEnvOverlay,
} from '@/settings/profiles/buildProfileEnvOverlay';
import { readAccountLaunchProfiles } from '@/settings/profiles/readProfilesFromAccountSettings';
import { ProviderProfileMigrationFactsUnavailableError, resolveProfileForAgent } from '@/settings/profiles/resolveProfileForAgent';
import { prepareProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { isPermissionMode, type PermissionMode } from '@/api/types';
import {
  applyDeprecatedSessionStartAliasesForAgent,
  type ParsedSessionStartArgs,
} from '@/cli/sessionStartArgs';
import { claimSessionRunnerOwnership, withSessionRunnerOwnership } from '@/daemon/sessionRunnerLock';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { promptSecret } from '@/terminal/prompts/promptSecret';
import {
  isProviderCliInfoCommandPrefixRequest,
  passthroughProviderCliArgs,
  type ProviderCliInfoCommandPrefix,
} from '@/cli/providerCliPassthrough';
import {
  buildAgentCliSessionCommandBuildInput,
  partitionProviderSessionArgs,
  type ProviderSessionArgPartitionResult,
} from '@/cli/providerSessionArgPartition';
import { resolveSessionStartModelSelection } from '@/cli/resolveSessionStartModelSelection';
import { buildRootHelpText } from '@/cli/buildRootHelpText';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup } from '@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';
import { resolveProviderSessionRuntimePreferences } from '@/session/runtime/catalogHooks';
import { presentProviderCliRefusal } from '@/providers/lifecycle/presentProviderCliRefusal';
import {
  buildScopedProcessEnv,
  normalizeUnsetEnvKeys,
  stripUnsetEnvironmentVariables,
} from '@/utils/processEnv/buildScopedProcessEnv';
import {
  stripSessionControlEnvOverrides,
  stripSessionControlUnsetEnvKeys,
} from '@/session/runtime/control/sessionControlEnvironment';
import { resolveDirectCliConnectedServiceBindings } from '@/cli/connectedServices/resolveDirectCliConnectedServiceBindings';
import { mergeSessionTeamCredentialBindingIntents } from '@/session/services/spawnConnectedServicesDefaults';
import type { SessionTeamCredentialBindingIntentListV1 } from '@happier-dev/protocol/teams';
import {
  admitDaemonForegroundAgentRuntime,
  releaseDaemonForegroundAgentRuntime,
  resolveDaemonForegroundAgentRuntimeSessionOptions,
} from '@/daemon/controlClient';
import {
  claimDaemonForegroundAgentRuntimeEnvironment,
} from '@/agent/runtime/session/process/foregroundAgentRuntimeAdmissionClient';
import {
  HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY,
} from '@/daemon/agentRuntime/foregroundAdmissionContract';
import {
  isAgentSessionContinuationUnreachableError,
  SESSION_RUNNER_EXIT_CODES,
} from '@/session/shared/spawnSessionContract';

type CommonBackendRunOptions = ParsedSessionStartArgs & {
  credentials: StoredCredentials;
  directory?: string;
  terminalRuntime: CommandContext['terminalRuntime'];
  happyHomeDir: string;
  existingSessionId: string | undefined;
  resume: string | undefined;
  startedBy: ParsedSessionStartArgs['startedBy'];
  accountSettingsContext: AccountSettingsContext | null;
  environmentVariables?: Record<string, string>;
  unsetEnvironmentVariables?: readonly string[];
};

type RuntimeAuthorityAgentId = string;

class DirectProviderLaunchError extends Error {
  readonly providerError: ProviderErrorV1;

  constructor(providerError: ProviderErrorV1) {
    super(providerError.code);
    this.name = 'DirectProviderLaunchError';
    this.providerError = providerError;
  }
}

function readProviderEnvironmentVariables(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const environmentVariables: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0 || typeof entry !== 'string') {
      continue;
    }
    environmentVariables[key] = entry;
  }
  return Object.keys(environmentVariables).length > 0 ? environmentVariables : undefined;
}

function readUnsetEnvironmentVariables(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  const normalized = normalizeUnsetEnvKeys(entries);
  return normalized.length > 0 ? normalized : undefined;
}

function passthroughProviderCliArgsAndExit(params: Parameters<typeof passthroughProviderCliArgs>[0]): void {
  passthroughProviderCliArgs(params);
  process.exit(0);
}

async function finalizeProviderRunOptions(extras: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
  const environmentVariables = readProviderEnvironmentVariables(extras.environmentVariables);
  const unsetEnvironmentVariables = readUnsetEnvironmentVariables(extras.unsetEnvironmentVariables);
  return {
    ...extras,
    ...(environmentVariables ? { environmentVariables } : {}),
    ...(unsetEnvironmentVariables ? { unsetEnvironmentVariables } : {}),
  };
}

export async function runBackendSessionCliCommand<Extra extends Record<string, unknown>>(params: {
  context: CommandContext;
  backendIdForSessionRuntime: string;
  /** Canonical catalog Agent identity used only for daemon runtime authority. */
  runtimeAuthorityAgentId?: RuntimeAuthorityAgentId;
  /** Host-derived command form preserved for a public Agent CLI options composer. */
  isExplicitCliSubcommand?: boolean;
  /** Optional legacy CLI argument normalizer; never a runtime-authority source. */
  agentIdForDeprecatedAliases?: AgentId;
  /** Optional Profile, account-settings, and Connected Services catalog owner. */
  agentIdForAccountSettings?: AgentId;
  loadAccountSettings?: boolean;
  directoryFlags?: readonly string[];
  forwardModelFlag?: boolean;
  forwardResumeFlag?: boolean;
  yoloProviderArgs?: readonly string[];
  versionFlags?: readonly string[];
  providerInfoCommandPrefixes?: readonly ProviderCliInfoCommandPrefix[];
  resolveExtraOptions?: (args: string[], parsed: ProviderSessionArgPartitionResult) => Extra;
}): Promise<void> {
  return withSessionRunnerOwnership(async () => {
    let releaseForegroundAdmission: (() => void | Promise<void>) | null = null;
    const cleanupForegroundAdmission = async (): Promise<void> => {
      const cleanup = releaseForegroundAdmission;
      releaseForegroundAdmission = null;
      if (!cleanup) return;
      try {
        await cleanup();
      } catch (error) {
        void error;
        logger.warn('[session] Foreground admission cleanup failed', {
          error: 'foreground_admission_cleanup_failed',
        });
      }
    };

    try {
      const cliArgumentAgentId =
        params.agentIdForAccountSettings
        ?? params.agentIdForDeprecatedAliases;
      const parsed = partitionProviderSessionArgs({
        args: params.context.args,
        providerSubcommand: cliArgumentAgentId,
        directoryFlags: params.directoryFlags,
        forwardModelFlag: params.forwardModelFlag,
        forwardResumeFlag: params.forwardResumeFlag,
        yoloProviderArgs: params.yoloProviderArgs,
        versionFlags: params.versionFlags,
      });
      const initialAccess = parsed.initialAccessFilePath === undefined
        ? undefined
        : await consumeSessionInitialAccessFile(parsed.initialAccessFilePath);
      if (cliArgumentAgentId && parsed.helpRequested) {
        console.log(`${buildRootHelpText()}

${'-'.repeat(60)}
Provider CLI Options:
`);
        const providerHelpArgs = parsed.providerArgs.some((arg) => arg === '-h' || arg === '--help')
          ? parsed.providerArgs
          : [...parsed.providerArgs, '--help'];
        passthroughProviderCliArgsAndExit({
          agentId: cliArgumentAgentId,
          providerArgs: providerHelpArgs,
        });
        return;
      }
      if (
        cliArgumentAgentId
        && parsed.versionRequested
        && parsed.versionFlag
      ) {
        passthroughProviderCliArgsAndExit({
          agentId: cliArgumentAgentId,
          providerArgs: [parsed.versionFlag],
        });
        return;
      }
      if (
        cliArgumentAgentId
        && params.providerInfoCommandPrefixes
        && isProviderCliInfoCommandPrefixRequest({
          args: parsed.providerArgs,
          prefixes: params.providerInfoCommandPrefixes,
        })
      ) {
        passthroughProviderCliArgsAndExit({
          agentId: cliArgumentAgentId,
          providerArgs: parsed.providerArgs,
        });
        return;
      }

      const resolved = params.agentIdForDeprecatedAliases
        ? applyDeprecatedSessionStartAliasesForAgent({ agentId: params.agentIdForDeprecatedAliases, ...parsed })
        : { ...parsed, warnings: [] as string[] };

      for (const warning of resolved.warnings) {
        console.error(warn(warning));
      }

      const existingSessionId = parsed.existingSessionId;
      const resume = parsed.resume;
      const profileQuery = parsed.profileQuery ?? '';
      const extraOptions = params.resolveExtraOptions ? params.resolveExtraOptions(params.context.args, parsed) : ({} as Extra);
      const agentTarget = extraOptions.agentTarget === undefined ? undefined : AgentExecutionTargetV1Schema.parse(extraOptions.agentTarget);
      const runtimeDescriptorV1 = extraOptions.runtimeDescriptorV1 === undefined ? undefined : RuntimeDescriptorV1Schema.parse(extraOptions.runtimeDescriptorV1);
      const startedBy = resolved.startedBy ?? 'terminal';
      const isExplicitCliSubcommand = params.isExplicitCliSubcommand
        ?? (params.context.args[0] === cliArgumentAgentId);

      const selfMigration = await selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup();
      if (selfMigration) {
        logger.debug('[session] Self-migrated daemon-spawned runner out of daemon service cgroup', {
          migration: selfMigration,
        });
      }

      const normalizedExistingSessionId = typeof existingSessionId === 'string' ? existingSessionId.trim() : '';
      if (normalizedExistingSessionId) {
        await claimSessionRunnerOwnership(normalizedExistingSessionId);
      }
      const backendId = params.backendIdForSessionRuntime.trim();
      if (!backendId) {
        throw new Error('Session command is missing a backend id for session startup');
      }
      const modelSelectionBackendTargetInput = (
        extraOptions as Readonly<{ backendTarget?: BackendTargetRefV2Input }>
      ).backendTarget ?? {
        kind: 'backend',
        backendId,
        sourceKind: 'built_in',
      };

      let credentials = await readStoredCredentials();
      let machineId: string;
      if (!credentials) {
        const auth = await authAndSetupMachineIfNeeded();
        credentials = auth.credentials;
        machineId = auth.machineId;
      } else {
        machineId = (await ensureMachineIdForCredentials(credentials)).machineId;
        if (
          shouldAutoStartDaemonAfterAuth({
            env: process.env,
            isDaemonProcess: configuration.isDaemonProcess,
            startedBy,
          })
        ) {
          void ensureDaemonRunningForSessionCommand().catch((error) => {
            logger.debug('[session] Failed to auto-start daemon (non-fatal)', error);
          });
        }
      }

      let accountSettingsContext: AccountSettingsContext | null = null;
      const profileAgentId =
        params.agentIdForAccountSettings
        ?? params.agentIdForDeprecatedAliases;
      const runtimeAuthorityAgentId = params.runtimeAuthorityAgentId;

      if (params.agentIdForAccountSettings || params.loadAccountSettings || profileQuery) {
        const accountSettingsBootstrapMode = profileQuery ? 'blocking' : 'fast';
        const snapshot = await bootstrapAccountSettingsContext({
          ...(profileAgentId ? { agentId: profileAgentId } : {}),
          credentials,
          mode: accountSettingsBootstrapMode,
          refresh: resolveSessionStartAccountSettingsRefreshMode({
            mode: accountSettingsBootstrapMode,
            refreshRequested: parsed.refreshSettings,
            minSettingsVersion: null,
          }),
        });
        accountSettingsContext = await resolveSessionStartAccountSettingsContext({
          startedBy,
          snapshot,
        });
      }

      const providerSessionId =
        normalizedExistingSessionId || `direct-${randomUUID()}`;
      const catalogAgentId = params.agentIdForAccountSettings ?? null;
      const selectedProfile =
        profileQuery && accountSettingsContext && profileAgentId
          ? await (async () => {
              const {
                visibleProfiles,
                terminalMigratedProfileIds,
              } = await readAccountLaunchProfiles(
                accountSettingsContext.settings, credentials,
              );
              try {
                return resolveProfileForAgent({
                  agentId: profileAgentId, query: profileQuery, customProfiles: visibleProfiles, terminalMigratedProfileIds,
                });
              } catch (error) {
                if (!(error instanceof ProviderProfileMigrationFactsUnavailableError)) throw error;
                // Only this affected retained selection consumes Provider migration facts.
                // Listing and independent modern Profiles never demand the Provider catalog.
                const catalog = await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: resolveAccountSettingsScopeKey(credentials) });
                if (catalog.status !== 'ready') throw error;
                const refreshed = await readAccountLaunchProfiles(getActiveAccountSettingsSnapshot()?.settings, credentials);
                return resolveProfileForAgent({ agentId: profileAgentId, query: profileQuery,
                  customProfiles: refreshed.visibleProfiles, terminalMigratedProfileIds: refreshed.terminalMigratedProfileIds });
              }
            })()
          : null;
      const preferredProfileModelSelection =
        selectedProfile && isLaunchProfileV2(selectedProfile)
          ? selectedProfile.preferredModelSelection
          : undefined;
      const modelSelection = resolveSessionStartModelSelection({
        backendTarget: modelSelectionBackendTargetInput,
        canonicalSelection: resolved.modelSelection,
        legacyModelId: resolved.modelId,
        providerConnectionId: resolved.providerConnectionId,
        legacyModelUpdatedAt: resolved.modelUpdatedAt,
        fallbackSelection: preferredProfileModelSelection,
      });
      const hasForegroundProviderSelection =
        modelSelection?.ref.providerConnectionId !== null
        && modelSelection?.ref.providerConnectionId !== undefined;
      let directConnectedServices =
        params.context.directSessionLaunch?.connectedServices ?? null;
      const shouldResolveCliConnectedServices =
        startedBy !== 'daemon'
        && params.context.directSessionLaunch === undefined
        && catalogAgentId !== null
        && accountSettingsContext !== null;
      if (shouldResolveCliConnectedServices) {
        if (!catalogAgentId || !accountSettingsContext) {
          throw new Error('connected_service_auth_unsupported');
        }
        directConnectedServices = await resolveDirectCliConnectedServiceBindings({
          agentId: catalogAgentId,
          credentials,
          accountSettings: accountSettingsContext.settings,
          authRaw: parsed.connectedServicesAuthRaw,
          authJsonRaw: parsed.connectedServicesAuthJsonRaw,
        });
      }
      let foregroundReservedEnvironmentVariableNames: readonly string[] =
        Object.freeze([]);
      let profileSecretRequirementNamesMissingBinding: readonly string[] =
        Object.freeze([]);
      let foregroundNativeHomeSourceEnvironmentKey: string | undefined;
      let admittedTeamCredentialBindings: SessionTeamCredentialBindingIntentListV1 | null = null;
      let foregroundAdmissionClaim: Readonly<{
        admissionFilePath: string;
        bootstrapFilePath: string;
        authorityFilePath: string;
        sessionId: string;
        attemptId: string;
        occurrenceId: string;
        sourceCustody: PluginSourceCustodyV1;
      }> | null = null;
      let admitForegroundRuntime:
        | (() => Promise<Readonly<{
            claim: NonNullable<typeof foregroundAdmissionClaim>;
            reservedEnvironmentVariableNames: readonly string[];
            profileSecretRequirementNamesMissingBinding: readonly string[];
            nativeHomeSourceEnvironmentKey?: string;
            teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
          }>>)
        | null = null;
      if (parsed.secretReferenceOverlay && !selectedProfile) {
        throw new Error('--secret-ref requires a selected launch Profile');
      }
      if (
        startedBy !== 'daemon'
        && runtimeAuthorityAgentId
      ) {
        if (
          selectedProfile
          && (
            !accountSettingsContext?.scopeKey
            || typeof accountSettingsContext.settingsVersion !== 'number'
          )
        ) {
          throw new Error(
            'Foreground Profile admission requires an exact account settings scope',
          );
        }
        await ensureDaemonRunningForSessionCommand();
        admitForegroundRuntime = async () => {
          const attemptId = randomUUID();
          const admission = await admitDaemonForegroundAgentRuntime({
            v: 1,
            attemptId,
            sessionId: providerSessionId,
            ...(normalizedExistingSessionId
              ? { existingSessionId: normalizedExistingSessionId }
              : {}),
            foregroundPid: process.pid,
            directory:
              parsed.directory ?? resolveRequestedSessionDirectory(),
            agentId: runtimeAuthorityAgentId,
            backendTarget: readBackendTargetRefV2(
              modelSelectionBackendTargetInput,
            ),
            ...(agentTarget ? { agentTarget } : {}),
            ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
            ...(selectedProfile ? { profileId: selectedProfile.id } : {}),
            ...(selectedProfile?.profileRecordRevision !== undefined
              ? { profileRecordRevision: selectedProfile.profileRecordRevision }
              : {}),
            ...(selectedProfile && accountSettingsContext?.scopeKey
              ? {
                  accountSettingsScopeKey: accountSettingsContext.scopeKey,
                  accountSettingsVersion:
                    accountSettingsContext.settingsVersion,
                }
              : {}),
            ...(hasForegroundProviderSelection && modelSelection
              ? { selection: modelSelection }
              : {}),
            // Captured in this closure, so an admission retry re-sends the SAME
            // admitted references and revisions instead of losing the caller's
            // one-shot selection or falling back to the Profile binding.
            ...(selectedProfile && parsed.secretReferenceOverlay
              ? { secretReferenceOverlay: parsed.secretReferenceOverlay }
              : {}),
            previousBinding:
              params.context.directSessionLaunch?.providerBinding ?? null,
            ...(directConnectedServices
              ? { connectedServices: directConnectedServices }
              : {}),
            ...(resume ? { vendorResumeId: resume } : {}),
          }, {
            ...(params.context.signal ? { signal: params.context.signal } : {}),
          });
          if (!admission.ok) {
            throw new DirectProviderLaunchError(admission.error);
          }
          return Object.freeze({
            claim: Object.freeze({
              admissionFilePath:
                admission.capability.admissionFilePath,
              bootstrapFilePath:
                admission.capability.bootstrapFilePath,
              authorityFilePath:
                admission.capability.authorityFilePath,
              sessionId: providerSessionId,
              attemptId,
              occurrenceId: admission.capability.descriptor.occurrenceId,
              sourceCustody: admission.capability.descriptor.sourceCustody,
            }),
            reservedEnvironmentVariableNames:
              admission.launchPolicy.reservedEnvironmentVariableNames,
            profileSecretRequirementNamesMissingBinding:
              admission.launchPolicy
                .profileSecretRequirementNamesMissingBinding,
            ...(admission.launchPolicy.nativeHomeSourceEnvironmentKey
              ? {
                  nativeHomeSourceEnvironmentKey:
                    admission.launchPolicy.nativeHomeSourceEnvironmentKey,
                }
              : {}),
            ...(admission.sessionCreation
              ? { teamCredentialBindings: admission.sessionCreation.teamCredentialBindings }
              : {}),
          });
        };
        const initialAdmission = await admitForegroundRuntime();
        // The daemon admitted durable Team purpose targets for this Agent; the
        // Session this process creates carries their Team slot bindings so the
        // Home admits them. An explicit binding for the same slot wins.
        admittedTeamCredentialBindings = initialAdmission.teamCredentialBindings ?? null;
        foregroundAdmissionClaim = initialAdmission.claim;
        foregroundReservedEnvironmentVariableNames =
          initialAdmission.reservedEnvironmentVariableNames;
        profileSecretRequirementNamesMissingBinding =
          initialAdmission.profileSecretRequirementNamesMissingBinding;
        foregroundNativeHomeSourceEnvironmentKey =
          initialAdmission.nativeHomeSourceEnvironmentKey;
        const releaseActiveForegroundAdmission = async () => {
          const activeClaim = foregroundAdmissionClaim;
          foregroundAdmissionClaim = null;
          if (!activeClaim) return;
          await releaseDaemonForegroundAgentRuntime({
            v: 1,
            attemptId: activeClaim.attemptId,
            sessionId: activeClaim.sessionId,
          }).catch(() => undefined);
        };
        releaseForegroundAdmission = releaseActiveForegroundAdmission;
      }

      let profileEnvironmentVariables: Record<string, string> = {};
      let profileEnvironmentVariablesRaw: Record<string, string> = {};
      let foregroundSatisfiedProfileSecretRequirementNames: readonly string[] =
        Object.freeze([]);
      const profileLaunchPreferences =
        selectedProfile && accountSettingsContext && profileAgentId
          ? await buildProfileEnvOverlay({
              agentId: profileAgentId,
              profile: selectedProfile,
              processEnv: process.env,
              promptSecretFn:
                startedBy !== 'daemon' && isInteractiveTerminal()
                  ? promptSecret
                  : null,
              reservedEnvironmentVariableNames: new Set(
                foregroundReservedEnvironmentVariableNames,
              ),
              requiredSecretRequirementNamesMissingBinding: new Set(
                profileSecretRequirementNamesMissingBinding,
              ),
            }).then((overlay) => {
              profileEnvironmentVariablesRaw =
                stripSessionControlEnvOverrides(overlay.envOverlayRaw);
              foregroundSatisfiedProfileSecretRequirementNames =
                overlay.foregroundSatisfiedSecretRequirementNames;
              profileEnvironmentVariables = {
                ...profileEnvironmentVariablesRaw,
                HAPPIER_SESSION_PROFILE_ID: selectedProfile.id,
              };
              return {
                permissionModeSeed: overlay.permissionModeSeed,
                preferredModelSelection: preferredProfileModelSelection,
              };
            })
          : null;

      const permissionModeSeedRaw = profileLaunchPreferences?.permissionModeSeed ?? null;
      const permissionModeSeed =
        typeof permissionModeSeedRaw === 'string' && isPermissionMode(permissionModeSeedRaw) ? permissionModeSeedRaw : null;
      const permissionMode: PermissionMode | undefined = resolved.permissionMode ?? (permissionModeSeed ?? undefined);
      const permissionModeUpdatedAt = resolved.permissionModeUpdatedAt ?? (permissionModeSeed ? Date.now() : undefined);
      const providerSpawnExtras =
        params.agentIdForAccountSettings && accountSettingsContext
          ? await (async () => {
            const buildInput = buildAgentCliSessionCommandBuildInput({
              settings: accountSettingsContext.settings as Readonly<Record<string, unknown>>,
              processEnv: buildScopedProcessEnv({
                baseEnv: process.env,
                explicitEnv: profileEnvironmentVariables,
              }),
              startedBy,
              isExplicitCliSubcommand,
              parsed,
            });
            if (foregroundAdmissionClaim) {
              const resolved = await resolveDaemonForegroundAgentRuntimeSessionOptions({
                v: 1,
                attemptId: foregroundAdmissionClaim.attemptId,
                sessionId: foregroundAdmissionClaim.sessionId,
                foregroundPid: process.pid,
                input: buildInput,
              }, {
                ...(params.context.signal ? { signal: params.context.signal } : {}),
              });
              if (!resolved.ok) {
                throw new DirectProviderLaunchError(resolved.error);
              }
              return await finalizeProviderRunOptions(resolved.options);
            }
            return await finalizeProviderRunOptions(
              await resolveProviderSessionRuntimePreferences(
                params.agentIdForAccountSettings,
                buildInput,
              ),
            );
          })()
          : {};
      const providerEnvironmentVariablesRaw = readProviderEnvironmentVariables(
        (providerSpawnExtras as Readonly<Record<string, unknown>>).environmentVariables,
      );
      const providerEnvironmentVariables = providerEnvironmentVariablesRaw
        ? stripSessionControlEnvOverrides(providerEnvironmentVariablesRaw)
        : undefined;
      const extraEnvironmentVariablesRaw = readProviderEnvironmentVariables(
        (extraOptions as Readonly<Record<string, unknown>>).environmentVariables,
      );
      const extraEnvironmentVariables = extraEnvironmentVariablesRaw
        ? stripSessionControlEnvOverrides(extraEnvironmentVariablesRaw)
        : undefined;
      const scopedEnvironmentVariablesRaw = readProviderEnvironmentVariables(
        params.context.scopedEnvironment?.env,
      );
      const scopedEnvironmentVariables = scopedEnvironmentVariablesRaw
        ? stripSessionControlEnvOverrides(scopedEnvironmentVariablesRaw)
        : undefined;
      const baseMergedEnvironmentVariables: Record<string, string> = {
        ...(providerEnvironmentVariables ?? {}),
        ...(extraEnvironmentVariables ?? {}),
        ...(scopedEnvironmentVariables ?? {}),
      };
      const baseUnsetEnvironmentVariables =
        stripSessionControlUnsetEnvKeys(normalizeUnsetEnvKeys([
          ...(readUnsetEnvironmentVariables(
            (providerSpawnExtras as Readonly<Record<string, unknown>>)
              .unsetEnvironmentVariables,
          ) ?? []),
          ...(readUnsetEnvironmentVariables(
            (extraOptions as Readonly<Record<string, unknown>>)
              .unsetEnvironmentVariables,
          ) ?? []),
          ...(readUnsetEnvironmentVariables(
            params.context.scopedEnvironment?.unsetEnvKeys,
          ) ?? []),
          ]));
      const foregroundNativeHomeSourceEnvironmentValue =
        foregroundNativeHomeSourceEnvironmentKey
          ? stripUnsetEnvironmentVariables({
              ...process.env,
              ...profileEnvironmentVariables,
              ...baseMergedEnvironmentVariables,
            }, baseUnsetEnvironmentVariables)[
              foregroundNativeHomeSourceEnvironmentKey
            ]
          : undefined;
      const finalizeEnvironment = (
        admissionEnvironment: Readonly<Record<string, string>>,
        admissionUnsetEnvironmentVariableNames: readonly string[],
      ) => {
        const resolvedProfileEnvironment = selectedProfile
          ? {
              ...stripSessionControlEnvOverrides(expandProfileEnvOverlay({
                profile: selectedProfile,
                envOverlayRaw: profileEnvironmentVariablesRaw,
                processEnv: process.env,
                resolvedEnvironment: admissionEnvironment,
              })),
              HAPPIER_SESSION_PROFILE_ID: selectedProfile.id,
            }
          : profileEnvironmentVariables;
        const mergedEnvironmentVariables: Record<string, string> = {
          ...resolvedProfileEnvironment,
          ...baseMergedEnvironmentVariables,
          ...admissionEnvironment,
        };
        const reservedEnvironmentVariablesToUnset: string[] = [];
        for (const reservedName of foregroundReservedEnvironmentVariableNames) {
          const identity = reservedName.toLowerCase();
          const trustedEntry =
            Object.entries(admissionEnvironment).find(
              ([name]) => name.toLowerCase() === identity,
            )
            ?? Object.entries(resolvedProfileEnvironment).find(
              ([name]) => name.toLowerCase() === identity,
            );
          for (const existingName of Object.keys(mergedEnvironmentVariables)) {
            if (existingName.toLowerCase() === identity) {
              delete mergedEnvironmentVariables[existingName];
            }
          }
          if (trustedEntry) {
            mergedEnvironmentVariables[trustedEntry[0]] = trustedEntry[1];
          } else {
            reservedEnvironmentVariablesToUnset.push(reservedName);
          }
        }
        const unsetEnvironmentVariables =
          stripSessionControlUnsetEnvKeys(normalizeUnsetEnvKeys([
            ...baseUnsetEnvironmentVariables,
            ...admissionUnsetEnvironmentVariableNames,
            ...reservedEnvironmentVariablesToUnset,
          ]));
        return Object.freeze({
          environmentVariables: stripUnsetEnvironmentVariables(
            mergedEnvironmentVariables,
            unsetEnvironmentVariables,
          ),
          unsetEnvironmentVariables,
        });
      };
      let initialEnvironment = foregroundAdmissionClaim
        ? Object.freeze({
            environmentVariables: Object.freeze({}),
            unsetEnvironmentVariables: Object.freeze([]),
          })
        : finalizeEnvironment(
            Object.freeze({}),
            Object.freeze([]),
          );
      let resolveLateEnvironment:
        | ((input: Readonly<{
            sessionId: string;
          }>) => Promise<ReturnType<typeof finalizeEnvironment>>)
        | undefined;
      if (foregroundAdmissionClaim) {
        for (const reservedName of foregroundReservedEnvironmentVariableNames) {
          const identity = reservedName.toLowerCase();
          for (const existingName of Object.keys(
            baseMergedEnvironmentVariables,
          )) {
            if (existingName.toLowerCase() === identity) {
              delete baseMergedEnvironmentVariables[existingName];
            }
          }
        }
        initialEnvironment = Object.freeze({
          environmentVariables: stripUnsetEnvironmentVariables(
            baseMergedEnvironmentVariables,
            baseUnsetEnvironmentVariables,
          ),
          unsetEnvironmentVariables: baseUnsetEnvironmentVariables,
        });
        resolveLateEnvironment = async ({ sessionId }) => {
          const claim = async () => {
            const activeClaim = foregroundAdmissionClaim;
            if (!activeClaim) {
              throw new Error(
                'Foreground Agent runtime admission capability is unavailable',
              );
            }
            return await claimDaemonForegroundAgentRuntimeEnvironment({
              env: {
                [HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY]:
                  activeClaim.admissionFilePath,
              },
              provisionalSessionId: activeClaim.sessionId,
              canonicalSessionId: sessionId,
              attemptId: activeClaim.attemptId,
              foregroundPid: process.pid,
              foregroundSatisfiedProfileSecretRequirementNames,
              ...(foregroundNativeHomeSourceEnvironmentKey === undefined
                ? {}
                : {
                    nativeHomeSourceEnvironmentValue:
                      foregroundNativeHomeSourceEnvironmentValue ?? null,
                  }),
              ...(params.context.signal
                ? { signal: params.context.signal }
                : {}),
            });
          };
          let claimed = await claim();
          if (!claimed.ok && claimed.profileSecretRecovery) {
            if (
              !selectedProfile
              || !admitForegroundRuntime
              || startedBy === 'daemon'
              || !isInteractiveTerminal()
            ) {
              throw new DirectProviderLaunchError(claimed.error);
            }
            const canonicalRequiredSecretNames = new Set(
              (selectedProfile.envVarRequirements ?? [])
                .filter((requirement) =>
                  (requirement.kind ?? 'secret') === 'secret'
                  && requirement.required === true
                )
                .map((requirement) => requirement.name),
            );
            const recoveryNames =
              claimed.profileSecretRecovery.requirementNames;
            if (
              new Set(recoveryNames).size !== recoveryNames.length
              || recoveryNames.some((name) =>
                !canonicalRequiredSecretNames.has(name)
              )
            ) {
              throw new Error(
                'Foreground Profile secret recovery returned invalid requirement names',
              );
            }
            for (const name of recoveryNames) {
              const entered = await promptSecret(`${name}: `);
              const normalized = entered.trim();
              if (!normalized) {
                throw new Error(`Missing required secret value for ${name}.`);
              }
              profileEnvironmentVariablesRaw[name] = normalized;
            }
            foregroundSatisfiedProfileSecretRequirementNames =
              Object.freeze([
                ...new Set([
                  ...foregroundSatisfiedProfileSecretRequirementNames,
                  ...recoveryNames,
                ]),
              ]);
            const priorReservedNames = new Set(
              foregroundReservedEnvironmentVariableNames.map((name) =>
                name.toLowerCase()
              ),
            );
            const staleClaim = foregroundAdmissionClaim;
            foregroundAdmissionClaim = null;
            if (staleClaim) {
              await releaseDaemonForegroundAgentRuntime({
                v: 1,
                attemptId: staleClaim.attemptId,
                sessionId: staleClaim.sessionId,
              }).catch(() => undefined);
            }
            const retryAdmission = await admitForegroundRuntime();
            const retryReservedNames = new Set(
              retryAdmission.reservedEnvironmentVariableNames.map((name) =>
                name.toLowerCase()
              ),
            );
            if (
              priorReservedNames.size !== retryReservedNames.size
              || [...priorReservedNames].some((name) =>
                !retryReservedNames.has(name)
              )
              || foregroundNativeHomeSourceEnvironmentKey
                !== retryAdmission.nativeHomeSourceEnvironmentKey
              || staleClaim?.occurrenceId
                !== retryAdmission.claim.occurrenceId
              || !staleClaim
              || !pluginSourceCustodyV1Equal(
                staleClaim.sourceCustody,
                retryAdmission.claim.sourceCustody,
              )
            ) {
              await releaseDaemonForegroundAgentRuntime({
                v: 1,
                attemptId: retryAdmission.claim.attemptId,
                sessionId: retryAdmission.claim.sessionId,
              }).catch(() => undefined);
              throw new Error(
                'Foreground Agent runtime admission policy changed during Profile secret recovery',
              );
            }
            foregroundAdmissionClaim = retryAdmission.claim;
            claimed = await claim();
            if (!claimed.ok && claimed.profileSecretRecovery) {
              throw new DirectProviderLaunchError(claimed.error);
            }
          }
          if (!claimed.ok) {
            throw new DirectProviderLaunchError(claimed.error);
          }
          const finalized = finalizeEnvironment(
            claimed.environment,
            claimed.unsetEnvironmentVariableNames,
          );
          return Object.freeze({
            ...finalized,
            sensitiveEnvironmentVariableNames:
              claimed.sensitiveEnvironmentVariableNames,
          });
        };
      }

      const sessionRuntimeParams = {
        credentials,
        directory: parsed.directory ?? resolveRequestedSessionDirectory(),
        terminalRuntime: params.context.terminalRuntime,
        ...(parsed.startingMode === 'terminal' || parsed.startingMode === 'remote' || parsed.startingMode === 'local'
          ? { startingMode: parsed.startingMode }
          : {}),
        happyHomeDir: configuration.happyHomeDir,
        startedBy,
        permissionMode,
        permissionModeUpdatedAt,
        sessionModeId: resolved.sessionModeId,
        sessionModeUpdatedAt: resolved.sessionModeUpdatedAt,
        existingSessionId: normalizedExistingSessionId || undefined,
        sessionAttachFilePath: params.context.directSessionLaunch?.sessionAttachFilePath,
        resume,
        accountSettingsContext,
        ...providerSpawnExtras,
        ...extraOptions,
        ...(parsed.nativeForkSource ? { nativeForkSource: parsed.nativeForkSource } : {}),
        ...(parsed.sessionCreationTag ? { sessionCreationTag: parsed.sessionCreationTag } : {}),
        ...(parsed.sessionCreationCorrespondence
          ? { sessionCreationCorrespondence: parsed.sessionCreationCorrespondence }
          : {}),
        ...(parsed.placementOrigin ? { placementOrigin: parsed.placementOrigin } : {}),
        ...(parsed.initialTitle ? { initialTitle: parsed.initialTitle } : {}),
        ...(initialAccess !== undefined ? { initialAccess } : {}),
        ...(parsed.primaryTeamId !== undefined ? { primaryTeamId: parsed.primaryTeamId } : {}),
        ...(() => {
          const teamCredentialBindings = mergeSessionTeamCredentialBindingIntents({
            explicit: parsed.teamCredentialBindings,
            admitted: admittedTeamCredentialBindings,
          });
          return teamCredentialBindings !== undefined ? { teamCredentialBindings } : {};
        })(),
        backendTarget: modelSelectionBackendTargetInput,
        ...(modelSelection ? { modelSelection } : {}),
        environmentVariables:
          Object.keys(initialEnvironment.environmentVariables).length > 0
            ? initialEnvironment.environmentVariables
            : undefined,
        unsetEnvironmentVariables:
          initialEnvironment.unsetEnvironmentVariables.length > 0
            ? initialEnvironment.unsetEnvironmentVariables
            : undefined,
        ...(resolveLateEnvironment ? { resolveLateEnvironment } : {}),
      };
      const sessionHostBridge = getSessionHostBridge();
      if (foregroundAdmissionClaim) {
        await sessionHostBridge.runSessionCommand(
          backendId,
          sessionRuntimeParams,
          {
            agentRuntimeRunnerBootstrapFilePath:
              foregroundAdmissionClaim.bootstrapFilePath,
            agentRuntimeDaemonServiceAuthorityFilePath:
              foregroundAdmissionClaim.authorityFilePath,
          },
        );
      } else {
        await sessionHostBridge.runSessionCommand(
          backendId,
          sessionRuntimeParams,
        );
      }
    } catch (error) {
      logger.fatal(error);
      const exitCode =
        isAgentSessionContinuationUnreachableError(error)
          ? SESSION_RUNNER_EXIT_CODES.CONTINUATION_UNREACHABLE
          : 1;
      const rawLines = error instanceof DirectProviderLaunchError
        ? presentProviderCliRefusal(error.providerError)
        : [error instanceof Error ? error.message : 'Unknown error'];
      console.error(errorFrame('Error:', rawLines));
      if (process.env.DEBUG) {
        const rawDiagnostic = error instanceof Error
          ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
          : String(error);
        console.error(rawDiagnostic);
      }
      await cleanupForegroundAdmission();
      process.exit(exitCode);
    } finally {
      await cleanupForegroundAdmission();
    }
  });
}
