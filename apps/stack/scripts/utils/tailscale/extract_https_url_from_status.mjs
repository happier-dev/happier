import { extractTailscaleServeHttpsUrl } from '@happier-dev/cli-common/tailscale';

export function extractTailscaleHttpsUrlFromStatusText(statusText) {
  return extractTailscaleServeHttpsUrl(String(statusText ?? ''));
}
