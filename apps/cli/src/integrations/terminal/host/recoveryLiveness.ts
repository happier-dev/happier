import type { TerminalHostAdapter, TerminalHostHandle, TerminalHostLivenessV1 } from '@happier-dev/agents';

import { sanitizeTerminalHostDiagnosticText } from '../../terminalHost/sanitizeTerminalHostDiagnosticText';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';

export type TerminalHostRecoveryProbeResult =
  | Readonly<{ status: 'alive'; liveness: TerminalHostLivenessV1; probeCount: number }>
  | Readonly<{ status: 'dead'; liveness: TerminalHostLivenessV1; probeCount: number }>
  | Readonly<{ status: 'inconclusive'; liveness: TerminalHostLivenessV1; probeCount: number }>;

function classifyRecoveryLiveness(
  liveness: TerminalHostLivenessV1,
  probeCount: number,
): TerminalHostRecoveryProbeResult {
  if (liveness.paneAlive) return { status: 'alive', liveness, probeCount };
  if (liveness.paneDead === true && liveness.probeInconclusive !== true) {
    return { status: 'dead', liveness, probeCount };
  }
  return {
    status: 'inconclusive',
    liveness: {
      ...liveness,
      paneAlive: false,
      probeInconclusive: true,
    },
    probeCount,
  };
}

async function probeOnce(input: Readonly<{
  adapter: TerminalHostAdapter;
  handle: TerminalHostHandle;
}>): Promise<TerminalHostLivenessV1> {
  try {
    return await input.adapter.evaluateLiveness(input.handle);
  } catch (error) {
    logger.debug('[TERMINAL HOST] Recovery liveness probe failed', {
      failureCause: projectActionFailureCauseV1(error, 'terminal_host.recovery_liveness', { allowUnknownErrorCode: false }),
    });
    return {
      paneAlive: false,
      probeInconclusive: true,
      paneScreenDumpError: sanitizeTerminalHostDiagnosticText(
        error instanceof Error ? error.message : String(error),
      ),
      observedAt: Date.now(),
    };
  }
}

export async function probeTerminalHostForRecovery(input: Readonly<{
  adapter: TerminalHostAdapter;
  handle: TerminalHostHandle;
}>): Promise<TerminalHostRecoveryProbeResult> {
  const first = classifyRecoveryLiveness(await probeOnce(input), 1);
  if (first.status !== 'inconclusive') return first;
  return classifyRecoveryLiveness(await probeOnce(input), 2);
}
