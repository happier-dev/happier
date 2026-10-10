import type { ExecutionRunScmDiffSummaryInputV1 } from '@happier-dev/protocol';
import { captureScmComparison, readCapturedScmComparison, type CapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { resolveCwd } from '@/scm/runtime';
import { resolveFilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

export async function loadScmDiffSummaryContext(params: Readonly<{
  input: ExecutionRunScmDiffSummaryInputV1;
  workingDirectory: string;
  sessionId?: string;
}>): Promise<CapturedScmComparison> {
  const input = params.input;
  const authorized = resolveCwd(input.cwd, params.workingDirectory, resolveFilesystemAccessPolicy());
  if (!authorized.ok) {
    throw Object.assign(new Error('Comparison evidence is unavailable for this Run filesystem scope'), { code: 'DIFF_UNAVAILABLE' });
  }
  const sessionId = params.sessionId;
  const sourceSessionId = typeof input.source.sessionId === 'string' ? input.source.sessionId : undefined;
  if ((input.sessionId && input.sessionId !== sessionId) || (sourceSessionId && sourceSessionId !== sessionId)) {
    throw Object.assign(new Error('Comparison evidence is unavailable for this Run scope'), { code: 'DIFF_UNAVAILABLE' });
  }
  if (input.comparisonId) {
    return await readCapturedScmComparison({ cwd: authorized.cwd,
      comparisonId: input.comparisonId, sessionId, source: input.source, turnId: input.turnId,
      checkpointReceiptId: input.checkpointReceiptId, turnEvidenceMode: input.turnEvidenceMode });
  }
  return await captureScmComparison({ cwd: authorized.cwd, source: input.source,
    sessionId, turnId: input.turnId, checkpointReceiptId: input.checkpointReceiptId,
    turnEvidenceMode: input.turnEvidenceMode });
}
