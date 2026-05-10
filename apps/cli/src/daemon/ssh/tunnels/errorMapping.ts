import type {
  SshTunnelErrorCode,
  SshTunnelErrorResponse,
  SshTunnelHealth,
  SshTunnelHealthState,
} from '@happier-dev/protocol';

type SshTunnelErrorMetadata = Readonly<{
  errorCode: SshTunnelErrorCode;
  health: SshTunnelHealth;
}>;

export class SshTunnelSetupError extends Error {
  readonly errorCode: SshTunnelErrorCode;
  readonly health: SshTunnelHealth;

  constructor(message: string, metadata: SshTunnelErrorMetadata) {
    super(message);
    this.name = 'SshTunnelSetupError';
    this.errorCode = metadata.errorCode;
    this.health = metadata.health;
  }
}

function classifyOpenSshSetupFailure(message: string): Readonly<{
  errorCode: SshTunnelErrorCode;
  state: SshTunnelHealthState;
}> {
  const lower = message.toLowerCase();
  if (lower.includes('host key verification failed') || lower.includes('remote host identification has changed')) {
    return { errorCode: 'ssh_tunnel_host_key_untrusted', state: 'host_key_untrusted' };
  }
  if (lower.includes('permission denied') || lower.includes('authentication failed') || lower.includes('password')) {
    return { errorCode: 'ssh_tunnel_auth_required', state: 'auth_required' };
  }
  if (lower.includes('address already in use') || lower.includes('bind:') || lower.includes('local port')) {
    return { errorCode: 'ssh_tunnel_local_port_conflict', state: 'local_port_conflict' };
  }
  return { errorCode: 'ssh_tunnel_unavailable', state: 'ssh_process_unavailable' };
}

export function createSshTunnelSetupError(error: unknown, checkedAt: string): SshTunnelSetupError {
  const message = error instanceof Error ? error.message : 'SSH tunnel unavailable';
  const classification = classifyOpenSshSetupFailure(message);
  return new SshTunnelSetupError(message, {
    errorCode: classification.errorCode,
    health: {
      state: classification.state,
      checkedAt,
      ...(message ? { detail: message } : {}),
    },
  });
}

export function createSshTunnelHealthError(health: SshTunnelHealth): SshTunnelSetupError {
  const errorCode: SshTunnelErrorCode = health.state === 'auth_required'
    ? 'ssh_tunnel_auth_required'
    : health.state === 'host_key_untrusted'
      ? 'ssh_tunnel_host_key_untrusted'
      : health.state === 'local_port_conflict'
        ? 'ssh_tunnel_local_port_conflict'
        : 'ssh_tunnel_unavailable';
  return new SshTunnelSetupError(errorCode, {
    errorCode,
    health,
  });
}

export function toSshTunnelErrorResponse(error: unknown): SshTunnelErrorResponse | null {
  if (!(error instanceof Error)) return null;
  const candidate = error as Error & Partial<SshTunnelErrorMetadata>;
  if (!candidate.errorCode || !candidate.health) return null;
  return {
    ok: false,
    errorCode: candidate.errorCode,
    error: candidate.errorCode,
    health: candidate.health,
  };
}
