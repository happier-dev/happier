/**
 * Tailscale IP detection utilities.
 *
 * Provides functions to detect the local Tailscale IPv4 address for port forwarding.
 */

import { runCaptureResult } from '../proc/proc.mjs';
import { resolveCommandPath } from '../proc/commands.mjs';
import { access, constants } from 'node:fs/promises';

const TAILSCALE_TIMEOUT_MS = 3000;

/**
 * Check if a path is executable.
 */
async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tailscale env: strip XPC_SERVICE_NAME which can cause hangs in LaunchAgent contexts.
 */
function tailscaleEnv() {
  const env = { ...process.env };
  delete env.XPC_SERVICE_NAME;
  return env;
}

/**
 * Resolve the tailscale CLI path.
 *
 * Priority:
 * 1. HAPPY_STACKS_TAILSCALE_BIN env override
 * 2. PATH lookup
 * 3. macOS app bundle paths
 */
export async function resolveTailscaleCmd() {
  // Explicit override
  if (process.env.HAPPY_STACKS_TAILSCALE_BIN?.trim()) {
    return process.env.HAPPY_STACKS_TAILSCALE_BIN.trim();
  }

  // Try PATH first
  try {
    const found = await resolveCommandPath('tailscale', { env: tailscaleEnv(), timeoutMs: TAILSCALE_TIMEOUT_MS });
    if (found) return found;
  } catch {
    // ignore
  }

  // macOS app bundle paths
  const appCliPath = '/Applications/Tailscale.app/Contents/MacOS/tailscale';
  if (await isExecutable(appCliPath)) return appCliPath;

  const appPath = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  if (await isExecutable(appPath)) return appPath;

  return null;
}

/**
 * Get the local Tailscale IPv4 address.
 *
 * @returns {Promise<string | null>} The Tailscale IPv4 address, or null if unavailable.
 */
export async function getTailscaleIpv4() {
  const cmd = await resolveTailscaleCmd();
  if (!cmd) return null;

  const result = await runCaptureResult(cmd, ['ip', '-4'], {
    env: tailscaleEnv(),
    timeoutMs: TAILSCALE_TIMEOUT_MS,
  });

  if (!result.ok) return null;

  const ip = result.out.trim().split('\n')[0]?.trim();
  // Validate IPv4 format (basic check)
  if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return null;

  return ip;
}

/**
 * Check if Tailscale is available and connected.
 *
 * @returns {Promise<boolean>}
 */
export async function isTailscaleAvailable() {
  const ip = await getTailscaleIpv4();
  return Boolean(ip);
}

/**
 * Get Tailscale status information.
 *
 * @returns {Promise<{ available: boolean, ip: string | null, error: string | null }>}
 */
export async function getTailscaleStatus() {
  const cmd = await resolveTailscaleCmd();
  if (!cmd) {
    return { available: false, ip: null, error: 'tailscale CLI not found' };
  }

  const ip = await getTailscaleIpv4();
  if (!ip) {
    return { available: false, ip: null, error: 'tailscale not connected or no IPv4 address' };
  }

  return { available: true, ip, error: null };
}
