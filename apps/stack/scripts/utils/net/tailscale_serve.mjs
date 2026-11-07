import {
  TailscaleCommandError,
  classifyTailscaleServeRootSlot,
  runTailscaleServeEnable,
  runTailscaleServeDisable,
  runTailscaleServeStatus,
  tailscaleServeHttpsUrlForOwnedConfigFromStatus,
  tailscaleServeHttpsUrlForInternalServerUrlFromStatus,
} from '@happier-dev/cli-common/tailscale';
import { run } from '../proc/proc.mjs';
import { resolveStackServerEndpoint } from '../server/urls.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from '../env/sandbox.mjs';

export function getServeConfig(internalServerUrl, { env = process.env, upstreamUrl, servePath } = {}) {
  return {
    upstream: upstreamUrl ?? (String(env.HAPPIER_STACK_TAILSCALE_UPSTREAM ?? '').trim() || internalServerUrl),
    servePath: servePath ?? (String(env.HAPPIER_STACK_TAILSCALE_SERVE_PATH ?? '').trim() || '/'),
  };
}

function assertTailscaleAllowed(action) {
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    throw new Error(`[local] tailscale ${action} is disabled in sandbox mode. Tailscale Serve is global machine state.`);
  }
}

function parseTimeoutMs(raw, defaultMs) {
  const s = String(raw ?? '').trim();
  if (!s) return defaultMs;
  const n = Number(s);
  if (!Number.isFinite(n)) return defaultMs;
  return n > 0 ? n : 0;
}

export function tailscaleProbeTimeoutMs(env = process.env) {
  return parseTimeoutMs(env.HAPPIER_STACK_TAILSCALE_CMD_TIMEOUT_MS, 2500);
}

export function tailscaleEnableTimeoutMs(env = process.env) {
  return parseTimeoutMs(env.HAPPIER_STACK_TAILSCALE_ENABLE_TIMEOUT_MS, 30000);
}

export function tailscaleAutoEnableTimeoutMs(env = process.env) {
  return parseTimeoutMs(env.HAPPIER_STACK_TAILSCALE_ENABLE_TIMEOUT_MS_AUTO, tailscaleProbeTimeoutMs(env));
}

export async function tailscaleServeStatus({ env = process.env, signal, json = false } = {}) {
  assertTailscaleAllowed('status');
  return await runTailscaleServeStatus({ env, signal, json, timeoutMs: tailscaleProbeTimeoutMs(env) });
}

export async function tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl) {
  try {
    return tailscaleServeHttpsUrlForInternalServerUrlFromStatus(await tailscaleServeStatus(), internalServerUrl);
  } catch (error) {
    if (error instanceof TailscaleCommandError && error.failure) throw error;
    return null;
  }
}

export async function tailscaleServeHttpsUrl({ internalServerUrl } = {}) {
  try {
    const comparable = String(internalServerUrl ?? '').trim() || (await resolveStackServerEndpoint()).internalServerUrl;
    return tailscaleServeHttpsUrlForInternalServerUrlFromStatus(await tailscaleServeStatus(), comparable);
  } catch (error) {
    if (error instanceof TailscaleCommandError && error.failure) throw error;
    return null;
  }
}

export async function tailscaleServeEnable({ internalServerUrl, upstreamUrl, servePath: path, httpsPort,
  timeoutMs, env = process.env, openApproval = true, signal } = {}) {
  assertTailscaleAllowed('enable');
  const { upstream, servePath } = getServeConfig(internalServerUrl, { env, upstreamUrl, servePath: path });
  if (servePath === '/') {
    const slot = classifyTailscaleServeRootSlot(await tailscaleServeStatus({ env, signal }), upstream, { httpsPort });
    if (slot.kind === 'conflict') {
      throw Object.assign(new Error('The requested Tailscale listener belongs to another route'), { code: 'relay_serve_conflict' });
    }
  }
  const result = await runTailscaleServeEnable({ env, signal, upstreamUrl: upstream, servePath,
    ...(httpsPort === undefined ? {} : { httpsPort }),
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : tailscaleEnableTimeoutMs(env) });
  if (result.approvalUrl && openApproval) {
    try { await run('open', [result.approvalUrl]); } catch { /* Headless hosts cannot open a browser. */ }
  }
  return { enableUrl: result.approvalUrl, httpsUrl: result.httpsUrl, status: result.rawStatus };
}

// Historical public name retained; cleanup now removes only this owned route.
// A host-wide reset would also erase database, relay and other stacks' mappings.
export async function tailscaleServeReset({ internalServerUrl, upstreamUrl, servePath: path, httpsPort,
  timeoutMs, env = process.env } = {}) {
  assertTailscaleAllowed('disable');
  const internal = internalServerUrl ?? (await resolveStackServerEndpoint({ env })).internalServerUrl;
  const { upstream, servePath } = getServeConfig(internal, { env, upstreamUrl, servePath: path });
  const owned = tailscaleServeHttpsUrlForOwnedConfigFromStatus({
    serveStatusText: await tailscaleServeStatus({ env }), internalServerUrl: upstream, servePath, httpsPort,
  });
  if (!owned) return { removed: false, reason: 'not_owned' };
  await runTailscaleServeDisable({ env, servePath, ...(httpsPort === undefined ? {} : { httpsPort }),
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : parseTimeoutMs(env.HAPPIER_STACK_TAILSCALE_RESET_TIMEOUT_MS, 15000) });
  return { removed: true };
}

export async function maybeEnableTailscaleServe({ internalServerUrl }) {
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) return null;
  if ((process.env.HAPPIER_STACK_TAILSCALE_SERVE ?? '0') !== '1') return null;
  try {
    return await tailscaleServeEnable({ internalServerUrl, timeoutMs: tailscaleAutoEnableTimeoutMs() });
  } catch (error) {
    if (error instanceof TailscaleCommandError && error.failure) throw error;
    throw new Error(`[local] failed to enable tailscale serve (is Tailscale running/authenticated?): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function maybeResetTailscaleServe() {
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) return;
  if ((process.env.HAPPIER_STACK_TAILSCALE_SERVE ?? '0') !== '1'
    || (process.env.HAPPIER_STACK_TAILSCALE_RESET_ON_EXIT ?? '0') !== '1') return;
  try { await tailscaleServeReset({ timeoutMs: tailscaleProbeTimeoutMs() }); }
  catch (error) {
    // Shutdown remains best effort, but a refused cleanup needs an actionable cause.
    if (error instanceof TailscaleCommandError && error.failure) {
      console.warn(`[tailscale] ${error.failure.code}: ${error.message}`);
    }
  }
}


