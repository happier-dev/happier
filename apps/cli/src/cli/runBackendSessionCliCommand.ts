import type { AgentId } from '@happier-dev/agents';
import { errorFrame, warn } from '@happier-dev/cli-common/output';

import type { Credentials } from '@/persistence';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded, ensureMachineIdForCredentials } from '@/ui/auth';
import type { CommandContext } from '@/cli/commandRegistry';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '@/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { resolveSessionStartAccountSettingsRefreshMode } from '@/settings/accountSettings/resolveSessionStartAccountSettingsRefreshMode';
import { ensureDaemonRunningForSessionCommand, shouldAutoStartDaemonAfterAuth } from '@/daemon/ensureDaemon';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { applyProfileToProcessEnv } from '@/settings/profiles/applyProfileToProcessEnv';
import { buildProfileEnvOverlay } from '@/settings/profiles/buildProfileEnvOverlay';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { resolveProfileForAgent } from '@/settings/profiles/resolveProfileForAgent';
import { isPermissionMode, type PermissionMode } from '@/api/types';
import {
  applyDeprecatedSessionStartAliasesForAgent,
  type ParsedSessionStartArgs,
} from '@/cli/sessionStartArgs';
import { acquireSessionRunnerLock } from '@/daemon/sessionRunnerLock';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { promptSecret } from '@/terminal/prompts/promptSecret';
import { passthroughProviderCliArgs } from '@/cli/providerCliPassthrough';
import {
  partitionProviderSessionArgs,
  type ProviderSessionArgPartitionResult,
} from '@/cli/providerSessionArgPartition';
import { buildRootHelpText } from '@/cli/buildRootHelpText';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup } from '@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';
import { resolveProviderSessionRuntimePreferences } from '@/backends/catalog';

type CommonBackendRunOptions = ParsedSessionStartArgs & {
  credentials: Credentials;
  directory?: string;
  terminalRuntime: CommandContext['terminalRuntime'];
  happyHomeDir: string;
  existingSessionId: string | undefined;
  resume: string | undefined;
  startedBy: ParsedSessionStartArgs['startedBy'];
  accountSettingsContext: AccountSettingsContext | null;
  environmentVariables?: Record<string, string>;
};

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

async function resolveProviderRunOptions(params: Readonly<{
  agentId: AgentId;
  settings: Readonly<Record<string, unknown>>;
  processEnv: NodeJS.ProcessEnv;
  startedBy: CommonBackendRunOptions['startedBy'];
}>): Promise<Readonly<Record<string, unknown>>> {
  const extras = await resolveProviderSessionRuntimePreferences(params.agentId, {
    settings: params.settings,
    processEnv: params.processEnv,
    startedBy: params.startedBy,
  });
  const environmentVariables = readProviderEnvironmentVariables(extras.environmentVariables);
  return {
    ...extras,
    ...(environmentVariables ? { environmentVariables } : {}),
  };
}

