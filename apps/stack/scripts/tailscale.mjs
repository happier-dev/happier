import './utils/env/env.mjs';
import { join } from 'node:path';
import { readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import { loadDevTargetsConfig } from './utils/dev_targets/config.mjs';
import { resolveObservedDevTargetService } from './utils/dev_targets/service_placement.mjs';
import { resolveRemoteStackStatePaths } from './utils/dev_targets/remote_commands.mjs';
import { runDevTargetCommand } from './utils/dev_targets/executor.mjs';
import { ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { resolveStackServerEndpoint } from './utils/server/urls.mjs';
import { getStackName, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { banner, bullets, cmd as cmdFmt, kv, ok, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green } from './utils/ui/ansi.mjs';
import { TailscaleCommandError } from '@happier-dev/cli-common/tailscale';
import {
  getServeConfig, tailscaleServeHttpsUrlForInternalServerUrl,
  tailscaleServeHttpsUrl, tailscaleServeStatus, tailscaleServeEnable, tailscaleServeReset,
} from './utils/net/tailscale_serve.mjs';

export { resolvePublicServerUrl } from './utils/server/public_server_url.mjs';
export {
  tailscaleServeHttpsUrlForInternalServerUrl, tailscaleServeHttpsUrl, tailscaleServeStatus,
  tailscaleServeEnable, tailscaleServeReset, maybeEnableTailscaleServe, maybeResetTailscaleServe,
} from './utils/net/tailscale_serve.mjs';

/**
 * Manage Tailscale Serve for exposing the local UI/API over HTTPS (secure context).
 *
 * This wraps:
 * - `tailscale serve --bg http://127.0.0.1:3005`
 * - `tailscale serve status`
 * - listener/path-scoped `tailscale serve ... off`
 *
 * Commands:
 * - status
 * - enable
 * - disable (alias: reset)
 * - url (print the HTTPS URL for the current configured upstream)
 */

async function main() {
  const argv = process.argv.slice(2);
  const helpSepIdx = argv.indexOf('--');
  const helpScopeArgv = helpSepIdx === -1 ? argv : argv.slice(0, helpSepIdx);
  const { flags, kv } = parseArgs(helpScopeArgv);
  const positionals = helpScopeArgv.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const cmd = positionals[0] ?? 'help';
  const json = wantsJson(helpScopeArgv, { flags });

  const wantsHelpFlag = wantsHelp(helpScopeArgv, { flags });
  const usageByCmd = new Map([
    ['status', 'hstack tailscale status [--json]'],
    ['enable', 'hstack tailscale enable [--https-port=<n>] [--json]'],
    ['disable', 'hstack tailscale disable [--https-port=<n>] [--json]'],
    ['url', 'hstack tailscale url [--https-port=<n>] [--json]'],
    ['reset', 'hstack tailscale reset [--https-port=<n>] [--json]'],
  ]);

  if (wantsHelpFlag && cmd !== 'help') {
    const usage = usageByCmd.get(cmd);
    if (usage) {
      printResult({
        json,
        data: { ok: true, cmd, usage },
        text: [`[tailscale ${cmd}] usage:`, `  ${usage}`, '', 'see also:', '  hstack tailscale --help'].join('\n'),
      });
      return;
    }
  }

  if (wantsHelpFlag || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['status', 'enable', 'disable', 'reset', 'url'] },
      text: [
        '',
        banner('tailscale', { subtitle: 'Tailscale Serve (HTTPS secure context)' }),
        '',
        sectionTitle('Usage'),
        bullets([
          `${dim('status:')} ${cmdFmt('hstack tailscale status')} ${dim('[--json]')}`,
          `${dim('enable:')} ${cmdFmt('hstack tailscale enable')} ${dim('[--https-port=<n>] [--json]')}`,
          `${dim('disable:')} ${cmdFmt('hstack tailscale disable')} ${dim('[--https-port=<n>] [--json]')}`,
          `${dim('url:')} ${cmdFmt('hstack tailscale url')} ${dim('[--https-port=<n>] [--json]')}`,
        ]),
        '',
        sectionTitle('Notes'),
        bullets([
          `${dim('what it does:')} configures \`tailscale serve\` to proxy your local server (${dim('usually')} ${cyan('http://127.0.0.1:3005')}) over HTTPS`,
          `${dim('env:')} set ${cyan('HAPPIER_STACK_TAILSCALE_SERVE=1')} to allow stack runs to auto-enable serve (best-effort)`,
          `${dim('sandbox:')} enable/disable are blocked unless ${cyan('HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1')}`,
        ]),
        '',
        sectionTitle('Legacy / advanced'),
        bullets([
          `${dim('low-level:')} ${dim('node scripts/tailscale.mjs enable --upstream=<url> --path=/ [--https-port=<n>] [--json]')}`,
        ]),
      ].join('\n'),
    });
    return;
  }

  const stackName = getStackName(process.env);
  const { baseDir, envPath: retainedEnvPath } = resolveStackEnvPath(stackName, process.env);
  const envPath = process.env.HAPPIER_STACK_ENV_FILE || retainedEnvPath;
  if (process.env.HAPPIER_DEV_TARGET_EXECUTION !== '1') {
    const runtimeState = await readStackRuntimeStateFile(
      process.env.HAPPIER_STACK_RUNTIME_STATE_PATH || join(baseDir, 'stack.runtime.json'));
    const { config } = await loadDevTargetsConfig({ stackName });
    const placed = resolveObservedDevTargetService({ config, runtimeState, service: 'server' });
    if (placed) {
      if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
        throw new Error('[tailscale] remote commands are disabled in sandbox mode. Set HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1 to allow them.');
      }
      const paths = resolveRemoteStackStatePaths(placed.target, { stackName, runtimeMode: placed.runtimeMode });
      const output = [];
      const result = await runDevTargetCommand({
        target: placed.target, stackBaseDir: baseDir,
        commandArgs: ['node', 'apps/stack/scripts/stack.mjs', `tailscale:${cmd}`, paths.stackName, ...argv.slice(1).filter(arg => arg !== '--json'), '--json'],
        environment: {
          HAPPIER_DEV_TARGET_EXECUTION: '1',
          HAPPIER_STACK_REPO_DIR: placed.target.repoDir,
          HAPPIER_STACK_HOME_DIR: placed.target.cliHomeDir,
          HAPPIER_STACK_STORAGE_DIR: paths.stackStorageDir,
          ...(process.env.HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL
            ? { HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: process.env.HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL } : {}),
        },
        silent: true,
        onLine: ({ stream, line }) => {
          if (stream === 'stdout') output.push(line);
          else process.stderr.write(line + '\n');
        },
      });
      const text = output.join('\n');
      if (!text.trim()) {
        process.exitCode = result.code || 1;
        return;
      }
      const data = JSON.parse(text);
      if (result.code === 0 && cmd === 'enable' && data.httpsUrl) {
        await ensureEnvFileUpdated({ envPath,
          updates: [{ key: 'HAPPIER_PUBLIC_SERVER_URL', value: data.httpsUrl }] });
      }
      printResult({ json, data,
        text: cmd === 'url' ? data.url : cmd === 'status' ? data.status
          : data.failure ? data.failure.remediation || data.failure.code
          : `[tailscale ${cmd}] ${stackName}: ${data.httpsUrl || data.enableUrl || 'ok'}` });
      process.exitCode = result.code;
      return;
    }
  }

  const { internalServerUrl } = await resolveStackServerEndpoint();
  if (flags.has('--upstream') || kv.get('--upstream')) {
    process.env.HAPPIER_STACK_TAILSCALE_UPSTREAM = kv.get('--upstream') ?? internalServerUrl;
  }
  if (flags.has('--path') || kv.get('--path')) {
    process.env.HAPPIER_STACK_TAILSCALE_SERVE_PATH = kv.get('--path') ?? '/';
  }
  const serveOptions = {
    internalServerUrl,
    ...(kv.has('--https-port') ? { httpsPort: Number(kv.get('--https-port')) } : {}),
  };

  switch (cmd) {
    case 'status': {
      const status = await tailscaleServeStatus();
      if (json) {
        printResult({
          json,
          data: { status, httpsUrl: await tailscaleServeHttpsUrl({ internalServerUrl }) },
        });
      } else {
        process.stdout.write(status);
      }
      return;
    }
    case 'url': {
      const url = await tailscaleServeHttpsUrl(serveOptions);
      if (!url) {
        throw new Error('[tailscale] no https:// URL found in `tailscale serve status` output');
      }
      printResult({ json, data: { url }, text: url });
      return;
    }
    case 'enable': {
      if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
        throw new Error(
          '[tailscale] enable is disabled in sandbox mode.\n' +
            'Reason: Tailscale Serve is global machine state.\n' +
            'If you really want this, set: HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1'
        );
      }
      const stackName = getStackName(process.env);
      const envPath = (process.env.HAPPIER_STACK_ENV_FILE ?? '').toString().trim() || resolveStackEnvPath(stackName, process.env).envPath;
      const { upstream } = getServeConfig(internalServerUrl);
      const res = await tailscaleServeEnable(serveOptions);
      if (res?.enableUrl && !res?.httpsUrl) {
        printResult({
          json,
          data: { ok: true, httpsUrl: null, enableUrl: res.enableUrl },
          text:
            `${green('✓')} tailscale serve needs one-time approval in your tailnet.\n` +
            `${dim('stack:')} ${stackName}\n` +
            `${dim('upstream:')} ${upstream}\n` +
            `${dim('env:')} ${envPath}\n` +
            `${dim('Open:')} ${cyan(res.enableUrl)}`,
        });
        return;
      }
      printResult({
        json,
        data: { ok: true, httpsUrl: res.httpsUrl ?? null },
        text: res.httpsUrl
          ? `${green('✓')} tailscale serve enabled: ${cyan(res.httpsUrl)}\n` +
            `${dim('stack:')} ${stackName}\n` +
            `${dim('upstream:')} ${upstream}\n` +
            `${dim('env:')} ${envPath}`
          : `${green('✓')} tailscale serve enabled\n` +
            `${dim('stack:')} ${stackName}\n` +
            `${dim('upstream:')} ${upstream}\n` +
            `${dim('env:')} ${envPath}`,
      });
      return;
    }
    case 'disable':
    case 'reset': {
      if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
        throw new Error(
          '[tailscale] disable/reset is disabled in sandbox mode.\n' +
            'Reason: Tailscale Serve is global machine state.\n' +
            'If you really want this, set: HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1'
        );
      }
      await tailscaleServeReset(serveOptions);
      printResult({ json, data: { ok: true }, text: `${green('✓')} tailscale serve reset` });
      return;
    }
    default:
      throw new Error(`[tailscale] unknown command: ${cmd}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    if (err instanceof TailscaleCommandError && err.failure) {
      printResult({ json: wantsJson(process.argv.slice(2)), data: { ok: false, failure: err.failure },
        text: `[tailscale] failed: ${err.message}` });
    } else console.error('[tailscale] failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
