import type { ScmWorkingSnapshot } from '../scm.js';
import type { SessionChangeSet, SessionWorkingTreeProjection } from './types.js';

function joinCanonicalPath(root: string, remainder: string, absolute: boolean): string {
  const segments: string[] = [];
  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
        continue;
      }
      if (!absolute) {
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return root;
  }

  if (!root) {
    return segments.join('/');
  }

  return root === '/' ? `/${segments.join('/')}` : `${root}${segments.join('/')}`;
}

function canonicalizePath(path: string): string {
  const uncMatch = path.match(/^(\/\/[^/]+\/[^/]+)(?:\/(.*))?$/);
  if (uncMatch) {
    return joinCanonicalPath(uncMatch[1], uncMatch[2] ?? '', true);
  }

  const driveMatch = path.match(/^([a-z]:\/)(.*)$/i);
  if (driveMatch) {
    return joinCanonicalPath(`${driveMatch[1].charAt(0).toLowerCase()}${driveMatch[1].slice(1)}`, driveMatch[2], true);
  }

  if (path.startsWith('/')) {
    return joinCanonicalPath('/', path.slice(1), true);
  }

  return joinCanonicalPath('', path, false);
}

function stripTrailingPathSeparator(path: string): string {
  if (path === '/') return path;
  if (/^[a-z]:\/$/i.test(path)) return path;
  if (/^\/\/[^/]+\/[^/]+$/u.test(path)) return path;
  return path.replace(/\/+$/, '');
}

function normalizePathToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withForwardSlashes = trimmed.replace(/\\/g, '/');
  const normalizedDrivePrefix = /^[A-Z]:/.test(withForwardSlashes)
    ? `${withForwardSlashes.charAt(0).toLowerCase()}${withForwardSlashes.slice(1)}`
    : withForwardSlashes;
  return stripTrailingPathSeparator(canonicalizePath(normalizedDrivePrefix));
}

function normalizeRepositoryPathToken(value: string): string {
  const normalized = normalizePathToken(value).replace(/^\.\//, '');
  return normalized === '.' ? '' : normalized;
}

function usesWindowsPathSemantics(path: string): boolean {
  return /^[a-z]:\//i.test(path) || path.startsWith('//');
}

function comparablePath(path: string): string {
  return usesWindowsPathSemantics(path) ? path.toLowerCase() : path;
}

function deriveRepositoryRelativePath(params: Readonly<{
  filePath: string;
  repoRootPath: string | null | undefined;
}>): string | null {
  const rootPath = typeof params.repoRootPath === 'string' ? normalizePathToken(params.repoRootPath) : '';
  const filePath = normalizePathToken(params.filePath);
  if (!rootPath || !filePath) return null;

  const comparableRoot = comparablePath(rootPath);
  const comparableFile = comparablePath(filePath);
  if (comparableFile === comparableRoot) return '';

  const rootPrefix = `${comparableRoot}/`;
  if (!comparableFile.startsWith(rootPrefix)) return null;

  return normalizeRepositoryPathToken(filePath.slice(rootPath.length + 1));
}

function buildRepositoryPathCandidates(
  filePath: string,
  previousFilePath: string | null | undefined,
  repoRootPath: string | null | undefined,
): string[] {
  const rawCandidates = [filePath, previousFilePath ?? null]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const candidates = rawCandidates.flatMap((value) => {
    const normalized = normalizeRepositoryPathToken(value);
    const relative = deriveRepositoryRelativePath({ filePath: value, repoRootPath });
    return [value.trim(), normalized, relative].filter((candidate): candidate is string => Boolean(candidate));
  });
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
    const candidates = buildRepositoryPathCandidates(sessionFile.filePath, sessionFile.previousFilePath, params.snapshot?.repo.rootPath);
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
