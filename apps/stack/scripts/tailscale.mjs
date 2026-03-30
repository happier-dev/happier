import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { run } from './utils/proc/proc.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { getInternalServerUrl } from './utils/server/urls.mjs';
import { getStackName, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { banner, bullets, cmd as cmdFmt, kv, ok, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green } from './utils/ui/ansi.mjs';
import {
  extractTailscaleServeHttpsUrl,
  runTailscaleServeEnable as runSharedTailscaleServeEnable,
  runTailscaleServeReset as runSharedTailscaleServeReset,
  runTailscaleServeStatus as runSharedTailscaleServeStatus,
  tailscaleServeHttpsUrlForInternalServerUrlFromStatus,
} from '@happier-dev/cli-common/tailscale';

/**
 * Manage Tailscale Serve for exposing the local UI/API over HTTPS (secure context).
 *
 * This wraps:
 * - `tailscale serve --bg http://127.0.0.1:3005`
 * - `tailscale serve status`
 * - `tailscale serve reset`
 *
 * Commands:
 * - status
 * - enable
 * - disable (alias: reset)
 * - url (print the first https:// URL from status output)
 */

function getServeConfig(internalServerUrl) {
  const upstream = process.env.HAPPIER_STACK_TAILSCALE_UPSTREAM?.trim()
    ? process.env.HAPPIER_STACK_TAILSCALE_UPSTREAM.trim()
    : internalServerUrl;
  const servePath = process.env.HAPPIER_STACK_TAILSCALE_SERVE_PATH?.trim()
    ? process.env.HAPPIER_STACK_TAILSCALE_SERVE_PATH.trim()
    : '/';
  return { upstream, servePath };
}

export async function tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl) {
  try {
    const status = await tailscaleServeStatus();
    return tailscaleServeHttpsUrlForInternalServerUrlFromStatus(status, internalServerUrl);
  } catch {
    return null;
  }
}

function assertTailscaleAllowed(action) {
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    throw new Error(
      `[local] tailscale ${action} is disabled in sandbox mode.\n` +
        `Reason: Tailscale Serve is global machine state and sandbox runs must be isolated.\n` +
        `If you really want this, set: HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1`
    );
  }
}

function parseTimeoutMs(raw, defaultMs) {
  const s = (raw ?? '').trim();
  if (!s) return defaultMs;
  const n = Number(s);
  // Allow 0 to disable timeouts for user-triggered commands.
  if (!Number.isFinite(n)) return defaultMs;
  return n > 0 ? n : 0;
}

function tailscaleProbeTimeoutMs() {
  return parseTimeoutMs(process.env.HAPPIER_STACK_TAILSCALE_CMD_TIMEOUT_MS, 2500);
}

function tailscaleUserEnableTimeoutMs() {
  return parseTimeoutMs(process.env.HAPPIER_STACK_TAILSCALE_ENABLE_TIMEOUT_MS, 30000);
}

function tailscaleAutoEnableTimeoutMs() {
  return parseTimeoutMs(process.env.HAPPIER_STACK_TAILSCALE_ENABLE_TIMEOUT_MS_AUTO, tailscaleProbeTimeoutMs());
}

function tailscaleUserResetTimeoutMs() {
  return parseTimeoutMs(process.env.HAPPIER_STACK_TAILSCALE_RESET_TIMEOUT_MS, 15000);
}

export async function tailscaleServeHttpsUrl({ internalServerUrl } = {}) {
  try {
    const status = await tailscaleServeStatus();
    const comparableInternalServerUrl =
      String(internalServerUrl ?? '').trim() ||
      getInternalServerUrl({ env: process.env, defaultPort: 3005 }).internalServerUrl;
    return (
      tailscaleServeHttpsUrlForInternalServerUrlFromStatus(status, comparableInternalServerUrl) ??
      extractTailscaleServeHttpsUrl(status)
    );
  } catch {
    return null;
  }
}

export async function tailscaleServeStatus() {
  assertTailscaleAllowed('status');
  return await runSharedTailscaleServeStatus({
    env: process.env,
    timeoutMs: tailscaleProbeTimeoutMs(),
  });
}

export async function tailscaleServeEnable({ internalServerUrl, timeoutMs } = {}) {
  assertTailscaleAllowed('enable');
  const { upstream, servePath } = getServeConfig(internalServerUrl);
  const result = await runSharedTailscaleServeEnable({
    env: process.env,
    servePath,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : tailscaleUserEnableTimeoutMs(),
    upstreamUrl: upstream,
  });

  if (result.approvalUrl) {
    try {
      await run('open', [result.approvalUrl]);
    } catch {
      // ignore (headless / restricted environment)
    }
  }

  return {
    enableUrl: result.approvalUrl,
    httpsUrl: result.httpsUrl,
    status: result.rawStatus,
  };
}

export async function tailscaleServeReset({ timeoutMs } = {}) {
  assertTailscaleAllowed('reset');
  await runSharedTailscaleServeReset({
    env: process.env,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : tailscaleUserResetTimeoutMs(),
  });
}

