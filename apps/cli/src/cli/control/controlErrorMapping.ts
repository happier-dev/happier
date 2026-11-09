import { SessionControlErrorCodeSchema } from '@happier-dev/protocol/sessions/control/contract';
import { TailscaleCommandError } from '@happier-dev/cli-common/tailscale';

export type ControlCliMappedError = Readonly<{ code: string; unexpected: boolean; message?: string }>;

export function mapUnknownErrorToControlError(error: unknown): ControlCliMappedError {
  if (error instanceof TailscaleCommandError && error.failure) {
    return { code: error.failure.code, unexpected: false, message: error.failure.remediation };
  }
  const errorRecord = typeof error === 'object' && error !== null ? error : null;
  const rawCode = errorRecord && 'code' in errorRecord && typeof errorRecord.code === 'string' ? errorRecord.code : null;

  const known = new Set<string>(SessionControlErrorCodeSchema.options);

  if (rawCode && known.has(rawCode)) {
    return { code: rawCode, unexpected: false, ...(error instanceof Error && error.message ? { message: error.message } : {}) };
  }

  if (rawCode === 'invalid_token') {
    return { code: 'not_authenticated', unexpected: false, ...(error instanceof Error && error.message ? { message: error.message } : {}) };
  }

  if (rawCode === 'HOME_AUTHORITY_MISMATCH') {
    return { code: 'identity_mismatch', unexpected: false, ...(error instanceof Error && error.message ? { message: error.message } : {}) };
  }

  if (rawCode === 'target_unavailable') {
    return { code: rawCode, unexpected: false, ...(error instanceof Error && error.message ? { message: error.message } : {}) };
  }

  if (
    rawCode === 'invalid_arguments'
    || rawCode === 'unknown_subcommand'
    || rawCode === 'machine_inventory_unavailable'
    || rawCode === 'server_identity_unavailable'
    || rawCode === 'mcp_catalog_unavailable'
    || rawCode === 'agent_isolation_unavailable'
    || rawCode === 'client_refused'
    || rawCode === 'no_machine_online'
    || rawCode === 'mcp_server_not_found'
    || rawCode === 'mcp_oauth_resource_requires_https'
    || rawCode === 'mcp_oauth_endpoints_require_https'
    || rawCode === 'connected_services_default_unavailable'
    || rawCode === 'invalid-mutation'
    || rawCode === 'identity_mismatch'
    || rawCode === 'duplicate_identity'
    || rawCode === 'invalid_home_descriptor'
    || rawCode === 'stale_home_descriptor'
    || rawCode === 'home_descriptor_conflict'
  ) {
    return { code: rawCode, unexpected: false, ...(error instanceof Error && error.message ? { message: error.message } : {}) };
  }

  if (errorRecord && 'name' in errorRecord && errorRecord.name === 'HappierTransportError') {
    const statusCode = Number(('statusCode' in errorRecord ? errorRecord.statusCode : undefined)
      ?? ('status' in errorRecord ? errorRecord.status : undefined));
    return {
      code: statusCode === 401 || statusCode === 403 ? 'not_authenticated' : 'server_unreachable',
      unexpected: false,
      ...(error instanceof Error && error.message ? { message: error.message } : {}),
    };
  }

  // Common network failures from axios/node.
  if (rawCode === 'ECONNREFUSED' || rawCode === 'ECONNRESET' || rawCode === 'ENOTFOUND' || rawCode === 'EAI_AGAIN') {
    return { code: 'server_unreachable', unexpected: false, ...(error instanceof Error && error.message ? { message: error.message } : {}) };
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();

  if (
    lower.startsWith('usage:') ||
    lower.startsWith('missing ') ||
    lower.startsWith('invalid ') ||
    lower.includes('missing required') ||
    lower.includes('non-interactive mode') ||
    lower.includes('unknown ')
  ) {
    return { code: 'invalid_arguments', unexpected: false, ...(message ? { message } : {}) };
  }
  if (lower.includes('unauthorized') || lower.includes('forbidden')) {
    return { code: 'not_authenticated', unexpected: false, ...(message ? { message } : {}) };
  }
  if (lower.includes('timeout')) {
    return { code: 'timeout', unexpected: false, ...(message ? { message } : {}) };
  }

  return { code: 'unknown_error', unexpected: true, ...(message ? { message } : {}) };
}
