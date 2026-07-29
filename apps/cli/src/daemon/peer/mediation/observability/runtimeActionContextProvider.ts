import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import type { DaemonPeerMediationObservabilityRuntime } from '@/daemon/machine/peerMediationObservabilityRuntime';

import type { DaemonPeerMediationObservabilityRuntimeActionContext } from './runtimeActionExecutor';

export type PeerMediationObservabilityRuntimeActionContextPublisher = Readonly<{
    setPeerMediationObservabilityRuntimeActionContextProvider(
        provider: (() => DaemonPeerMediationObservabilityRuntimeActionContext | null) | null,
    ): void;
}>;

export type PeerMediationObservabilityDiagnosticLogger = Readonly<{
    warn(message: string, details?: unknown): void;
}>;

export function installPeerMediationObservabilityRuntimeActionContextProvider(
    input: Readonly<{
        api: PeerMediationObservabilityRuntimeActionContextPublisher;
        credentialsToken: string;
        runtime: DaemonPeerMediationObservabilityRuntime;
        machineId: () => string;
        logger: PeerMediationObservabilityDiagnosticLogger;
    }>,
): void {
    const payload = decodeJwtPayload(input.credentialsToken);
    const rawSubject = payload?.sub;
    const accountId = typeof rawSubject === 'string' ? rawSubject.trim() : '';
    if (!accountId) {
        input.logger.warn('[DAEMON RUN] Peer mediation observability read-path disabled: JWT subject missing or malformed', {
            reason: payload ? 'jwt_sub_missing' : 'jwt_payload_invalid',
        });
        return;
    }

    input.api.setPeerMediationObservabilityRuntimeActionContextProvider(() => ({
        store: input.runtime.store,
        accountId,
        machineId: input.machineId(),
    }));
}
