import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

/** The in-process onCreate boundary keeps the admitted refusal for the ordinary New Session owner. */
export class EmbedSessionCreationFailure extends Error {
    readonly code: string;
    readonly retryable: boolean;

    constructor(readonly actionResult: ActionExecuteFailure | Readonly<{
        ok: true;
        result: Extract<SessionSpawnNewResultV1, { type: 'error' }>;
    }>) {
        const code = actionResult.ok ? actionResult.result.code : actionResult.errorCode;
        super(code);
        this.code = code;
        this.retryable = actionResult.ok && actionResult.result.retryable;
    }
}
