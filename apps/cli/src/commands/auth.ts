import chalk from 'chalk';
import { readCredentials, clearCredentials, readSettings, updateSettings, clearDaemonState, clearMachineId } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stopDaemon, checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import os from 'node:os';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { stopAllDaemonsBestEffort } from '@/daemon/multiDaemon';

export async function handleAuthCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAuthHelp();
    return;
  }

  switch (subcommand) {
    case 'login':
      await handleAuthLogin(args.slice(1));
      break;
    case 'logout':
      await handleAuthLogout(args.slice(1));
      break;
    case 'status':
      await handleAuthStatus();
      break;
    default:
      console.error(chalk.red(`Unknown auth subcommand: ${subcommand}`));
      showAuthHelp();
      process.exit(1);
  }
}

function showAuthHelp(): void {
  console.log(`
${chalk.bold('happier auth')} - Authentication management

${chalk.bold('Usage:')}
  happier auth login [--no-open] [--force] [--method web|mobile] [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]    Authenticate with Happier
  happier auth logout [--all]     Log out (active server by default)
  happier auth status             Show authentication status
  happier auth help               Show this help message

${chalk.bold('Options:')}
  --no-open  Do not attempt to open a browser (prints URL instead)
  --force    Clear credentials, machine ID, and stop daemon before re-auth
  --method   Force authentication method (web|mobile). Useful for headless/non-TTY.
  --all      When used with logout, remove local data for all servers
  --server      Use an existing saved server profile
  --server-url  Use a specific server URL (defaults to persisting as a new profile)
  --webapp-url  Override web app URL for this server profile
  --persist     Persist --server-url as the active server profile (default)
  --no-persist  Use --server-url for this invocation only

${chalk.gray('PS: Your master secret never leaves your mobile/web device. Each CLI machine')}
${chalk.gray('receives only a derived key for per-machine encryption, so backup codes')}
${chalk.gray('cannot be displayed from the CLI.')}
`);
}

function resolveAuthMethodFlag(args: string[]): 'web' | 'mobile' | null {
  const idx = args.findIndex((a) => a === '--method');
  if (idx !== -1) {
    const value = (args[idx + 1] ?? '').toString().trim().toLowerCase();
    if (!value) throw new Error('Missing value for --method (expected: web|mobile)');
    if (value === 'web' || value === 'mobile') return value;
    throw new Error(`Invalid --method value: ${value} (expected: web|mobile)`);
  }

  const withEq = args.find((a) => a.startsWith('--method='));
  if (withEq) {
    const value = withEq.slice('--method='.length).trim().toLowerCase();
    if (!value) throw new Error('Missing value for --method (expected: web|mobile)');
    if (value === 'web' || value === 'mobile') return value;
    throw new Error(`Invalid --method value: ${value} (expected: web|mobile)`);
  }

  return null;
}

