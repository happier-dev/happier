import type { TeamCredentialResourceReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';
import type { TeamCredentialResourceSourceResolution } from './sourceResolution';

/** A current source lifetime can still require its custodian to reconnect it. */
export function projectSourceAuthenticationReadiness(source: TeamCredentialResourceSourceResolution | null) {
    return source?.status === 'current' && source.authenticationFailure
        ? { kind: 'source_unavailable' as const, reason: source.authenticationFailure }
        : null;
}

export function sourceRequiresReconnect(readiness: TeamCredentialResourceReadinessV1): boolean {
    return readiness.kind === 'source_unavailable' && readiness.reason === 'connected_service_credential_reconnect_required';
}
