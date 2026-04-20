import { discardQueuedAndPendingForTerminalSwitch } from '../../../agent/runtimeSwitching/discardQueuedAndPendingForSwitch';
import { discardPendingBeforeSwitchToTerminal } from '../../../agent/runtimeSwitching/discardPendingBeforeSwitch';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import type { Session } from '../runtime/session/ClaudeSession';

export async function runClaudeLocalSwitchEntryGate(session: Session): Promise<boolean> {
    const autoConfirmDiscardForE2e =
        process.env.HAPPIER_E2E_PROVIDERS === '1' || process.env.HAPPY_E2E_PROVIDERS === '1';
    const pendingGateStartMs = configuration.startupTimingEnabled ? Date.now() : null;
    const discardResult = await discardQueuedAndPendingForTerminalSwitch({
        queue: session.queue,
        getServerPendingCount: () => session.client.peekPendingMessageQueueV2Count(),
        discardServerPending: () =>
            session.client.discardPendingMessageQueueV2All({ reason: 'switch_to_local' }),
        markQueuedAsDiscarded: (localIds) =>
            session.client.discardCommittedMessageLocalIds({ localIds: [...localIds], reason: 'switch_to_local' }),
        sendStatusMessage: (message) => {
            session.client.sendSessionEvent({ type: 'message', message });
        },
        formatError: formatErrorForUi,
        ...(autoConfirmDiscardForE2e
            ? {
                discardController: (args: Parameters<typeof discardPendingBeforeSwitchToTerminal>[0]) =>
                    discardPendingBeforeSwitchToTerminal({
                        ...args,
                        confirmDiscard: async () => true,
                    }),
            }
            : {}),
    });
    if (pendingGateStartMs !== null) {
        logger.debug(`[claude-startup] claude_pending_queue_switch_gate=${Math.max(0, Date.now() - pendingGateStartMs)}ms`);
    }
    return discardResult === 'proceed';
}
