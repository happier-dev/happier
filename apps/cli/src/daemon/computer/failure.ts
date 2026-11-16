import { projectActionFailureCauseV1, readActionErrorCodeV1, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { logger } from '@/ui/logger';
import { ComputerDriverError } from './driver/nativeTransport';
import { ComputerProviderUnavailableError } from './driver/provider';

/** One failure projection for picker, approval and selected-source operations. */
export function computerNativeFailure(error: unknown, phase: string) {
  const diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
  const known = error instanceof ComputerDriverError || error instanceof PluginError;
  const code = readActionErrorCodeV1(error) ?? diagnostic.errorCode ?? 'action_failed';
  const failureCause = projectActionFailureCauseV1(error, phase);
  // Never serialize the exception, its message, native payload or environment:
  // schema errors and native exceptions can contain window/clipboard content.
  logger.warnLocalFile('[Computer] Native operation failed', { ...diagnostic, phase, errorCode: code });
  const failure = { ok: false as const, errorCode: code, failureCause,
    error: known ? error.message : 'Computer operation failed. Check the Machine’s daemon log for the recorded cause.' };
  if (error instanceof ComputerProviderUnavailableError) return { ...failure,
    provider: error.provider, installableKey: error.installableKey, capabilityId: error.capabilityId,
    installHint: { actionId: 'machines.capabilities.install', capabilityId: error.capabilityId } };
  if (error instanceof PluginError && error.details) return { ...failure, details: error.details };
  return failure;
}
