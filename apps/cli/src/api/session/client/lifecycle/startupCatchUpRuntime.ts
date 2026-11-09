import type { SessionCatchUpRequest } from '../../sessionChangesSyncOnConnect';

type StartupCatchUpRecoveryRuntime = {
    catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
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