export async function runBackendSessionCliCommand<Extra extends Record<string, unknown>>(params: {
  context: CommandContext;
  backendIdForSessionRuntime: string;
  agentIdForDeprecatedAliases?: AgentId;
  agentIdForAccountSettings?: AgentId;
  loadAccountSettings?: boolean;
  directoryFlags?: readonly string[];
  forwardModelFlag?: boolean;
  forwardResumeFlag?: boolean;
  yoloProviderArgs?: readonly string[];
  versionFlags?: readonly string[];
  resolveExtraOptions?: (args: string[], parsed: ProviderSessionArgPartitionResult) => Extra;
}): Promise<void> {
  let releaseSessionRunnerLock: (() => Promise<void>) | null = null;

  try {
    const agentId = params.agentIdForAccountSettings ?? params.agentIdForDeprecatedAliases;
    const parsed = partitionProviderSessionArgs({
      args: params.context.args,
      providerSubcommand: agentId,
      directoryFlags: params.directoryFlags,
      forwardModelFlag: params.forwardModelFlag,
      forwardResumeFlag: params.forwardResumeFlag,
      yoloProviderArgs: params.yoloProviderArgs,
      versionFlags: params.versionFlags,
    });
    if (agentId && parsed.helpRequested) {
      console.log(`${buildRootHelpText()}

${'-'.repeat(60)}
Provider CLI Options:
`);
      const providerHelpArgs = parsed.providerArgs.some((arg) => arg === '-h' || arg === '--help')
        ? parsed.providerArgs
        : [...parsed.providerArgs, '--help'];
      passthroughProviderCliArgs({ agentId, providerArgs: providerHelpArgs });
      return;
    }
    if (agentId && parsed.versionRequested && parsed.versionFlag) {
      passthroughProviderCliArgs({ agentId, providerArgs: [parsed.versionFlag] });
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
    const startedBy = resolved.startedBy ?? 'terminal';

    const selfMigration = await selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup();
    if (selfMigration) {
      logger.debug('[session] Self-migrated daemon-spawned runner out of daemon service cgroup', {
        migration: selfMigration,
      });
    }

    const normalizedExistingSessionId = typeof existingSessionId === 'string' ? existingSessionId.trim() : '';
    if (normalizedExistingSessionId) {
      const lock = await acquireSessionRunnerLock({ sessionId: normalizedExistingSessionId });
      if (!lock.ok) {
        if (lock.reason === 'already_running') {
          throw new Error(
            `Session ${normalizedExistingSessionId} is already running on this machine (pid=${lock.heldByPid}).`,
          );
        }
        throw new Error(`Failed to acquire session runner lock for ${normalizedExistingSessionId} (${lock.reason}).`);
      }
      releaseSessionRunnerLock = lock.release;
    }
    const backendId = params.backendIdForSessionRuntime.trim();
    if (!backendId) {
      throw new Error('Session command is missing a backend id for session startup');
    }

    let credentials = await readCredentials();
    if (!credentials) {
      const auth = await authAndSetupMachineIfNeeded();
      credentials = auth.credentials;
    } else {
      await ensureMachineIdForCredentials(credentials);
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
    const agentIdForProfiles = params.agentIdForAccountSettings ?? params.agentIdForDeprecatedAliases;

    if (params.agentIdForAccountSettings || params.loadAccountSettings || profileQuery) {
      const accountSettingsBootstrapMode = startedBy === 'daemon' ? 'blocking' : 'fast';
      const snapshot = await bootstrapAccountSettingsContext({
        ...(agentIdForProfiles ? { agentId: agentIdForProfiles } : {}),
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

    const permissionModeSeededByProfile = profileQuery && accountSettingsContext && agentIdForProfiles
      ? (() => {
        const { customProfiles } = readProfilesFromAccountSettings(accountSettingsContext.settings as any);
        const profile = resolveProfileForAgent({ agentId: agentIdForProfiles, query: profileQuery, customProfiles });
        const promptSecretFn =
          startedBy !== 'daemon' && isInteractiveTerminal()
            ? promptSecret
            : null;
        return buildProfileEnvOverlay({
          agentId: agentIdForProfiles,
          profile,
          accountSettings: accountSettingsContext.settings as any,
          credentials,
          processEnv: process.env,
          promptSecretFn,
          startedBy,
        }).then((overlay) => {
          applyProfileToProcessEnv({ profileId: overlay.profileId, envOverlayExpanded: overlay.envOverlayExpanded });
          return overlay.permissionModeSeed;
        });
      })()
      : null;

    const permissionModeSeedRaw = permissionModeSeededByProfile ? await permissionModeSeededByProfile : null;
    const permissionModeSeed =
      typeof permissionModeSeedRaw === 'string' && isPermissionMode(permissionModeSeedRaw) ? permissionModeSeedRaw : null;
    const permissionMode: PermissionMode | undefined = resolved.permissionMode ?? (permissionModeSeed ?? undefined);
    const permissionModeUpdatedAt = resolved.permissionModeUpdatedAt ?? (permissionModeSeed ? Date.now() : undefined);
    const providerSpawnExtras =
      params.agentIdForAccountSettings && accountSettingsContext
        ? await resolveProviderRunOptions({
          agentId: params.agentIdForAccountSettings,
          settings: accountSettingsContext.settings as Readonly<Record<string, unknown>>,
          processEnv: process.env,
          startedBy,
        })
        : {};

    await getSessionHostBridge().runSessionCommand(backendId, {
      credentials,
      directory: parsed.directory ?? resolveRequestedSessionDirectory(),
      terminalRuntime: params.context.terminalRuntime,
      happyHomeDir: configuration.happyHomeDir,
      startedBy,
      permissionMode,
      permissionModeUpdatedAt,
      sessionModeId: resolved.sessionModeId,
      sessionModeUpdatedAt: resolved.sessionModeUpdatedAt,
      modelId: resolved.modelId,
      modelUpdatedAt: resolved.modelUpdatedAt,
      existingSessionId: normalizedExistingSessionId || undefined,
      resume,
      accountSettingsContext,
      ...providerSpawnExtras,
      ...extraOptions,
    });
  } catch (error) {
    console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
    if (process.env.DEBUG) {
      console.error(error);
    }
    await releaseSessionRunnerLock?.().catch(() => {});
    releaseSessionRunnerLock = null;
    process.exit(1);
  } finally {
    await releaseSessionRunnerLock?.().catch(() => {});
  }
}
