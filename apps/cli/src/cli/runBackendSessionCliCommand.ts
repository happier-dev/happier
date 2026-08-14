import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

import type { AgentId, CodexBackendMode, KimiAcpPythonSelector } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded, ensureMachineIdForCredentials } from '@/ui/auth';
import type { CommandContext } from '@/cli/commandRegistry';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '@/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { resolveSessionStartAccountSettingsRefreshMode } from '@/settings/accountSettings/resolveSessionStartAccountSettingsRefreshMode';
import { resolveProviderSpawnExtrasForRuntime } from '@/settings/providerSettings';
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
import { partitionProviderSessionArgs, type ProviderSessionArgPartitionResult } from '@/cli/providerSessionArgPartition';
import { buildRootHelpText } from '@/cli/buildRootHelpText';
import { acquireSessionRunnerLock } from '@/daemon/sessionRunnerLock';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { promptSecret } from '@/terminal/prompts/promptSecret';
import { maybePassthroughProviderCliInfoRequest, passthroughProviderCliArgs } from '@/cli/providerCliPassthrough';
import { selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup } from '@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import {
  overlayDirectConnectedServiceEnvironment,
  resolveDirectConnectedServiceEnvironment,
} from '@/cli/connectedServices/resolveDirectConnectedServiceEnvironment';
import { resolveDirectCliConnectedServiceBindings } from '@/cli/connectedServices/resolveDirectCliConnectedServiceBindings';
import { HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY } from '@/agent/runtime/sessionConnectedServicesBindingsEnv';

type CommonBackendRunOptions = ParsedSessionStartArgs & {
  credentials: Credentials;
  terminalRuntime: CommandContext['terminalRuntime'];
  existingSessionId: string | undefined;
  resume: string | undefined;
  providerArgs: string[];
  accountSettingsContext: AccountSettingsContext | null;
  experimentalCodexAcp?: boolean;
  codexBackendMode?: CodexBackendMode;
  cursorBinaryPath?: string;
  cursorAgentFallbackEnabled?: boolean;
  cursorApiEndpoint?: string;
  kimiAcpPythonSelector?: KimiAcpPythonSelector;
};

type ProviderRunOptionKeys =
  | 'experimentalCodexAcp'
  | 'codexBackendMode'
  | 'cursorBinaryPath'
  | 'cursorAgentFallbackEnabled'
  | 'cursorApiEndpoint'
  | 'kimiAcpPythonSelector';

function pickProviderRunOptions(extras: Record<string, unknown>): Pick<CommonBackendRunOptions, ProviderRunOptionKeys> {
  const out: Pick<CommonBackendRunOptions, ProviderRunOptionKeys> = {};

  if (
    extras.codexBackendMode === 'mcp'
    || extras.codexBackendMode === 'acp'
    || extras.codexBackendMode === 'appServer'
  ) {
    out.codexBackendMode = extras.codexBackendMode;
    return out;
  }

  if (extras.experimentalCodexAcp === true || extras.experimentalCodexAcp === false) {
    out.experimentalCodexAcp = extras.experimentalCodexAcp;
  }

  if (typeof extras.cursorBinaryPath === 'string') {
    const cursorBinaryPath = extras.cursorBinaryPath.trim();
    if (cursorBinaryPath) out.cursorBinaryPath = cursorBinaryPath;
  }

  if (extras.cursorAgentFallbackEnabled === false) {
    out.cursorAgentFallbackEnabled = false;
  }

  if (typeof extras.cursorApiEndpoint === 'string') {
    const cursorApiEndpoint = extras.cursorApiEndpoint.trim();
    if (cursorApiEndpoint) out.cursorApiEndpoint = cursorApiEndpoint;
  }

  if (extras.kimiAcpPythonSelector === 'auto' || extras.kimiAcpPythonSelector === 'poll') {
    out.kimiAcpPythonSelector = extras.kimiAcpPythonSelector;
  }

  return out;
}

function pickSessionStartArgs(parsed: ProviderSessionArgPartitionResult): ParsedSessionStartArgs {
  return {
    startedBy: parsed.startedBy,
    permissionMode: parsed.permissionMode,
    permissionModeUpdatedAt: parsed.permissionModeUpdatedAt,
    agentModeId: parsed.agentModeId,
    agentModeUpdatedAt: parsed.agentModeUpdatedAt,
    modelId: parsed.modelId,
    modelUpdatedAt: parsed.modelUpdatedAt,
  };
}

