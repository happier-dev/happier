import type { ExecutionRunScmDiffSummaryInputV1 } from '@happier-dev/protocol';
import { captureScmComparison, readCapturedScmComparison, type CapturedScmComparison } from '@/scm/comparisons/captureScmComparison';

export async function loadScmDiffSummaryContext(params: Readonly<{
  input: ExecutionRunScmDiffSummaryInputV1;
  workingDirectory: string;
  sessionId?: string;
}>): Promise<CapturedScmComparison> {
  const input = params.input;
  const sessionId = params.sessionId ?? input.sessionId;
  if (input.comparisonId) {
    return await readCapturedScmComparison({ cwd: input.cwd ?? params.workingDirectory,
      comparisonId: input.comparisonId, sessionId, source: input.source, turnId: input.turnId,
      checkpointReceiptId: input.checkpointReceiptId, turnEvidenceMode: input.turnEvidenceMode });
  }
  return await captureScmComparison({ cwd: input.cwd ?? params.workingDirectory, source: input.source,
    sessionId, turnId: input.turnId, checkpointReceiptId: input.checkpointReceiptId,
    turnEvidenceMode: input.turnEvidenceMode });
}
