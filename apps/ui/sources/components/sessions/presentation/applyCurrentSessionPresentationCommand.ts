import type {
    CurrentSessionPresentationAckV1,
    CurrentSessionPresentationStateV1,
} from '@happier-dev/protocol/sessions';

export function applyCurrentSessionPresentationCommand(params: Readonly<{
    sessionId: string;
    state: CurrentSessionPresentationStateV1;
    hostNonce: string;
    clientId: string;
    focusedSessionId: string | null;
    notify: (event: Readonly<{
        sessionId: string;
        message: string;
        severity: 'info' | 'warning' | 'error';
    }>) => void;
    composer: Readonly<{
        revision: number;
        replace: (text: string, expectedRevision: number) => number;
    }> | null;
}>): CurrentSessionPresentationAckV1 | null {
    const command = params.state.command;
    if (
        !command
        || params.state.hostNonce !== params.hostNonce
        || command.clientId !== params.clientId
    ) return null;

    if (command.kind === 'notify') {
        params.notify({ sessionId: params.sessionId, message: command.message, severity: command.severity });
        return {
            hostNonce: params.hostNonce,
            clientId: params.clientId,
            commandId: command.id,
            status: 'applied',
        };
    }

    const draftRevision = params.composer?.revision ?? 0;
    if (
        params.focusedSessionId !== params.sessionId
        || !params.composer
        || draftRevision !== command.expectedDraftRevision
    ) {
        return {
            hostNonce: params.hostNonce,
            clientId: params.clientId,
            commandId: command.id,
            status: 'conflict',
            draftRevision,
        };
    }
    const nextRevision = params.composer.replace(command.text, command.expectedDraftRevision);
    return {
        hostNonce: params.hostNonce,
        clientId: params.clientId,
        commandId: command.id,
        status: 'applied',
        draftRevision: nextRevision,
    };
}
