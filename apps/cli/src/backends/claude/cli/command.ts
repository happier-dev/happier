import chalk from 'chalk';
import { z } from 'zod';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { PERMISSION_MODES, isPermissionMode } from '@/api/types';
import { runClaude, type StartOptions } from '@/backends/claude/runClaude';
import { isClaudeCliJavaScriptFile } from '@/backends/claude/utils/resolveClaudeCliPath';
import { readCredentials, readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded, ensureMachineIdForCredentials } from '@/ui/auth';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '@/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { resolveSessionStartAccountSettingsRefreshMode } from '@/settings/accountSettings/resolveSessionStartAccountSettingsRefreshMode';
import { applyProfileToProcessEnv } from '@/settings/profiles/applyProfileToProcessEnv';
import { buildProfileEnvOverlay } from '@/settings/profiles/buildProfileEnvOverlay';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { resolveProfileForAgent } from '@/settings/profiles/resolveProfileForAgent';
import { resolveProviderOutgoingMessageMetaExtras } from '@/settings/providerSettings';
import { ensureDaemonRunningForSessionCommand, shouldAutoStartDaemonAfterAuth } from '@/daemon/ensureDaemon';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { promptSecret } from '@/terminal/prompts/promptSecret';
import { configuration } from '@/configuration';
import { buildRootHelpText } from '@/cli/buildRootHelpText';
import { requireJavaScriptRuntimeExecutable } from '@/runtime/js/requireJavaScriptRuntimeExecutable';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { readProviderCliOverride } from '@/runtime/managedTools/providerCliResolution';
import { isBun } from '@/utils/runtime';
import packageJson from '../../../../package.json';

import type { CommandContext } from '@/cli/commandRegistry';

export function stripHappyInternalSettingsFlag(
  args: readonly string[],
  opts?: { warn?: (msg: string) => void },
): string[] {
  const warn = opts?.warn ?? console.warn;

  const stripped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== '--settings') {
      stripped.push(arg);
      continue;
    }

    const settingsValue = args[i + 1];
    i++; // Consume the value (if any), like upstream's behavior.

    const displayedValue = typeof settingsValue === 'string' ? settingsValue : '<missing>';
    warn(chalk.yellow(`⚠️  Warning: --settings is used internally by Happier for session tracking.`));
    warn(chalk.yellow(`   Your settings file "${displayedValue}" will be ignored.`));
    warn(chalk.yellow(`   To configure Claude, edit ~/.claude/settings.json instead.`));
  }
  return stripped;
}

