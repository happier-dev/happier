import type { Session } from '@/sync/domains/state/storageTypes';
import { isVersionSupported, MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } from '@/utils/system/versionUtils';

export type MessageSendMode = 'agent_queue' | 'interrupt' | 'server_pending';

export type BusySteerSendPolicy = 'steer_immediately' | 'server_pending';

export function chooseSubmitMode(opts: {
    configuredMode: MessageSendMode;
    busySteerSendPolicy?: BusySteerSendPolicy;
    session: Session | null;
}): MessageSendMode {
    const configuredMode = opts.configuredMode;
    if (configuredMode === 'interrupt') return 'interrupt';

    const session = opts.session;
    // Server-side pending queue V2 support is negotiated via session summary fields.
    // Mixed-version safety: older servers won't include these fields.
    const supportsQueue = typeof (session as any)?.pendingVersion === 'number';
    if (!supportsQueue) {
        // If the user explicitly configured pending but the server doesn't support it,
        // fall back to agent_queue to avoid "phantom pending" that can never be processed.
        return configuredMode === 'server_pending' ? 'agent_queue' : configuredMode;
    }

    // If we have an explicit CLI version published, gate server_pending on it to avoid
    // stranded pending messages when an older agent is attached.
    const cliVersion = session?.metadata?.version;
    const trimmedCliVersion = typeof cliVersion === 'string' ? cliVersion.trim() : '';
    if (trimmedCliVersion) {
        if (!isVersionSupported(trimmedCliVersion, MINIMUM_CLI_PENDING_QUEUE_V2_VERSION)) {
            return configuredMode === 'server_pending' ? 'agent_queue' : configuredMode;
        }
    }

    const controlledByUser = Boolean(session?.agentState?.controlledByUser);
    const isBusy = Boolean(session?.thinking);
    const isOnline = session?.presence === 'online';
    const agentReady = Boolean(session && session.agentStateVersion > 0);
    const inFlightSteer = Boolean(session?.agentState?.capabilities?.inFlightSteer);
    const busySteerSendPolicy: BusySteerSendPolicy = opts.busySteerSendPolicy ?? 'steer_immediately';

    // Prefer the metadata-backed queue when:
    // - terminal has control (can't safely inject into local stdin),
    // - the agent is busy (user may want to edit/remove before processing),
    // - the agent is not ready yet (direct sends can be missed because the agent does not replay backlog), or
    // - the machine is offline (queue gives reliable eventual processing once it reconnects).
    //
    // Exception: if the agent supports in-flight steer and is online+ready, do NOT auto-enqueue while busy.
    // Steering preserves the current turn (Codex-style) and is the more intuitive default.
    if (isBusy && inFlightSteer && !controlledByUser && isOnline && agentReady && busySteerSendPolicy === 'steer_immediately') {
        return 'agent_queue';
    }

    if (controlledByUser || isBusy || !isOnline || !agentReady) {
        return 'server_pending';
    }

    return configuredMode;
}
