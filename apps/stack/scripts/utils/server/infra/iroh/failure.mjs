import { TailscaleCommandError } from '@happier-dev/cli-common/tailscale';

const RELAY_FAILURE_CODES = new Set([
  'relay_profile_invalid', 'relay_binary_version_mismatch', 'relay_binary_unavailable',
  'relay_binary_install_failed', 'relay_rate_invalid', 'relay_tailscale_unavailable',
  'relay_certificate_unavailable', 'relay_certificate_permission_denied', 'relay_certificate_https_disabled',
  'relay_certificate_files_unavailable', 'relay_health_unavailable', 'relay_serve_unavailable', 'relay_serve_conflict',
  'relay_serve_status_unavailable', 'relay_serve_port_unavailable',
]);

const SYSTEM_FAILURE_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE', 'EADDRNOTAVAIL', 'ENOSPC', 'ENOMEM',
  'EMFILE', 'ENFILE', 'EIO', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EROFS', 'ETIMEDOUT',
  'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE',
]);

export function relayStartupFailure(error, phase) {
  const known = RELAY_FAILURE_CODES.has(error?.code);
  const tailscale = error instanceof TailscaleCommandError;
  const cause = tailscale ? error.failure : null;
  // Never copy messages, paths, captured tool output or arbitrary error codes.
  const code = cause?.code ?? (known || SYSTEM_FAILURE_CODES.has(error?.code) ? error.code
    : tailscale ? 'TailscaleCommandError'
    : error instanceof TypeError ? 'TypeError'
      : error instanceof ReferenceError ? 'ReferenceError'
        : error instanceof SyntaxError ? 'SyntaxError'
          : error instanceof RangeError ? 'RangeError' : 'unclassified');
  return {
    status: 'degraded', reason: cause?.code ?? (known ? error.code : 'relay_start_failed'),
    httpsUrl: null, upstreamUrl: null, version: null, target: null,
    remediation: cause?.remediation ?? (known ? error.remediation ?? null : null),
    failure: { phase, code, ...cause, ...(tailscale ? { stderrClass: error.stderrClass } : {}), ...(tailscale && Number.isInteger(error.result.exitCode)
      ? { exitCode: error.result.exitCode } : {}) },
  };
}
