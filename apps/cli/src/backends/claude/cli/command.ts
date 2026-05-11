import chalk from 'chalk';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

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
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { handleResumeCommand } from '@/cli/commands/resume';
import { partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';

import type { CommandContext } from '@/cli/commandRegistry';

function readResumeFlagValue(args: readonly string[] | null | undefined): { flagIndex: number; valueIndex: number; value: string } | null {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const flag = list[i];
    if (flag !== '--resume' && flag !== '-r') continue;
    const next = list[i + 1];
    if (typeof next !== 'string') return null;
    if (next.startsWith('-')) return null; // `--resume` without an explicit id
    const trimmed = next.trim();
    if (!trimmed) return null;
    return { flagIndex: i, valueIndex: i + 1, value: trimmed };
  }
  return null;
}

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

function extractClaudeWrapperFlags(args: readonly string[]): {
  argsWithoutWrapperFlags: string[];
  chromeOverride: boolean | undefined;
  jsRuntime: StartOptions['jsRuntime'];
} {
  const argsWithoutWrapperFlags: string[] = [];
  let chromeOverride: boolean | undefined;
  let jsRuntime: StartOptions['jsRuntime'];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--chrome') {
      chromeOverride = true;
      continue;
    }
    if (arg === '--no-chrome') {
      chromeOverride = false;
      continue;
    }
    if (arg === '--js-runtime') {
      const runtime = args[i + 1];
      if (typeof runtime !== 'string' || runtime.startsWith('-')) {
        console.error(chalk.red('Missing value for --js-runtime. Expected: node|bun'));
        process.exit(1);
      }
      if (runtime !== 'node' && runtime !== 'bun') {
        console.error(chalk.red(`Invalid --js-runtime value: ${runtime}. Must be 'node' or 'bun'`));
        process.exit(1);
      }
      jsRuntime = runtime;
      i += 1;
      continue;
    }
    argsWithoutWrapperFlags.push(arg);
  }

  return { argsWithoutWrapperFlags, chromeOverride, jsRuntime };
}

export async function handleClaudeCliCommand(context: CommandContext): Promise<void> {
  const args = [...context.args];

  // Support `happier claude ...` while keeping `happier ...` as the default Claude flow.
  const explicitClaudeSubcommand = args.length > 0 && args[0] === 'claude';
  if (explicitClaudeSubcommand) {
    args.shift();
  }

  const strippedArgs = stripHappyInternalSettingsFlag(args);

  const claudeWrapperFlags = extractClaudeWrapperFlags(strippedArgs);
  const parsed = partitionProviderSessionArgs({
    args: claudeWrapperFlags.argsWithoutWrapperFlags,
    providerSubcommand: 'claude',
    forwardModelFlag: true,
    forwardResumeFlag: true,
    yoloProviderArgs: ['--dangerously-skip-permissions'],
  });

  const options: StartOptions = {
    ...(parsed.permissionMode ? { permissionMode: parsed.permissionMode } : {}),
    ...(typeof parsed.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: parsed.permissionModeUpdatedAt } : {}),
    ...(parsed.modelId ? { modelId: parsed.modelId } : {}),
    ...(typeof parsed.modelUpdatedAt === 'number' ? { modelUpdatedAt: parsed.modelUpdatedAt } : {}),
    ...(parsed.startedBy ? { startedBy: parsed.startedBy } : {}),
    ...(parsed.existingSessionId ? { existingSessionId: parsed.existingSessionId } : {}),
    ...(claudeWrapperFlags.jsRuntime ? { jsRuntime: claudeWrapperFlags.jsRuntime } : {}),
  };
  if (parsed.startingMode) {
    if (parsed.startingMode !== 'local' && parsed.startingMode !== 'remote') {
      console.error(chalk.red(`Invalid --happy-starting-mode: ${parsed.startingMode}. Use "local" or "remote".`));
      process.exit(1);
    }
    options.startingMode = parsed.startingMode;
  }
  if (parsed.providerArgs.length > 0) {
    options.claudeArgs = [...parsed.providerArgs];
  }

  const showHelp = parsed.helpRequested;
  const showVersion = parsed.versionRequested;
  const refreshSettings = parsed.refreshSettings;
  const profileQuery = parsed.profileQuery ?? null;
  const chromeOverride = claudeWrapperFlags.chromeOverride;

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
    const providerHelpArgs = [...parsed.providerArgs, '--help'];
    const providerHelpCommand = `claude ${providerHelpArgs.join(' ')}`;
    console.log(`${buildRootHelpText()}
${chalk.bold('Happier supports ALL Claude options!')}
  Use any claude flag with happier as you would with claude. Our favorite:

  happier --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan(`Claude Code Options (from \`${providerHelpCommand}\`):`)}
`);

    // Run claude --help and display its output
    try {
      const { execFileSync } = await import('node:child_process');
      const helpInvocation = await resolveClaudeCliInfoInvocation(providerHelpArgs);
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
    try {
      const { execFileSync } = await import('node:child_process');
      const versionInvocation = await resolveClaudeCliInfoInvocation([parsed.versionFlag ?? '--version']);
      const claudeVersion = execFileSync(
        versionInvocation.command,
        versionInvocation.args,
        {
          encoding: 'utf8',
          windowsHide: true,
          ...(versionInvocation.env ? { env: versionInvocation.env } : {}),
          ...(versionInvocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          ...(configuration.vendorCliHelpTimeoutMs > 0 ? { timeout: configuration.vendorCliHelpTimeoutMs } : {}),
        },
      );
      console.log(claudeVersion.trimEnd());
    } catch (error) {
      if (error instanceof ReferenceError) {
        console.log(chalk.yellow(error.message));
        if (readProviderCliOverride('claude')) {
          process.exit(1);
        }
      } else {
        console.log(chalk.yellow('Could not retrieve claude version. Make sure claude is installed.'));
      }
    }
    return;
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

  if (!explicitClaudeSubcommand) {
    const resume = readResumeFlagValue(options.claudeArgs);
    if (resume) {
      const exists = await fetchSessionById({ token: credentials.token, sessionId: resume.value }).catch(() => null);
      if (exists) {
        await handleResumeCommand([resume.value], { terminalRuntime: context.terminalRuntime, rawArgv: context.rawArgv });
        return;
      }
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
        minSettingsVersion: null,
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

async function resolveClaudeCliInfoInvocation(providerArgs: readonly string[]): Promise<{
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
      args: [launch.resolvedPath, ...providerArgs],
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
    args: [...launch.args, ...providerArgs],
    env: process.env,
  });
  return {
    command: invocation.command,
    args: [...invocation.args],
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
}
