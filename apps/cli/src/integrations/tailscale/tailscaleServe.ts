/**
 * Best-effort Tailscale Serve detection for deriving a public https://*.ts.net URL.
 *
 * Use case:
 * - CLI connects to a local server via loopback (e.g. http://127.0.0.1:<port>)
 * - Other devices need a public (tailnet) URL for QR/deep links
 *
 * This module reads `tailscale serve status` output and returns the https base URL
 * when it appears to proxy the given internal server URL.
 */

import { runTailscaleServeStatus } from '@/integrations/tailscale/tailscaleCommand';
import { tailscaleServeHttpsUrlForInternalServerUrlFromStatus } from '@happier-dev/cli-common/tailscale';

export async function tailscaleServeHttpsUrlForInternalServerUrl(params: Readonly<{
  internalServerUrl: string;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  tailscaleBin?: string | undefined;
}>): Promise<string | null> {
  const internalServerUrl = String(params.internalServerUrl ?? '').trim();
  if (!internalServerUrl) return null;

  try {
    const status = await runTailscaleServeStatus({
      timeoutMs: params.timeoutMs,
      env: params.env ?? process.env,
      tailscaleBin: params.tailscaleBin,
    });
    return tailscaleServeHttpsUrlForInternalServerUrlFromStatus(status, internalServerUrl);
  } catch {
    return null;
  }
}
