import { basename, isAbsolute, join } from 'node:path';

import { readExactCodexProviderSessionId } from '../../../../../protocol/runtimeDescriptorV1.js';
import { isCodexRolloutFilePath, parseCodexRolloutFilename } from '../../../../rollout/discovery/indexData.js';
import { isMatchingCodexRolloutFileName } from '../../../../rollout/discovery/sessionFileSearch.js';

export type CodexSessionImportRoot = Readonly<{
  sourceRoot: string;
  destinationRoot: string;
  includeFile: (relativePath: string) => boolean;
}>;

export type CodexImportedSessionFileDetail = Readonly<{
  sourcePath: string;
  destinationPath: string;
  relativePath: string;
}>;

export type CodexSessionFileMapping = Readonly<{
  destinationPath?: unknown;
  relativePath?: unknown;
}>;

const CODEX_IMPORTABLE_SESSION_HOME_ENTRIES = Object.freeze([
  'sessions',
  'archived_sessions',
] as const);

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createCodexSessionImportRoots(params: Readonly<{
  destinationCodexHome: string;
  sourceCodexHome: string;
}>): readonly CodexSessionImportRoot[] {
  return CODEX_IMPORTABLE_SESSION_HOME_ENTRIES.map((entryName) => ({
    sourceRoot: join(params.destinationCodexHome, entryName),
    destinationRoot: join(params.sourceCodexHome, entryName),
    includeFile: isCodexRolloutFilePath,
  }));
}

export function resolveCodexVendorResumeIdFromImportedSessionFile(
  detail: CodexImportedSessionFileDetail,
): string | null {
  const candidates = [basename(detail.sourcePath), basename(detail.destinationPath), detail.relativePath];
  for (const candidate of candidates) {
    const parsed = parseCodexRolloutFilename(candidate);
    if (parsed?.threadId) return parsed.threadId;
  }
  return null;
}

/**
 * The vendor resume id is the provider session id that becomes a rollout
 * file-name suffix and a `threads.id` row key, so presence is decided by the
 * package's exact provider-session reader and the bytes are never rewritten.
 * A value carrying a path separator can never be a rollout file-name suffix,
 * so it is refused here rather than searched for.
 */
export function readExactCodexVendorResumeId(value: unknown): string | null {
  const vendorResumeId = readExactCodexProviderSessionId(value);
  if (!vendorResumeId) return null;
  if (vendorResumeId.includes('/') || vendorResumeId.includes('\\')) return null;
  return vendorResumeId;
}

export function resolveCodexMaterializedSessionsRoot(targetMaterializedRoot: string): string {
  return join(targetMaterializedRoot, 'sessions');
}

export function resolveCodexSessionFileMappingDestinationPaths(params: Readonly<{
  targetMaterializedRoot: string;
  mapping: CodexSessionFileMapping;
}>): string[] {
  const rawPaths: string[] = [];
  const destinationPath = readNonEmptyString(params.mapping.destinationPath);
  const relativePath = readNonEmptyString(params.mapping.relativePath);
  if (destinationPath) rawPaths.push(destinationPath);
  if (relativePath) rawPaths.push(relativePath);
  return rawPaths.map((rawPath) =>
    isAbsolute(rawPath) ? rawPath : join(params.targetMaterializedRoot, rawPath),
  );
}

export function isCodexCandidatePersistedSessionFileForResume(params: Readonly<{
  candidatePath: string;
  vendorResumeId: string;
}>): boolean {
  return isMatchingCodexRolloutFileName(basename(params.candidatePath), params.vendorResumeId);
}
