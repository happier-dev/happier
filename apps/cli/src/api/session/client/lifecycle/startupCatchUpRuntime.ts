import type { SessionCatchUpRequest } from '../../sessionChangesSyncOnConnect';

type StartupCatchUpRecoveryRuntime = {
    catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
    scheduleNextStartupMessageCatchUpRetry: () => void;
};

export async function catchUpSessionMessagesViaPort(
    port: Readonly<{ recoveryRuntime: StartupCatchUpRecoveryRuntime }>,
    catchUpRequest: SessionCatchUpRequest,
): Promise<void> {
    if (!port.recoveryRuntime) {
        throw new Error('Startup transcript catch-up requires recoveryRuntime');
    }
    await port.recoveryRuntime.catchUpSessionMessages(catchUpRequest);
}

export function scheduleNextStartupCatchUpRetryViaPort(
    port: Readonly<{ recoveryRuntime: StartupCatchUpRecoveryRuntime }>,
): void {
    if (!port.recoveryRuntime) {
        throw new Error('Startup transcript catch-up retry requires recoveryRuntime');
    }
    port.recoveryRuntime.scheduleNextStartupMessageCatchUpRetry();
}
