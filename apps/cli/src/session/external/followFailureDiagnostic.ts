import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isPluginError, PluginError, type PluginErrorData } from '@happier-dev/plugin-sdk';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { logger } from '@/ui/logger';
import { ExternalSessionFollowFailureError } from './externalSessionFollowFailure';

const requestIdentity = new AsyncLocalStorage<string>();

export type ExternalSessionFollowReplayDiagnostic = Readonly<{
    operation: 'page_read' | 'listener_delivery';
    cursorKind: 'initial' | 'continuation';
    direction: 'older' | 'newer';
}>;

/** Host-private correlation; no diagnostic state crosses the public SDK. */
export function withExternalSessionFollowRequestId<T>(requestId: string, operation: () => T): T {
    return requestIdentity.run(requestId, operation);
}

export function reportExternalSessionFollowAcquisitionFailure(input: Readonly<{
    error: unknown;
    code: string;
    phase: 'admission' | 'replay';
    replay?: ExternalSessionFollowReplayDiagnostic;
}>): PluginErrorData {
    const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(input.error);
    const details = {
        requestId: requestIdentity.getStore() ?? randomUUID(),
        cause: {
            phase: input.phase,
            errorClass: input.error instanceof ExternalSessionFollowFailureError
                ? 'ExternalSessionFollowFailureError' : isPluginError(input.error) ? 'PluginError' : errorClass,
            errorCode: input.error instanceof ExternalSessionFollowFailureError ? input.error.code ?? input.error.kind : errorCode,
            httpStatus,
            ...(input.replay ? { replay: input.replay } : {}),
        },
    };
    logger.infoFile('[externalSessions.follow] acquisition_failed', { code: input.code, ...details });
    return new PluginError({
        code: input.code,
        message: 'External Session follow acquisition failed',
        details,
    }).data;
}
