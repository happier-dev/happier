import chalk from 'chalk';

import type { AgentId } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded, ensureMachineIdForCredentials } from '@/ui/auth';
import type { CommandContext } from '@/cli/commandRegistry';
import { bootstrapAccountSettingsContext, type AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '@/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { resolveSessionStartAccountSettingsRefreshMode } from '@/settings/accountSettings/resolveSessionStartAccountSettingsRefreshMode';
import { resolveProviderSpawnExtras } from '@/settings/providerSettings';
import { ensureDaemonRunningForSessionCommand, shouldAutoStartDaemonAfterAuth } from '@/daemon/ensureDaemon';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import {
  applyDeprecatedSessionStartAliasesForAgent,
  parseSessionStartArgs,
  readOptionalFlagValue,
  type ParsedSessionStartArgs,
} from '@/cli/sessionStartArgs';
import { acquireSessionRunnerLock } from '@/daemon/sessionRunnerLock';

type CommonBackendRunOptions = ParsedSessionStartArgs & {
  credentials: Credentials;
  terminalRuntime: CommandContext['terminalRuntime'];
  existingSessionId: string | undefined;
  resume: string | undefined;
  accountSettingsContext: AccountSettingsContext | null;
  experimentalCodexAcp?: boolean;
};

export async function runBackendSessionCliCommand<Extra extends Record<string, unknown>>(params: {
  context: CommandContext;
  loadRun: () => Promise<(opts: CommonBackendRunOptions & Extra) => Promise<void>>;
  agentIdForDeprecatedAliases?: AgentId;
  agentIdForAccountSettings?: AgentId;
  resolveExtraOptions?: (args: string[]) => Extra;
}): Promise<void> {
  let releaseSessionRunnerLock: (() => Promise<void>) | null = null;

  try {
    const refreshSettings = params.context.args.includes('--refresh-settings');

    const parsed = parseSessionStartArgs(params.context.args);
    const resolved = params.agentIdForDeprecatedAliases
      ? applyDeprecatedSessionStartAliasesForAgent({ agentId: params.agentIdForDeprecatedAliases, ...parsed })
      : { ...parsed, warnings: [] as string[] };

    for (const warning of resolved.warnings) {
      console.error(chalk.yellow(warning));
    }

    const existingSessionId = readOptionalFlagValue(params.context.args, '--existing-session');
    const resume = readOptionalFlagValue(params.context.args, '--resume');
    const extraOptions = params.resolveExtraOptions ? params.resolveExtraOptions(params.context.args) : ({} as Extra);
    const startedBy = resolved.startedBy ?? 'terminal';

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
      if (shouldAutoStartDaemonAfterAuth({ env: process.env, isDaemonProcess: configuration.isDaemonProcess })) {
        void ensureDaemonRunningForSessionCommand().catch((error) => {
          logger.debug('[session] Failed to auto-start daemon (non-fatal)', error);
        });
      }
    }

    const run = await runPromise;

    let accountSettingsContext: AccountSettingsContext | null = null;
    if (params.agentIdForAccountSettings) {
      const accountSettingsBootstrapMode = startedBy === 'daemon' ? 'blocking' : 'fast';
      const snapshot = await bootstrapAccountSettingsContext({
        agentId: params.agentIdForAccountSettings,
        credentials,
        mode: accountSettingsBootstrapMode,
        refresh: resolveSessionStartAccountSettingsRefreshMode({
          mode: accountSettingsBootstrapMode,
          refreshRequested: refreshSettings,
        }),
      });
      accountSettingsContext = await resolveSessionStartAccountSettingsContext({
        startedBy,
        snapshot,
      });
    }

    const providerSpawnExtras =
      params.agentIdForAccountSettings && accountSettingsContext
        ? resolveProviderSpawnExtras({ agentId: params.agentIdForAccountSettings, settings: accountSettingsContext.settings })
        : {};

    await run({
      credentials,
      terminalRuntime: params.context.terminalRuntime,
      startedBy,
      permissionMode: resolved.permissionMode,
      permissionModeUpdatedAt: resolved.permissionModeUpdatedAt,
      agentModeId: resolved.agentModeId,
      agentModeUpdatedAt: resolved.agentModeUpdatedAt,
      modelId: resolved.modelId,
      modelUpdatedAt: resolved.modelUpdatedAt,
      existingSessionId: normalizedExistingSessionId || undefined,
      resume,
      accountSettingsContext,
      ...providerSpawnExtras,
      ...extraOptions,
    });
  } catch (error) {
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
