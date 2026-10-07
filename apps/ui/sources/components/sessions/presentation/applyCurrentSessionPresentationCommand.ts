import {
    ComposerTransactionResultV1Schema,
} from '@happier-dev/protocol/plugins/ui/composer';
import type {
    ComposerTransactionResultV1,
    ComposerTransactionV1,
} from '@happier-dev/protocol';
import type {
    CurrentSessionPresentationAckV1,
    CurrentSessionPresentationIntentResultV1,
    CurrentSessionPresentationIntentV1,
    CurrentSessionPresentationStateV1,
} from '@happier-dev/protocol/sessions';

/**
 * The UI runtime needs to remember a fire-and-forget notification as consumed
 * even though only composer mutations have an acknowledgement wire contract.
 * This is a private control result, not another presentation result vocabulary.
 */
export type CurrentSessionPresentationCommandApplication = Readonly<{
    ack: CurrentSessionPresentationAckV1 | null;
}>;

export function applyCurrentSessionPresentationCommand(params: Readonly<{
    state: CurrentSessionPresentationStateV1;
    hostNonce: string;
    clientId: string;
    /** Exact Account/Home/Session currentness is resolved by the mounted runtime. */
    isCurrentSession: boolean;
    notify: (event: Readonly<{
        message: string;
        severity: 'info' | 'warning' | 'error';
    }>) => void;
    /**
     * The daemon bridge receives only the focused mounted Session target. Its
     * apply port remains owned by the document registry and never performs the
     * generic offscreen Session fallback used by exact plugin handles.
     */
    composer: Readonly<{
        revision: number;
        apply: (transaction: ComposerTransactionV1) => ComposerTransactionResultV1;
    }> | null;
    /** Exact mounted Session adapter; it owns Board/Companion readability and effects. */
    presentation?: Readonly<{
        apply: (intent: CurrentSessionPresentationIntentV1) => CurrentSessionPresentationIntentResultV1;
    }> | null;
}>): CurrentSessionPresentationCommandApplication | null {
    const command = params.state.command;
    if (
        !command
        || params.state.hostNonce !== params.hostNonce
        || command.clientId !== params.clientId
    ) return null;

    if (command.kind === 'notify') {
        params.notify({ message: command.message, severity: command.severity });
        return { ack: null };
    }

    if (command.kind === 'presentation.apply') {
        const result: CurrentSessionPresentationIntentResultV1 =
            !params.isCurrentSession
                ? { status: 'notCurrent' }
                : params.presentation?.apply(command.intent) ?? { status: 'unavailable' };
        return {
            ack: {
                hostNonce: params.hostNonce,
                clientId: params.clientId,
                commandId: command.id,
                result,
            },
        };
    }

    return {
        ack: {
            hostNonce: params.hostNonce,
            clientId: params.clientId,
            commandId: command.id,
            // The Composer owner returns its immutable snapshot type; this is
            // the RPC acknowledgement boundary, whose schema owns the mutable
            // wire representation.
            result: ComposerTransactionResultV1Schema.parse(
                !params.isCurrentSession
                    ? { status: 'notEditable' }
                    : params.composer?.apply(command.transaction) ?? { status: 'composerUnavailable' },
            ),
        },
    };
}
