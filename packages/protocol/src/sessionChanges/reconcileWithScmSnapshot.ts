import type { ScmWorkingSnapshot } from '../scm.js';
import type { SessionChangeSet, SessionWorkingTreeProjection } from './types.js';

function buildRepositoryPathCandidates(filePath: string, previousFilePath?: string | null): string[] {
  const candidates = [filePath, previousFilePath ?? null]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return Array.from(new Set(candidates));
}

export function reconcileWithScmSnapshot(params: Readonly<{
  sessionChangeSet: SessionChangeSet;
  snapshot: ScmWorkingSnapshot | null;
}>): SessionWorkingTreeProjection {
  const entries = params.snapshot?.entries ?? [];
  const consumedPaths = new Set<string>();
  const matchedFiles: Array<SessionWorkingTreeProjection['matchedFiles'][number]> = [];
  const unmatchedSessionFiles: Array<SessionWorkingTreeProjection['unmatchedSessionFiles'][number]> = [];

  for (const sessionFile of params.sessionChangeSet.files) {
    const candidates = buildRepositoryPathCandidates(sessionFile.filePath, sessionFile.previousFilePath);
    const match = entries.find((entry) => candidates.includes(entry.path) || (entry.previousPath ? candidates.includes(entry.previousPath) : false));
    if (!match) {
      unmatchedSessionFiles.push(sessionFile);
      continue;
    }
    consumedPaths.add(match.path);
    matchedFiles.push({
      filePath: sessionFile.filePath,
      repositoryPath: match.path,
      sessionChange: sessionFile,
      repositoryEntry: {
        path: match.path,
        previousPath: match.previousPath,
        kind: match.kind,
      },
    });
  }

  const repositoryOnlyFiles = entries
    .filter((entry) => !consumedPaths.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      previousPath: entry.previousPath,
      kind: entry.kind,
    }));

  return {
    sessionId: params.sessionChangeSet.sessionId,
    matchedFiles,
    unmatchedSessionFiles,
    repositoryOnlyFiles,
    projectionReliability: params.sessionChangeSet.confidenceSummary.confidence,
  };
}