export async function handleClaudeCliCommand(context: CommandContext): Promise<void> {
  const args = [...context.args];

  // Support `happier claude ...` while keeping `happier ...` as the default Claude flow.
  if (args.length > 0 && args[0] === 'claude') {
    args.shift();
  }

  const strippedArgs = stripHappyInternalSettingsFlag(args);

  // Parse command line arguments for main command
  const options: StartOptions = {};
  let showHelp = false;
  let showVersion = false;
  let refreshSettings = false;
  let profileQuery: string | null = null;
  let chromeOverride: boolean | undefined = undefined;
  const unknownArgs: string[] = []; // Collect unknown args to pass through to claude

  for (let i = 0; i < strippedArgs.length; i++) {
    const arg = strippedArgs[i];

    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      unknownArgs.push(arg);
    } else if (arg === '-v' || arg === '--version') {
      showVersion = true;
      unknownArgs.push(arg);
    } else if (arg === '--refresh-settings') {
      refreshSettings = true;
    } else if (arg === '--profile') {
      if (i + 1 >= strippedArgs.length) {
        console.error(chalk.red('Missing value for --profile (expected: profile id or name)'));
        process.exit(1);
      }
      const raw = strippedArgs[++i];
      const normalized = typeof raw === 'string' ? raw.trim() : '';
      if (!normalized) {
        console.error(chalk.red('Invalid --profile value: empty'));
        process.exit(1);
      }
      profileQuery = normalized;
    } else if (arg.startsWith('--profile=')) {
      const normalized = arg.slice('--profile='.length).trim();
      if (!normalized) {
        console.error(chalk.red('Invalid --profile value: empty'));
        process.exit(1);
      }
      profileQuery = normalized;
    } else if (arg === '--happy-starting-mode') {
      options.startingMode = z.enum(['local', 'remote']).parse(strippedArgs[++i]);
    } else if (arg === '--yolo') {
      // Shortcut for --dangerously-skip-permissions
      unknownArgs.push('--dangerously-skip-permissions');
    } else if (arg === '--started-by') {
      options.startedBy = strippedArgs[++i] as 'daemon' | 'terminal';
    } else if (arg === '--permission-mode') {
      if (i + 1 >= strippedArgs.length) {
        console.error(chalk.red(`Missing value for --permission-mode. Valid values: ${PERMISSION_MODES.join(', ')}`));
        process.exit(1);
      }
      const value = strippedArgs[++i];
      if (!isPermissionMode(value)) {
        console.error(chalk.red(`Invalid --permission-mode value: ${value}. Valid values: ${PERMISSION_MODES.join(', ')}`));
        process.exit(1);
      }
      options.permissionMode = value;
    } else if (arg === '--permission-mode-updated-at') {
      if (i + 1 >= strippedArgs.length) {
        console.error(chalk.red('Missing value for --permission-mode-updated-at (expected: unix ms timestamp)'));
        process.exit(1);
      }
      const raw = strippedArgs[++i];
      const parsedAt = Number(raw);
      if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
        console.error(chalk.red(`Invalid --permission-mode-updated-at value: ${raw}. Expected a positive number (unix ms)`));
        process.exit(1);
      }
      options.permissionModeUpdatedAt = Math.floor(parsedAt);
    } else if (arg === '--model') {
      if (i + 1 >= strippedArgs.length) {
        console.error(chalk.red('Missing value for --model (expected: model id)'));
        process.exit(1);
      }
      const raw = strippedArgs[++i];
      const normalized = typeof raw === 'string' ? raw.trim() : '';
      if (!normalized) {
        console.error(chalk.red('Invalid --model value: empty'));
        process.exit(1);
      }
      options.modelId = normalized;
      unknownArgs.push('--model', normalized);
    } else if (arg === '--model-updated-at') {
      if (i + 1 >= strippedArgs.length) {
        console.error(chalk.red('Missing value for --model-updated-at (expected: unix ms timestamp)'));
        process.exit(1);
      }
      const raw = strippedArgs[++i];
      const parsedAt = Number(raw);
      if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
        console.error(chalk.red(`Invalid --model-updated-at value: ${raw}. Expected a positive number (unix ms)`));
        process.exit(1);
      }
      options.modelUpdatedAt = Math.floor(parsedAt);
    } else if (arg === '--js-runtime') {
      const runtime = strippedArgs[++i];
      if (runtime !== 'node' && runtime !== 'bun') {
        console.error(chalk.red(`Invalid --js-runtime value: ${runtime}. Must be 'node' or 'bun'`));
        process.exit(1);
      }
      options.jsRuntime = runtime;
    } else if (arg === '--existing-session') {
      // Used by daemon to reconnect to an existing session (for inactive session resume)
      options.existingSessionId = strippedArgs[++i];
    } else if (arg === '--chrome') {
      chromeOverride = true;
    } else if (arg === '--no-chrome') {
      chromeOverride = false;
    } else {
      unknownArgs.push(arg);
      // Check if this arg expects a value (simplified check for common patterns)
      if (i + 1 < strippedArgs.length && !strippedArgs[i + 1].startsWith('-')) {
        unknownArgs.push(strippedArgs[++i]);
      }
    }
  }

  if (unknownArgs.length > 0) {
    options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs];
  }

  if (typeof options.modelId === 'string' && options.modelId.trim()) {
    options.model = options.modelId.trim();
  }

  // Resolve Chrome mode: explicit flag > settings > false
  const settings = await readSettings();
  const chromeEnabled = chromeOverride ?? settings.chromeMode ?? false;
  if (chromeEnabled && !(options.claudeArgs || []).includes('--chrome')) {
    options.claudeArgs = [...(options.claudeArgs || []), '--chrome'];
  }

  if (showHelp) {
    console.log(`${buildRootHelpText()}
${chalk.bold('Happier supports ALL Claude options!')}
  Use any claude flag with happier as you would with claude. Our favorite:

  happier --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`);

    // Run claude --help and display its output
    try {
      const { execFileSync } = await import('node:child_process');
      const helpInvocation = await resolveClaudeHelpInvocation();
      const claudeHelp = execFileSync(
        helpInvocation.command,
        helpInvocation.args,
        {
          encoding: 'utf8',
          windowsHide: true,
          ...(helpInvocation.env ? { env: helpInvocation.env } : {}),
          ...(helpInvocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          ...(configuration.vendorCliHelpTimeoutMs > 0 ? { timeout: configuration.vendorCliHelpTimeoutMs } : {}),
        },
      );
      console.log(claudeHelp);
    } catch (error) {
      if (error instanceof ReferenceError) {
        console.log(chalk.yellow(error.message));
        if (readProviderCliOverride('claude')) {
          process.exit(1);
        }
      } else {
        console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'));
      }
    }

    process.exit(0);
  }

  if (showVersion) {
    console.log(`happier version: ${packageJson.version}`);
    const versionOnlyInvocation =
      strippedArgs.length > 0 &&
      strippedArgs.every((arg) => arg === '-v' || arg === '--version');
    if (versionOnlyInvocation) {
      return;
    }
    // For mixed invocations, continue and pass --version through to Claude Code.
  }

  const startedBy = options.startedBy ?? 'terminal';
  const startingMode = options.startingMode ?? 'local';
  const isDaemonStartedRemoteSession = startedBy === 'daemon' && startingMode === 'remote';
  const shouldPreferFastBootstrap = (startedBy === 'terminal' && startingMode === 'local') || isDaemonStartedRemoteSession;
  const accountSettingsBootstrapMode = shouldPreferFastBootstrap ? 'fast' : 'blocking';
  const shouldForceAccountSettingsRefresh = refreshSettings || isDaemonStartedRemoteSession;

  let credentials = await readCredentials();
  if (!credentials) {
    const auth = await authAndSetupMachineIfNeeded();
    credentials = auth.credentials;
  } else {
    await ensureMachineIdForCredentials(credentials);
    if (shouldAutoStartDaemonAfterAuth({ env: process.env, isDaemonProcess: configuration.isDaemonProcess, startedBy })) {
      void ensureDaemonRunningForSessionCommand().catch((error) => {
        logger.debug('[claude] Failed to auto-start daemon (non-fatal)', error);
      });
    }
  }

  try {
    const snapshot = await bootstrapAccountSettingsContext({
      agentId: 'claude',
      credentials,
      mode: accountSettingsBootstrapMode,
      refresh: resolveSessionStartAccountSettingsRefreshMode({
        mode: accountSettingsBootstrapMode,
        refreshRequested: shouldForceAccountSettingsRefresh,
      }),
    });
    const effectiveSnapshot = await resolveSessionStartAccountSettingsContext({
      startedBy,
      snapshot,
    });
    options.claudeRemoteMetaDefaults = resolveProviderOutgoingMessageMetaExtras({
      agentId: 'claude',
      settings: effectiveSnapshot.settings,
      session: null,
    });
    options.accountSettings = effectiveSnapshot.settings;
    if (profileQuery) {
      const { customProfiles } = readProfilesFromAccountSettings(effectiveSnapshot.settings);
      const profile = resolveProfileForAgent({ agentId: 'claude', query: profileQuery, customProfiles });
      const promptSecretFn = startedBy !== 'daemon' && isInteractiveTerminal()
        ? promptSecret
        : null;
      const overlay = await buildProfileEnvOverlay({
        agentId: 'claude',
        profile,
        accountSettings: effectiveSnapshot.settings,
        credentials,
        processEnv: process.env,
        promptSecretFn,
        startedBy,
      });
      applyProfileToProcessEnv({ profileId: overlay.profileId, envOverlayExpanded: overlay.envOverlayExpanded });

      if (typeof options.permissionMode !== 'string' && overlay.permissionModeSeed) {
        options.permissionMode = overlay.permissionModeSeed;
        options.permissionModeUpdatedAt = options.permissionModeUpdatedAt ?? Date.now();
      }
    }
    options.terminalRuntime = context.terminalRuntime;
    await runClaude(credentials, options);
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

async function resolveClaudeHelpInvocation(): Promise<{
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}> {
  const launch = requireProviderCliLaunchSpec('claude');
  if (isClaudeCliJavaScriptFile(launch.resolvedPath)) {
    const runtimeExecutable = await requireJavaScriptRuntimeExecutable({
      isBunRuntime: isBun(),
      targetLabel: 'Claude Code help',
    });
    const invocation = resolveWindowsCommandInvocation({
      command: runtimeExecutable,
      args: [launch.resolvedPath, '--help'],
      env: process.env,
    });
    return {
      command: invocation.command,
      args: [...invocation.args],
      env: process.env,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    };
  }

  const invocation = resolveWindowsCommandInvocation({
    command: launch.command,
    args: [...launch.args, '--help'],
    env: process.env,
  });
  return {
    command: invocation.command,
    args: [...invocation.args],
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
}
