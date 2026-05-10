import chalk from 'chalk';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { AGENTS_CORE } from '@happier-dev/agents';

import {
  type StartOptions,
} from '@/backends/claude/runtime/claudeSessionRuntimeOptions';
import { normalizeStartingMode } from '@/agent/runtime/session/loop/resolveStartingMode';
import { isClaudeCliJavaScriptFile } from '@/backends/claude/utils/resolveClaudeCliPath';
import { readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { readCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { buildRootHelpText } from '@/cli/buildRootHelpText';
import { requireJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/requireJavaScriptRuntimeExecutable';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';
import { readProviderCliOverride } from '@/packagedRuntime/managedTools/providerCliResolution';
import { isBun } from '@/utils/runtime';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { handleResumeCommand } from '@/cli/commands/resume';
import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';
import packageJson from '../../../../package.json';

import type { CommandContext } from '@/cli/commandRegistry';
import { readOptionalFlagValue, readOptionalFlagValueFromAliases } from '@/cli/sessionStartArgs';

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

function expandEqualsFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of args) {
    if (raw.startsWith('--profile=')) {
      out.push('--profile', raw.slice('--profile='.length));
      continue;
    }
    if (raw.startsWith('--permission-mode=')) {
      out.push('--permission-mode', raw.slice('--permission-mode='.length));
      continue;
    }
    if (raw.startsWith('--model=')) {
      out.push('--model', raw.slice('--model='.length));
      continue;
    }
    out.push(raw);
  }
  return out;
}

function resolveClaudeSessionRuntimeExtras(args: readonly string[]): Pick<StartOptions, 'claudeArgs' | 'jsRuntime'> {
  return resolveClaudeSessionRuntimeExtrasInternal(args, { passThroughResume: false });
}

function resolveClaudeSessionRuntimeExtrasInternal(
  args: readonly string[],
  opts: Readonly<{ passThroughResume: boolean }>,
): Pick<StartOptions, 'claudeArgs' | 'jsRuntime'> {
  const strippedArgs = Array.isArray(args) ? args : [];

  let jsRuntime: 'node' | 'bun' | undefined = undefined;
  const claudeArgs: string[] = [];

  for (let i = 0; i < strippedArgs.length; i += 1) {
    const arg = strippedArgs[i];

    if (arg === '--js-runtime') {
      const raw = strippedArgs[i + 1];
      i += 1;
      if (raw === 'node' || raw === 'bun') {
        jsRuntime = raw;
      }
      continue;
    }

    // Claude-specific passthrough shorthand.
    if (arg === '--yolo') {
      claudeArgs.push('--dangerously-skip-permissions');
      continue;
    }

    // Do not pass Happier-owned flags down to Claude Code.
    if (
      arg === '--refresh-settings'
      || arg === '--profile'
      || arg.startsWith('--profile=')
      || arg === '--permission-mode'
      || arg.startsWith('--permission-mode=')
      || arg === '--permission-mode-updated-at'
      || arg === '--account-settings-version-hint'
      || arg === '--existing-session'
      || arg === '--happy-starting-mode'
      || arg === '--started-by'
      || (!opts.passThroughResume && (arg === '--resume' || arg === '-r'))
    ) {
      // Skip paired values for flags that take an argument.
      if (
        arg === '--profile'
        || arg === '--permission-mode'
        || arg === '--permission-mode-updated-at'
        || arg === '--account-settings-version-hint'
        || arg === '--existing-session'
        || arg === '--happy-starting-mode'
        || arg === '--started-by'
        || (!opts.passThroughResume && (arg === '--resume' || arg === '-r'))
      ) {
        i += 1;
      }
      continue;
    }

    // Preserve model passthrough for Claude Code.
    if (arg === '--model') {
      claudeArgs.push(arg);
      const raw = strippedArgs[i + 1];
      if (typeof raw === 'string' && raw.trim().length > 0) {
        claudeArgs.push(raw);
        i += 1;
      }
      continue;
    }

    // Keep all other args for Claude Code (and best-effort pair values).
    claudeArgs.push(arg);
    const next = strippedArgs[i + 1];
    if (typeof next === 'string' && !next.startsWith('-')) {
      claudeArgs.push(next);
      i += 1;
    }
  }

  return {
    ...(claudeArgs.length > 0 ? { claudeArgs } : {}),
    ...(jsRuntime ? { jsRuntime } : {}),
  };
}

function removeResumeFlagsForExplicitClaudeInvocation(args: readonly string[]): string[] {
  const stripped: string[] = [];
  const list = Array.isArray(args) ? args : [];

  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--resume' || arg === '-r') {
      const next = list[i + 1];
      if (typeof next === 'string' && !next.startsWith('-')) {
        i += 1;
      }
      continue;
    }
    stripped.push(arg);
  }

  return stripped;
}

