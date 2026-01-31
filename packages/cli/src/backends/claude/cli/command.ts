import { execFileSync } from 'node:child_process';

import chalk from 'chalk';
import { z } from 'zod';

import { PERMISSION_MODES, isPermissionMode } from '@/api/types';
import { runClaude, type StartOptions } from '@/backends/claude/runClaude';
import { claudeCliPath } from '@/backends/claude/claudeLocal';
import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient';
import { readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
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
    warn(chalk.yellow(`⚠️  Warning: --settings is used internally by Happy for session tracking.`));
    warn(chalk.yellow(`   Your settings file "${displayedValue}" will be ignored.`));
    warn(chalk.yellow(`   To configure Claude, edit ~/.claude/settings.json instead.`));
  }
  return stripped;
}

export async function handleClaudeCliCommand(context: CommandContext): Promise<void> {
  const args = [...context.args];

  // Support `happy claude ...` while keeping `happy ...` as the default Claude flow.
  if (args.length > 0 && args[0] === 'claude') {
    args.shift();
  }

  const strippedArgs = stripHappyInternalSettingsFlag(args);

  // Parse command line arguments for main command
  const options: StartOptions = {};
  let showHelp = false;
  let showVersion = false;
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
    } else if (arg === '--claude-env') {
      // Parse KEY=VALUE environment variable to pass to Claude
      const envArg = strippedArgs[++i];
      if (envArg && envArg.includes('=')) {
        const eqIndex = envArg.indexOf('=');
        const key = envArg.substring(0, eqIndex);
        const value = envArg.substring(eqIndex + 1);
        options.claudeEnvVars = options.claudeEnvVars || {};
        options.claudeEnvVars[key] = value;
      } else {
        console.error(chalk.red(`Invalid --claude-env format: ${envArg}. Expected KEY=VALUE`));
        process.exit(1);
      }
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

  // Resolve Chrome mode: explicit flag > settings > false
  const settings = await readSettings();
  const chromeEnabled = chromeOverride ?? settings.chromeMode ?? false;
  if (chromeEnabled && !(options.claudeArgs || []).includes('--chrome')) {
    options.claudeArgs = [...(options.claudeArgs || []), '--chrome'];
  }

  if (showHelp) {
    console.log(`
${chalk.bold('happier')} - Claude Code On the Go

${chalk.bold('Usage:')}
\t  happier [options]         Start Claude with mobile control
\t  happier auth              Manage authentication
\t  happier codex             Start Codex mode
\t  happier opencode          Start OpenCode mode (ACP)
\t  happier gemini            Start Gemini mode (ACP)
  happier connect           Connect AI vendor API keys
  happier notify            Send push notification
  happier daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  happier doctor            System diagnostics & troubleshooting

${chalk.bold('Examples:')}
  happier                    Start session
  happier --yolo             Start with bypassing permissions
                              happier sugar for --dangerously-skip-permissions
  happier --chrome           Enable Chrome browser access for this session
  happier --no-chrome        Disable Chrome even if default is on
  happier --js-runtime bun   Use bun instead of node to spawn Claude Code
  happier --claude-env ANTHROPIC_BASE_URL=http://127.0.0.1:3456
                             Use a custom API endpoint (e.g., claude-code-router)
  happier auth login --force Authenticate
  happier doctor             Run diagnostics

${chalk.bold('Happier supports ALL Claude options!')}
  Use any claude flag with happier as you would with claude. Our favorite:

  happier --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`);

    // Run claude --help and display its output
    try {
      const claudeHelp = execFileSync(claudeCliPath, ['--help'], { encoding: 'utf8' });
      console.log(claudeHelp);
    } catch {
      console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'));
    }

    process.exit(0);
  }

  if (showVersion) {
    console.log(`happier version: ${packageJson.version}`);
    // Don't exit - continue to pass --version to Claude Code
  }

  const { credentials } = await authAndSetupMachineIfNeeded();

  // Always auto-start daemon for simplicity
  logger.debug('Ensuring Happier background service is running & matches our version...');

  if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
    logger.debug('Starting Happier background service...');

    // Use the built binary to spawn daemon
    const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    daemonProcess.unref();

    // Give daemon a moment to write PID & port file
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  try {
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
