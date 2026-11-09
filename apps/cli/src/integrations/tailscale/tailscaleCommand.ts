import { TailscaleCommandError, type TailscaleCommandFailure } from '@happier-dev/cli-common/tailscale';
import type { MachinePublishedTransferListenerDiagnosticV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

export { runTailscaleServeStatus } from '@happier-dev/cli-common/tailscale';

/** Optional discovery reports the closed cause while other connection routes remain usable. */
export function warnTailscaleCommandFailure(failure: TailscaleCommandFailure): void {
  console.warn(`[tailscale] ${failure.code}: ${failure.remediation}`);
}

/** Publication carries only closed facts; native output and local remedies stay local. */
export function tailscaleCommandFailureDiagnostic(error: unknown): MachinePublishedTransferListenerDiagnosticV1 | undefined {
  const failure = error instanceof TailscaleCommandError ? error.failure : null;
  return failure ? { code: failure.code, retryable: failure.retryable } : undefined;
}