export async function maybeEnableTailscaleServe({ internalServerUrl }) {
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    return null;
  }
  const enabled = (process.env.HAPPIER_STACK_TAILSCALE_SERVE ?? '0') === '1';
  if (!enabled) {
    return null;
  }
  try {
    // This is called from automation; it must not hang for long.
    return await tailscaleServeEnable({ internalServerUrl, timeoutMs: tailscaleAutoEnableTimeoutMs() });
  } catch (e) {
    throw new Error(`[local] failed to enable tailscale serve (is Tailscale running/authenticated?): ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function maybeResetTailscaleServe() {
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    return;
  }
  const enabled = (process.env.HAPPIER_STACK_TAILSCALE_SERVE ?? '0') === '1';
  const resetOnExit = (process.env.HAPPIER_STACK_TAILSCALE_RESET_ON_EXIT ?? '0') === '1';
  if (!enabled || !resetOnExit) {
    return;
  }
  try {
    // Shutdown path: never block for long.
    await tailscaleServeReset({ timeoutMs: tailscaleProbeTimeoutMs() });
  } catch {
    // ignore
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve the best public server URL to present to users / generate links.
 *
 * Priority:
 * 1) explicit HAPPIER_STACK_SERVER_URL override (if non-default)
 * 2) if enabled, prefer existing https://*.ts.net from tailscale serve status
 * 3) fallback to defaultPublicUrl
 *
 * If HAPPIER_STACK_TAILSCALE_SERVE=1, this can also try to enable serve and wait briefly for Tailscale to come up.
 */
export async function resolvePublicServerUrl({
  internalServerUrl,
  defaultPublicUrl,
  envPublicUrl,
  allowEnable = true,
  stackName = 'main',
}) {
  const preferTailscalePublicUrl = (process.env.HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL ?? '1') !== '0';
  const userExplicitlySetPublicUrl =
    !!envPublicUrl && envPublicUrl !== defaultPublicUrl && envPublicUrl !== internalServerUrl;

  if (userExplicitlySetPublicUrl || !preferTailscalePublicUrl) {
    return { publicServerUrl: envPublicUrl || defaultPublicUrl, source: 'env' };
  }

  // Non-main stacks:
  // - Never auto-enable (global machine state) by default.
  // - If the caller explicitly allows it AND Tailscale Serve is already configured for this stack's
  //   internal URL, prefer the HTTPS URL (safe: status must match the internal URL).
  if (stackName && stackName !== 'main') {
    if (allowEnable) {
      const existing = await tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl);
      if (existing) {
        return { publicServerUrl: existing, source: 'tailscale-status' };
      }
    }
    return { publicServerUrl: envPublicUrl || defaultPublicUrl, source: envPublicUrl ? 'env' : 'default' };
  }

  // If serve is already configured, use its HTTPS URL if present.
  const existing = await tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl);
  if (existing) {
    return { publicServerUrl: existing, source: 'tailscale-status' };
  }

  const enableServe = (process.env.HAPPIER_STACK_TAILSCALE_SERVE ?? '0') === '1';
  if (!enableServe || !allowEnable) {
    return { publicServerUrl: envPublicUrl || defaultPublicUrl, source: 'default' };
  }

  // Try enabling serve (best-effort); then wait a bit for Tailscale to be ready/configured.
  try {
    const res = await tailscaleServeEnable({ internalServerUrl, timeoutMs: tailscaleAutoEnableTimeoutMs() });
    if (res?.httpsUrl) {
      return { publicServerUrl: res.httpsUrl, source: 'tailscale-enable' };
    }
  } catch {
    // ignore and fall back to waiting/polling
  }

  const waitMs = process.env.HAPPIER_STACK_TAILSCALE_WAIT_MS?.trim()
    ? Number(process.env.HAPPIER_STACK_TAILSCALE_WAIT_MS.trim())
    : 15000;
  const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : 15000);
  while (Date.now() < deadline) {
    const url = await tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl);
    if (url) {
      return { publicServerUrl: url, source: 'tailscale-wait' };
    }
    await sleep(500);
  }

  return { publicServerUrl: envPublicUrl || defaultPublicUrl, source: 'default' };
}

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
    ['enable', 'hstack tailscale enable [--json]'],
    ['disable', 'hstack tailscale disable [--json]'],
    ['url', 'hstack tailscale url [--json]'],
    ['reset', 'hstack tailscale reset [--json]'],
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
          `${dim('enable:')} ${cmdFmt('hstack tailscale enable')} ${dim('[--json]')}`,
          `${dim('disable:')} ${cmdFmt('hstack tailscale disable')} ${dim('[--json]')}`,
          `${dim('url:')} ${cmdFmt('hstack tailscale url')} ${dim('[--json]')}`,
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
          `${dim('low-level:')} ${dim('node scripts/tailscale.mjs enable --upstream=<url> --path=/ [--json]')}`,
        ]),
      ].join('\n'),
    });
    return;
  }

  const internalServerUrl = getInternalServerUrl({ env: process.env, defaultPort: 3005 }).internalServerUrl;
  if (flags.has('--upstream') || kv.get('--upstream')) {
    process.env.HAPPIER_STACK_TAILSCALE_UPSTREAM = kv.get('--upstream') ?? internalServerUrl;
  }
  if (flags.has('--path') || kv.get('--path')) {
    process.env.HAPPIER_STACK_TAILSCALE_SERVE_PATH = kv.get('--path') ?? '/';
  }

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
      const url = await tailscaleServeHttpsUrl({ internalServerUrl });
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
      const res = await tailscaleServeEnable({ internalServerUrl });
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
      await tailscaleServeReset();
      printResult({ json, data: { ok: true }, text: `${green('✓')} tailscale serve reset` });
      return;
    }
    default:
      throw new Error(`[tailscale] unknown command: ${cmd}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[tailscale] failed:', err);
    process.exit(1);
  });
}
