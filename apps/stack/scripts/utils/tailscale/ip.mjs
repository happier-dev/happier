/**
 * Tailscale IP detection utilities.
 *
 * Provides functions to detect the local Tailscale IPv4 address for port forwarding.
 */

import { resolveTailscaleBin, sanitizeTailscaleEnv } from '@happier-dev/cli-common/tailscale';
import { runCaptureResult } from '../proc/proc.mjs';

const TAILSCALE_TIMEOUT_MS = 3000;

/**
 * Resolve the tailscale CLI path.
 *
 * Reuses the canonical shared Tailscale command resolution so the stack helper stays aligned
 * with the rest of the app and honors the unified env overrides.
 */
export async function resolveTailscaleCmd({ env = process.env } = {}) {
  try {
    return await resolveTailscaleBin({ env });
  } catch {
    return null;
  }
}

/**
 * Get the local Tailscale IPv4 address.
 *
 * @returns {Promise<string | null>} The Tailscale IPv4 address, or null if unavailable.
 */
export async function getTailscaleIpv4({ env = process.env } = {}) {
  const tailscaleEnv = sanitizeTailscaleEnv(env);
  const cmd = await resolveTailscaleCmd({ env: tailscaleEnv });
  if (!cmd) return null;

  const result = await runCaptureResult(cmd, ['ip', '-4'], {
    env: tailscaleEnv,
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
export async function isTailscaleAvailable({ env = process.env } = {}) {
  const ip = await getTailscaleIpv4({ env });
  return Boolean(ip);
}

/**
 * Get Tailscale status information.
 *
 * @returns {Promise<{ available: boolean, ip: string | null, error: string | null }>}
 */
export async function getTailscaleStatus({ env = process.env } = {}) {
  const cmd = await resolveTailscaleCmd({ env });
  if (!cmd) {
    return { available: false, ip: null, error: 'tailscale CLI not found' };
  }

  const ip = await getTailscaleIpv4({ env });
  if (!ip) {
    return { available: false, ip: null, error: 'tailscale not connected or no IPv4 address' };
  }

  return { available: true, ip, error: null };
}
