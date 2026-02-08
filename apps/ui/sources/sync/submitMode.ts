import type { Session } from './storageTypes';
import { isVersionSupported, MINIMUM_CLI_PENDING_QUEUE_V2_VERSION } from '@/utils/versionUtils';

export type MessageSendMode = 'agent_queue' | 'interrupt' | 'server_pending';

export function chooseSubmitMode(opts: {
    configuredMode: MessageSendMode;
    session: Session | null;
}): MessageSendMode {
    const mode = opts.configuredMode;
    if (mode !== 'agent_queue') return mode;

    const session = opts.session;
    // Server-side pending queue V2 support is negotiated via session summary fields.
    // Mixed-version safety: older servers won't include these fields.
    const supportsQueue = typeof (session as any)?.pendingVersion === 'number';
    if (!supportsQueue) return mode;

    // If we have an explicit CLI version published, gate server_pending on it to avoid
    // stranded pending messages when an older agent is attached.
    const cliVersion = session?.metadata?.version;
    const trimmedCliVersion = typeof cliVersion === 'string' ? cliVersion.trim() : '';
    if (trimmedCliVersion) {
        if (!isVersionSupported(trimmedCliVersion, MINIMUM_CLI_PENDING_QUEUE_V2_VERSION)) {
            return mode;
        }
    }

    const controlledByUser = Boolean(session?.agentState?.controlledByUser);
    const isBusy = Boolean(session?.thinking);
    const isOnline = session?.presence === 'online';
    const agentReady = Boolean(session && session.agentStateVersion > 0);

    // Prefer the metadata-backed queue when:
    // - terminal has control (can't safely inject into local stdin),
    // - the agent is busy (user may want to edit/remove before processing),
    // - the agent is not ready yet (direct sends can be missed because the agent does not replay backlog), or
    // - the machine is offline (queue gives reliable eventual processing once it reconnects).
    if (controlledByUser || isBusy || !isOnline || !agentReady) {
        return 'server_pending';
    }

    return mode;
}
