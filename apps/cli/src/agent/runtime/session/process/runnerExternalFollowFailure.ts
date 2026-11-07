import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';

/** Keep the transport's content-free cause at the acquisition owner, before cleanup. */
export function reportRunnerExternalFollowAcquisitionFailure(input: Readonly<{
    error: unknown;
    phase: 'ended_before_opened' | 'dispatch_failed';
    requestId: string;
}>): PluginError {
    const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(input.error);
    const details = {
        requestId: input.requestId,
        cause: { phase: input.phase, errorClass, errorCode, httpStatus },
    };
    logger.infoFile('[runner.externalSessions.follow] acquisition_failed', details);
    // Preserve recognized errors across separately bundled SDK copies as before.
    return isPluginError(input.error) ? input.error : new PluginError({
        code: 'plugin_external_follow_acquisition_failed',
        message: 'External Sessions follow acquisition failed',
        details,
    });
}
