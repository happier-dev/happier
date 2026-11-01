import type { ConnectedAccountAttemptResponse, ConnectedAccountDaemonCommand } from '@happier-dev/protocol';
import type { createConnectedAccountAuthenticationAttemptOwner } from './authenticationAttemptOwner.js';
import type { ConnectedAccountAttemptTransactionRecord } from './attemptTransactionApi.js';

type AttemptOwner = ReturnType<typeof createConnectedAccountAuthenticationAttemptOwner>;
type BeginAdmission = Readonly<{
    intent: 'connect' | 'reconnect';
    service: Extract<ConnectedAccountDaemonCommand, { operation: 'beginConnect' }>['service'];
    authenticationModeId?: string;
}>;

/** The same command semantics for portable and native authentication hosts. */
export async function executeConnectedAccountAuthenticationCommand(input: Readonly<{
    attempts: AttemptOwner;
    command: ConnectedAccountDaemonCommand;
    /** The host's addressed read, reused by the canonical transaction decoder. */
    addressedRecord?: ConnectedAccountAttemptTransactionRecord;
    signal?: AbortSignal;
    assertBeginAllowed?(input: BeginAdmission): void | Promise<void>;
}>): Promise<ConnectedAccountAttemptResponse> {
    const { attempts, command } = input;
    if ('attemptId' in command) {
        const restored = await attempts.ensureRestored({ attemptId: command.attemptId,
            ...(input.addressedRecord ? { record: input.addressedRecord } : {}),
            ...(input.signal ? { signal: input.signal } : {}) });
        if (restored !== null) return restored;
    }
    switch (command.operation) {
        case 'beginConnect':
            await input.assertBeginAllowed?.({ intent: 'connect', service: command.service,
                authenticationModeId: command.modeId });
            return attempts.beginConnect({ service: command.service, modeId: command.modeId,
                ...(command.expectedConfigurationRevision === undefined ? {}
                    : { expectedConfigurationRevision: command.expectedConfigurationRevision }) });
        case 'beginReconnect':
            await input.assertBeginAllowed?.({ intent: 'reconnect', service: command.account.service });
            return attempts.beginReconnect({ account: command.account,
                ...(command.expectedConfigurationRevision === undefined ? {}
                    : { expectedConfigurationRevision: command.expectedConfigurationRevision }) });
        case 'continueConnect':
            return attempts.continueConnect({ attemptId: command.attemptId,
                ...(command.expectedConfigurationRevision === undefined ? {}
                    : { expectedConfigurationRevision: command.expectedConfigurationRevision }) });
        case 'submitManual':
            return attempts.submitManual({ attemptId: command.attemptId, fields: command.fields,
                ...(command.selectedSecrets ? { selectedSecrets: command.selectedSecrets } : {}),
                ...(input.signal ? { signal: input.signal } : {}) });
        case 'completeOAuth':
            return attempts.completeOAuth({ attemptId: command.attemptId, completion: command.completion,
                ...(input.signal ? { signal: input.signal } : {}) });
        case 'pollDevice':
            return attempts.pollDevice({ attemptId: command.attemptId,
                ...(input.signal ? { signal: input.signal } : {}) });
        case 'resumeDevice':
            return attempts.resumeDevice({ attemptId: command.attemptId });
        case 'reconcile':
            return attempts.reconcile({ attemptId: command.attemptId,
                ...(input.signal ? { signal: input.signal } : {}) });
        case 'cancel': {
            const cancelled = await attempts.cancel({ attemptId: command.attemptId });
            // Closing demand releases terminal responses; uncertain prepared
            // settlement keeps its existing recovery custody.
            if (cancelled.status !== 'outcomeUnknown' && cancelled.status !== 'cleanupPending') {
                attempts.releaseTerminalResponse(command.attemptId);
            }
            return cancelled;
        }
        case 'read':
            return attempts.read({ attemptId: command.attemptId,
                ...(command.waitForProviderStart === undefined ? {} : { waitForProviderStart: command.waitForProviderStart }),
                ...(input.signal ? { signal: input.signal } : {}) });
    }
}