export async function handleClaudeCliCommand(context: CommandContext): Promise<void> {
  const args = [...context.args];

  // Support `happier claude ...` while keeping `happier ...` as the default Claude flow.
  const explicitClaudeSubcommand = args.length > 0 && args[0] === 'claude';
  if (explicitClaudeSubcommand) {
    args.shift();
  }

  const strippedArgs = expandEqualsFlags(stripHappyInternalSettingsFlag(args));

  let showHelp = false;
  let showVersion = false;
  let chromeOverride: boolean | undefined = undefined;

  for (let i = 0; i < strippedArgs.length; i += 1) {
    const arg = strippedArgs[i];
    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      showVersion = true;
      continue;
    }
    if (arg === '--chrome') {
      chromeOverride = true;
      continue;
    }
    if (arg === '--no-chrome') {
      chromeOverride = false;
      continue;
    }
  }

  const versionOnlyInvocation =
    showVersion &&
    strippedArgs.length > 0 &&
    strippedArgs.every((arg) => arg === '-v' || arg === '--version');

  if (versionOnlyInvocation) {
    console.log(`happier version: ${packageJson.version}`);
    return;
  }

  // Resolve Chrome mode: explicit flag > settings > false
  const settings = await readSettings();
  const chromeEnabled = chromeOverride ?? settings.chromeMode ?? false;
  const baseExtras = explicitClaudeSubcommand
    ? resolveClaudeSessionRuntimeExtrasInternal(strippedArgs, { passThroughResume: true })
    : resolveClaudeSessionRuntimeExtrasInternal(strippedArgs, { passThroughResume: false });
  const claudeArgsWithChrome = chromeEnabled && !(baseExtras.claudeArgs ?? []).includes('--chrome')
    ? [...(baseExtras.claudeArgs ?? []), '--chrome']
    : (baseExtras.claudeArgs ?? []);

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
    // For mixed invocations, continue and pass --version through to Claude Code.
  }

  if (!explicitClaudeSubcommand) {
    const resume = readResumeFlagValue(strippedArgs);
    if (resume) {
      // Best-effort: if this looks like a Happier session id, delegate to `happier resume <id>` before
      // routing through the generic session command path.
      let credentials = await readCredentials();
      if (!credentials) {
        const auth = await authAndSetupMachineIfNeeded();
        credentials = auth.credentials;
      }

      const exists = await fetchSessionById({ token: credentials.token, sessionId: resume.value }).catch(() => null);
      if (exists) {
        await handleResumeCommand([resume.value], { terminalRuntime: context.terminalRuntime, rawArgv: context.rawArgv });
        return;
      }
    }
  }

  try {
    const argsForSharedCommand = explicitClaudeSubcommand
      ? removeResumeFlagsForExplicitClaudeInvocation(strippedArgs)
      : strippedArgs;

    await runBackendSessionCliCommand({
      // The shared session command parser expects `context.args[0]` to be a command token
      // (e.g. `codex`, `claude`) so it can safely skip it when scanning for flags.
      context: { ...context, args: ['claude', ...argsForSharedCommand] },
      backendIdForSessionRuntime: 'claude',
      agentIdForDeprecatedAliases: AGENTS_CORE.claude.id,
      agentIdForAccountSettings: AGENTS_CORE.claude.id,
      resolveExtraOptions: (args) => {
        const startingModeRaw = readOptionalFlagValue(args, '--happy-starting-mode');
        const startingMode = normalizeStartingMode(startingModeRaw) ?? undefined;
        if (startingModeRaw && typeof startingMode === 'undefined') {
          console.error(chalk.red(`Invalid --happy-starting-mode: ${startingModeRaw}. Use "terminal" or "remote".`));
          process.exit(1);
        }

        const directoryRaw = readOptionalFlagValueFromAliases(args, ['-C', '--cd']);
        const directory = typeof directoryRaw === 'string' && directoryRaw.trim().length > 0
          ? directoryRaw.trim()
          : undefined;

        return {
          ...(claudeArgsWithChrome.length > 0 ? { claudeArgs: claudeArgsWithChrome } : {}),
          ...(baseExtras.jsRuntime ? { jsRuntime: baseExtras.jsRuntime } : {}),
          ...(startingMode ? { startingMode } : {}),
          ...(directory ? { directory } : {}),
        };
      },
    });
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
