import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { findExistingStackCredentialPath } from '../utils/auth/credentials_paths.mjs';
import { parseArgs } from '../utils/cli/args.mjs';
import { printResult, wantsHelp } from '../utils/cli/cli.mjs';
import { isTty, promptSelect, withRl } from '../utils/cli/wizard.mjs';
import { daemonStatusSummary, startLocalDaemonWithAuth, stopLocalDaemon } from '../daemon.mjs';
import { getComponentDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { run } from '../utils/proc/proc.mjs';
import { resolveServerPortFromEnv, resolveServerUrls } from '../utils/server/urls.mjs';
import { parseCliIdentityOrThrow, resolveCliHomeDirForIdentity } from '../utils/stack/cli_identities.mjs';
import { readStackRuntimeStateFile, isPidAlive } from '../utils/stack/runtime_state.mjs';
import { withStackEnv } from './stack_environment.mjs';
import { banner, cmd as cmdFmt, sectionTitle } from '../utils/ui/layout.mjs';
import { cyan, green } from '../utils/ui/ansi.mjs';

export async function runStackDaemonCommand({ rootDir, stackName, argv, json }) {
  const { flags, kv } = parseArgs(argv);
  const wantsHelpFlag = wantsHelp(argv, { flags });

  const positionals = argv.filter((a) => a && a !== '--' && !a.startsWith('--'));
  const action = (positionals[0] ?? 'status').toString().trim();
  const identity = parseCliIdentityOrThrow((kv.get('--identity') ?? '').trim());
  const noOpen = flags.has('--no-open') || flags.has('--no-browser') || flags.has('--no-browser-open');

  if (wantsHelpFlag || !action || action === 'help') {
    printResult({
      json,
      data: { ok: true, stackName, commands: ['start', 'stop', 'restart', 'status'], flags: ['--identity=<name>'] },
      text: [
        banner('stack daemon', { subtitle: `Manage the happier-cli daemon for stack ${cyan(stackName || 'main')}.` }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('hstack stack daemon')} <name> status [--identity=<name>] [--json]`,
        `  ${cyan('hstack stack daemon')} <name> start [--identity=<name>] [--json]`,
        `  ${cyan('hstack stack daemon')} <name> stop [--identity=<name>] [--json]`,
        `  ${cyan('hstack stack daemon')} <name> restart [--identity=<name>] [--json]`,
        '',
        sectionTitle('example:'),
        `  ${cmdFmt(`hstack stack daemon ${stackName || 'main'} restart`)}`,
        `  ${cmdFmt(`hstack stack daemon ${stackName || 'main'} start --identity=account-b`)}`,
      ].join('\n'),
    });
    return;
  }

  if (!['start', 'stop', 'restart', 'status'].includes(action)) {
    printResult({
      json,
      data: { ok: false, error: 'invalid_daemon_subcommand', stackName, action },
      text: [
        `[stack] invalid daemon subcommand: ${action}`,
        '',
        'usage:',
        '  hstack stack daemon <name> start|stop|restart|status [--json]',
      ].join('\n'),
    });
    process.exit(1);
  }

  const res = await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      const cliDir = getComponentDir(rootDir, 'happier-cli', env);
      const cliBin = join(cliDir, 'bin', 'happier.mjs');
      const baseCliHomeDir = (env.HAPPIER_STACK_CLI_HOME_DIR ?? join(resolveStackEnvPath(stackName).baseDir, 'cli')).toString();
      const cliHomeDir = resolveCliHomeDirForIdentity({ cliHomeDir: baseCliHomeDir, identity });

      // Stack env files don't always include a server port; for running stacks, prefer runtime state.
      // This avoids accidentally targeting the main stack default (3005) for stacks on other ports.
      let runtimePort = null;
      const runtimePath = (env.HAPPIER_STACK_RUNTIME_STATE_PATH ?? '').toString().trim();
      if (runtimePath) {
        const state = await readStackRuntimeStateFile(runtimePath).catch(() => null);
        const candidate = Number(state?.ports?.server);
        const serverPid = Number(state?.processes?.serverPid);
        if (Number.isFinite(candidate) && candidate > 0 && isPidAlive(serverPid)) {
          runtimePort = candidate;
        }
      }

      const serverPort = runtimePort ?? resolveServerPortFromEnv({ env, defaultPort: 3005 });
      const urls = await resolveServerUrls({ env, serverPort, allowEnable: false });
      const internalServerUrl = urls.internalServerUrl;
      const publicServerUrl = urls.publicServerUrl;
      const envForIdentity = {
        ...env,
        HAPPIER_STACK_CLI_IDENTITY: identity,
        ...(identity !== 'default'
          ? {
              HAPPIER_STACK_MIGRATE_CREDENTIALS: '0',
              HAPPIER_STACK_AUTO_AUTH_SEED: '0',
            }
          : {}),
      };
      await mkdir(cliHomeDir, { recursive: true }).catch(() => {});

      if (action === 'start' || action === 'restart') {
        // UX: if this identity is not authenticated yet and we're in a real TTY, offer to run the
        // guided login flow inline (instead of failing or asking for a second terminal).
        //
        // Important: never prompt in --json mode (automation must not hang).
        const hasCreds = Boolean(findExistingStackCredentialPath({
          cliHomeDir,
          serverUrl: internalServerUrl,
          env: envForIdentity,
        }));

        if (!hasCreds) {
          if (json) {
            const loginCmd = `hstack stack auth ${stackName} login${identity !== 'default' ? ` --identity=${identity} --no-open` : ''}`;
            return { ok: false, action, error: 'auth_required', cliIdentity: identity, cliHomeDir, loginCmd };
          }

          if (isTty()) {
            const choice = await withRl(async (rl) => {
              return await promptSelect(rl, {
                title:
                  `Daemon identity "${identity}" is not authenticated yet.\n` +
                  `Authenticate now? (recommended)\n`,
                options: [
                  { label: 'yes (run guided login now)', value: 'yes' },
                  { label: 'no (show command and exit)', value: 'no' },
                ],
                defaultIndex: 0,
              });
            });

            if (choice === 'yes') {
              const authArgs = [
                'login',
                ...(identity !== 'default' ? [`--identity=${identity}`] : []),
                ...(identity !== 'default' || noOpen ? ['--no-open'] : []),
              ];
              await run(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), ...authArgs], {
                cwd: rootDir,
                env: envForIdentity,
                stdio: 'inherit',
              });
            } else {
              const loginCmd = `hstack stack auth ${stackName} login${identity !== 'default' ? ` --identity=${identity} --no-open` : ''}`;
              throw new Error(`[stack] daemon auth required. Run:\n${loginCmd}`);
            }
          }
        }

        await startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: action === 'restart',
          env: envForIdentity,
          stackName,
          cliIdentity: identity,
        });
        const status = await daemonStatusSummary({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          env: envForIdentity,
          stackName,
          cliIdentity: identity,
        });
        return { ok: true, action, cliIdentity: identity, cliHomeDir, status: status.trim() };
      }

      if (action === 'stop') {
        await stopLocalDaemon({
          cliBin,
          internalServerUrl,
          publicServerUrl,
          cliHomeDir,
          env: envForIdentity,
          stackName,
          cliIdentity: identity,
        });
        const status = await daemonStatusSummary({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          env: envForIdentity,
          stackName,
          cliIdentity: identity,
        }).catch(() => '');
        return { ok: true, action, cliIdentity: identity, cliHomeDir, status: status.trim() || null };
      }

      const status = await daemonStatusSummary({
        cliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        env: envForIdentity,
        stackName,
        cliIdentity: identity,
      });
      return { ok: true, action, cliIdentity: identity, cliHomeDir, status: status.trim() };
    },
  });

  if (json) {
    printResult({ json, data: { stackName, ...res } });
    return;
  }

  if (res?.status) {
    console.log('');
    console.log(sectionTitle('Daemon'));
    console.log(res.status);
    return;
  }

  console.log(`${green('✓')} daemon command completed`);
}
