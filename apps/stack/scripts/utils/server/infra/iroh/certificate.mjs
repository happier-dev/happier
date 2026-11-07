import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { resolveTailscaleBin, sanitizeTailscaleEnv, runTailscaleStatusJson } from '@happier-dev/cli-common/tailscale';
import { runCaptureResult } from '../../../proc/proc.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from '../../../env/sandbox.mjs';
import { tailscaleProbeTimeoutMs, tailscaleEnableTimeoutMs } from '../../../net/tailscale_serve.mjs';

function certificateFailure(code) {
  const remediation = {
    relay_certificate_permission_denied: process.platform === 'win32'
      ? 'Ask the host administrator to permit this account to obtain Tailscale certificates, then retry the stack start.'
      : `Ask the host owner to run sudo tailscale set --operator=${userInfo().username} on this host, then retry the stack start.`,
    relay_certificate_https_disabled: 'Ask the tailnet administrator to enable MagicDNS and HTTPS Certificates in the Tailscale DNS settings, then retry the stack start.',
    relay_certificate_files_unavailable: 'Check that the relay certificate directory is writable and the Tailscale CLI writes both requested files on this host. On macOS use the standalone CLI if its app sandbox redirects file writes. Then retry the stack start.',
    relay_certificate_unavailable: 'On the server host, check tailscale status and the tailscale cert diagnostic for its tailnet DNS name, resolve the issuance failure, then retry the stack start.',
  }[code];
  return Object.assign(new Error('The development relay TLS certificate is unavailable'), { code, remediation });
}

export async function tailscaleRelayCertificate({ certDir, env = process.env, signal }) {
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) throw new Error('Tailscale certificate acquisition is disabled in sandbox mode');
  const status = await runTailscaleStatusJson({ env, signal, timeoutMs: tailscaleProbeTimeoutMs(env) });
  const tailnetIp = status.tailscaleIps.find(ip => !ip.includes(':')) ?? status.tailscaleIps[0];
  if (!status.running || !status.dnsName || !tailnetIp) {
    throw Object.assign(new Error('Tailscale is not ready for the development relay'), { code: 'relay_tailscale_unavailable' });
  }
  try { await mkdir(certDir, { recursive: true, mode: 0o700 }); }
  catch { throw certificateFailure('relay_certificate_files_unavailable'); }
  const command = await resolveTailscaleBin({ env });
  const result = await runCaptureResult(command, ['cert', `--cert-file=${join(certDir, 'default.crt')}`,
    `--key-file=${join(certDir, 'default.key')}`, status.dnsName], {
    env: sanitizeTailscaleEnv(env), signal,
    timeoutMs: tailscaleEnableTimeoutMs(env),
  });
  signal?.throwIfAborted();
  if (!result.ok) {
    // Tailscale 1.104.2 LocalAPI reports cert permission denial separately
    // from issuance/configuration errors. Never publish captured tool output.
    const diagnostic = `${result.err ?? ''}\n${result.out ?? ''}`;
    const code = /cert access denied|access denied/iu.test(diagnostic) ? 'relay_certificate_permission_denied'
      : /HTTPS cert support is not enabled|HTTPS is not enabled|does not support getting TLS certs/iu.test(diagnostic)
        ? 'relay_certificate_https_disabled' : 'relay_certificate_unavailable';
    throw certificateFailure(code);
  }
  try {
    const files = await Promise.all(['default.crt', 'default.key'].map(name => stat(join(certDir, name))));
    if (files.some(file => !file.isFile() || file.size === 0)) throw new Error('Certificate output missing');
  } catch { throw certificateFailure('relay_certificate_files_unavailable'); }
  return { hostname: status.dnsName, tailnetIp };
}