export async function runBackendSessionCliCommand<Extra extends Record<string, unknown>>(params: {
  context: CommandContext;
  loadRun: () => Promise<(opts: CommonBackendRunOptions & Extra) => Promise<void>>;
  agentIdForDeprecatedAliases?: AgentId;
  agentIdForAccountSettings?: AgentId;
  loadAccountSettings?: boolean;
  directoryFlags?: readonly string[];
  forwardModelFlag?: boolean;
  versionFlags?: readonly string[];
  resolveExtraOptions?: (args: string[], parsed: ProviderSessionArgPartitionResult) => Extra;
  resolveDirectConnectedServiceEnvironmentFn?: typeof resolveDirectConnectedServiceEnvironment;
}): Promise<void> {
  let releaseSessionRunnerLock: (() => Promise<void>) | null = null;

  try {
    const agentId = params.agentIdForAccountSettings ?? params.agentIdForDeprecatedAliases;
    const parsed = partitionProviderSessionArgs({
      args: params.context.args,
      providerSubcommand: agentId,
      directoryFlags: params.directoryFlags,
      forwardModelFlag: params.forwardModelFlag,
      versionFlags: params.versionFlags,
    });

    if (agentId && parsed.helpRequested) {
      const providerHelpArgs = [...parsed.providerArgs, '--help'];
      const providerHelpCommand = `${agentId} ${providerHelpArgs.join(' ')}`;
      console.log(`${buildRootHelpText()}
${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan(`${agentId} CLI Options (from \`${providerHelpCommand}\`):`)}
`);
      passthroughProviderCliArgs({ agentId, providerArgs: providerHelpArgs });
      return;
    }

    if (agentId && parsed.versionRequested && maybePassthroughProviderCliInfoRequest({ agentId, args: [parsed.versionFlag ?? '--version'] })) {
      return;
    }

    const refreshSettings = parsed.refreshSettings;

    const sessionStartArgs = pickSessionStartArgs(parsed);
    const resolved = params.agentIdForDeprecatedAliases
      ? applyDeprecatedSessionStartAliasesForAgent({ agentId: params.agentIdForDeprecatedAliases, ...sessionStartArgs })
      : { ...sessionStartArgs, warnings: [] as string[] };

    for (const warning of resolved.warnings) {
      console.error(chalk.yellow(warning));
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

    const runPromise = params.loadRun();

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

    const run = await runPromise;

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
          refreshRequested: refreshSettings,
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
        ? pickProviderRunOptions(resolveProviderSpawnExtrasForRuntime({
          agentId: params.agentIdForAccountSettings,
          settings: accountSettingsContext.settings as Readonly<Record<string, unknown>>,
          processEnv: process.env,
        }))
        : {};

    let directConnectedServiceEnvironment: Awaited<
      ReturnType<typeof resolveDirectConnectedServiceEnvironment>
    > = null;
    let restoreDirectConnectedServiceEnvironment: (() => void) | null = null;
    let runCompleted = false;
    try {
      const shouldResolveDirectConnectedServices =
        startedBy !== 'daemon'
        && agentIdForProfiles !== undefined
        && accountSettingsContext !== null
        && !process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY];
      if (shouldResolveDirectConnectedServices) {
        if (!accountSettingsContext) {
          throw new Error('connected_service_auth_unsupported');
        }
        const directAccountSettings = accountSettingsContext.settings;
        const connectedServices = await resolveDirectCliConnectedServiceBindings({
          agentId: agentIdForProfiles,
          credentials,
          accountSettings: directAccountSettings,
          authRaw: parsed.connectedServicesAuthRaw,
          authJsonRaw: parsed.connectedServicesAuthJsonRaw,
        });
        if (connectedServices) {
          directConnectedServiceEnvironment = await (
            params.resolveDirectConnectedServiceEnvironmentFn
            ?? resolveDirectConnectedServiceEnvironment
          )({
            agentId: agentIdForProfiles,
            credentials,
            accountSettings: directAccountSettings,
            directory: parsed.directory ?? process.cwd(),
            sessionId: normalizedExistingSessionId || `direct-${randomUUID()}`,
            connectedServices,
          });
          if (directConnectedServiceEnvironment) {
            restoreDirectConnectedServiceEnvironment = overlayDirectConnectedServiceEnvironment(
              directConnectedServiceEnvironment.env,
            );
          }
        }
      }

      await run({
        credentials,
        terminalRuntime: params.context.terminalRuntime,
        startedBy,
        permissionMode,
        permissionModeUpdatedAt,
        agentModeId: resolved.agentModeId,
        agentModeUpdatedAt: resolved.agentModeUpdatedAt,
        modelId: resolved.modelId,
        modelUpdatedAt: resolved.modelUpdatedAt,
        existingSessionId: normalizedExistingSessionId || undefined,
        resume,
        providerArgs: parsed.providerArgs,
        accountSettingsContext,
        ...providerSpawnExtras,
        ...extraOptions,
      });
      runCompleted = true;
    } finally {
      restoreDirectConnectedServiceEnvironment?.();
      if (runCompleted) directConnectedServiceEnvironment?.cleanupOnExit?.();
      else directConnectedServiceEnvironment?.cleanupOnFailure?.();
    }
  } catch (error) {
    logger.fatal(error);
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
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