async function handleAuthLogin(args: string[]): Promise<void> {
  args = await applyServerSelectionFromArgs(args);

  const forceAuth = args.includes('--force') || args.includes('-f');
  const noOpen = args.includes('--no-open') || args.includes('--no-browser') || args.includes('--no-browser-open');
  let method: 'web' | 'mobile' | null = null;
  try {
    method = resolveAuthMethodFlag(args);
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : 'Invalid --method flag'));
    process.exit(1);
  }
  if (method) process.env.HAPPIER_AUTH_METHOD = method;

  if (noOpen) {
    // Used by the auth UI layer to skip automatic browser open attempts.
    process.env.HAPPIER_NO_BROWSER_OPEN = '1';
  }

  if (forceAuth) {
    // As per user's request: "--force-auth will clear credentials, clear machine ID, stop daemon"
    console.log(chalk.yellow('Force authentication requested.'));
    console.log(chalk.gray('This will:'));
    console.log(chalk.gray('  • Clear existing credentials'));
    console.log(chalk.gray('  • Clear machine ID'));
    console.log(chalk.gray('  • Stop daemon if running'));
    console.log(chalk.gray('  • Re-authenticate and register machine\n'));

    // Stop daemon if running
    try {
      logger.debug('Stopping daemon for force auth...');
      await stopDaemon();
      console.log(chalk.gray('✓ Stopped daemon'));
    } catch (error) {
      logger.debug('Daemon was not running or failed to stop:', error);
    }

    // Clear credentials
    await clearCredentials();
    console.log(chalk.gray('✓ Cleared credentials'));

    // Clear machine ID
    await clearMachineId();
    console.log(chalk.gray('✓ Cleared machine ID'));

    console.log('');
  }

  // Check if already authenticated (if not forcing)
  if (!forceAuth) {
    const existingCreds = await readCredentials();
    const settings = await readSettings();

    if (existingCreds && settings?.machineId) {
      console.log(chalk.green('✓ Already authenticated'));
      console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
      console.log(chalk.gray(`  Host: ${os.hostname()}`));
      console.log(chalk.gray(`  Use 'happier auth login --force' to re-authenticate`));
      return;
    } else if (existingCreds && !settings?.machineId) {
      console.log(chalk.yellow('⚠️  Credentials exist but machine ID is missing'));
      console.log(chalk.gray('  This can happen if --auth flag was used previously'));
      console.log(chalk.gray('  Fixing by setting up machine...\n'));
    }
  }

  // Perform authentication and machine setup
  // "Finally we'll run the auth and setup machine if needed"
  try {
    const result = await authAndSetupMachineIfNeeded();
    console.log(chalk.green('\n✓ Authentication successful'));
    console.log(chalk.gray(`  Machine ID: ${result.machineId}`));
  } catch (error) {
    console.error(chalk.red('Authentication failed:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

async function handleAuthLogout(args: string[]): Promise<void> {
  const logoutAll = args.includes('--all');
  const happyDir = configuration.happyHomeDir;
  const targetServerId = configuration.activeServerId;

  // Check if authenticated
  if (!logoutAll) {
    const credentials = await readCredentials();
    if (!credentials) {
      console.log(chalk.yellow('Not currently authenticated'));
      return;
    }
  }

  if (logoutAll) {
    console.log(chalk.blue('This will log you out of Happier on all servers and remove local data'));
  } else {
    console.log(chalk.blue(`This will log you out of Happier for server: ${targetServerId}`));
  }
  console.log(chalk.yellow('⚠️  You will need to re-authenticate to use Happier again'));

  // Ask for confirmation
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(
      chalk.yellow(logoutAll ? 'Are you sure you want to log out everywhere and delete local data? (y/N): ' : 'Are you sure you want to log out? (y/N): '),
      resolve,
    );
  });

  rl.close();

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    try {
      if (logoutAll) {
        try {
          await stopAllDaemonsBestEffort();
        } catch {
          // best-effort
        }
        if (existsSync(happyDir)) {
          rmSync(happyDir, { recursive: true, force: true });
        }
      } else {
        // Stop daemon for this server (best-effort).
        try {
          await stopDaemon();
          console.log(chalk.gray('Stopped daemon'));
        } catch {
          // ignore
        }

        // Clear credentials for this server only.
        await clearCredentials();

        // Clear daemon state/lock for this server only.
        await clearDaemonState().catch(() => {});

        // Clear machine IDs and reconnect cursors for this server only (multi-server safe).
        await updateSettings((settings) => {
          const nextMachineIds = { ...(settings.machineIdByServerId ?? {}) };
          const nextMachineConfirmed = { ...(settings.machineIdConfirmedByServerByServerId ?? {}) };
          const nextCursors = { ...(settings.lastChangesCursorByServerIdByAccountId ?? {}) };

          if (targetServerId in nextMachineIds) delete nextMachineIds[targetServerId];
          if (targetServerId in nextMachineConfirmed) delete nextMachineConfirmed[targetServerId];
          if (targetServerId in nextCursors) delete nextCursors[targetServerId];

          return {
            ...settings,
            machineIdByServerId: Object.keys(nextMachineIds).length ? nextMachineIds : {},
            machineIdConfirmedByServerByServerId: Object.keys(nextMachineConfirmed).length ? nextMachineConfirmed : {},
            lastChangesCursorByServerIdByAccountId: Object.keys(nextCursors).length ? nextCursors : {},
          };
        });
      }

      console.log(chalk.green('✓ Successfully logged out'));
      console.log(chalk.gray('  Run "happier auth login" to authenticate again'));
    } catch (error) {
      throw new Error(`Failed to logout: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    console.log(chalk.blue('Logout cancelled'));
  }
}

async function handleAuthStatus(): Promise<void> {
  const credentials = await readCredentials();
  const settings = await readSettings();

  console.log(chalk.bold('\nAuthentication Status\n'));

  if (!credentials) {
    console.log(chalk.red('✗ Not authenticated'));
    console.log(chalk.gray('  Run "happier auth login" to authenticate'));
    return;
  }

  console.log(chalk.green('✓ Authenticated'));

  // Token preview (first few chars for security)
  const tokenPreview = credentials.token.substring(0, 30) + '...';
  console.log(chalk.gray(`  Token: ${tokenPreview}`));

  // Machine status
  if (settings?.machineId) {
    console.log(chalk.green('✓ Machine registered'));
    console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
    console.log(chalk.gray(`  Host: ${os.hostname()}`));
  } else {
    console.log(chalk.yellow('⚠️  Machine not registered'));
    console.log(chalk.gray('  Run "happier auth login --force" to fix this'));
  }

  // Data location
  console.log(chalk.gray(`\n  Data directory: ${configuration.happyHomeDir}`));

  // Daemon status
  try {
    const running = await checkIfDaemonRunningAndCleanupStaleState();
    if (running) {
      console.log(chalk.green('✓ Daemon running'));
    } else {
      console.log(chalk.gray('✗ Daemon not running'));
    }
  } catch {
    console.log(chalk.gray('✗ Daemon not running'));
  }
}
