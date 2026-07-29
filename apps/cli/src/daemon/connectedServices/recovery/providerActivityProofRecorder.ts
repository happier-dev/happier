import type { ConnectedServiceProviderOutcomeTarget } from '../runtimeAuth/types';


export type ConnectedServiceProviderActivityTurnLifecycleEvent =
    'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';

export type ConnectedServiceProviderActivityTerminalStatus = 'completed' | 'failed';

type RuntimeAuthRecoveryForProviderActivityProof = Readonly<{
    markProviderOutcomeProofByIdentity(input: Readonly<{
        sessionId: string;
        proofKind: 'provider_activity';
        serviceId: string;
        profileId: string | null;
        groupId: string | null;
        groupGeneration?: number | null;
        credentialRevision?: ConnectedServiceProviderOutcomeTarget['credentialRevision'] | null;
        observedAtMs?: number;
    }>): Promise<unknown>;
}>;

export type ConnectedServiceProviderActivityProofRecorder = (input: Readonly<{
    sessionId: string;
    observedAtMs?: number;
    providerOutcomeTargets?: readonly ConnectedServiceProviderOutcomeTarget[];
}>) => Promise<void>;

export function isProviderActivityTurnLifecycleEvent(
    event: ConnectedServiceProviderActivityTurnLifecycleEvent,
    terminalStatus?: ConnectedServiceProviderActivityTerminalStatus,
): boolean {
    return event === 'assistant_message_end' && terminalStatus !== 'failed';
}

/**
 * Completed provider activity is proof only when its producer supplies the exact
 * post-boundary provider outcome target. Launch-time continuation identities and
 * identities inferred from durable recovery rows are intentionally not proof.
 */
export function createConnectedServiceProviderActivityProofRecorder(params: Readonly<{
    runtimeAuthRecovery?: RuntimeAuthRecoveryForProviderActivityProof | null;
    nowMs?: () => number;
    logDebug?: (message: string, error: unknown) => void;
}>): ConnectedServiceProviderActivityProofRecorder {
    return async (input) => {
        if (input.providerOutcomeTargets !== undefined) {
            for (const target of input.providerOutcomeTargets) {
                if (target.groupId !== null && target.groupGeneration === null) continue;
                await params.runtimeAuthRecovery?.markProviderOutcomeProofByIdentity({
                    sessionId: input.sessionId,
                    proofKind: 'provider_activity',
                    serviceId: target.serviceId,
                    profileId: target.profileId,
                    groupId: target.groupId,
                    groupGeneration: target.groupGeneration,
                    credentialRevision: target.credentialRevision,
                    observedAtMs: input.observedAtMs ?? params.nowMs?.() ?? Date.now(),
                }).catch((error) => {
                    params.logDebug?.('[DAEMON RUN] Failed to clear runtime-auth recovery after exact connected-service provider activity (non-fatal)', error);
                });
            }
            return;
        }
    };
}
