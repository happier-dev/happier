import { basename, isAbsolute, join } from 'node:path';

import {
  findCodexRolloutFileByIdSync,
  isMatchingCodexRolloutFileName,
} from '../../../../rollout/discovery/sessionFileSearch.js';

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

const CODEX_ROLLOUT_RESUME_ID_PATTERN =
  /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

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
    includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
  }));
}

export function resolveCodexVendorResumeIdFromImportedSessionFile(
  detail: CodexImportedSessionFileDetail,
): string | null {
  const candidates = [basename(detail.sourcePath), basename(detail.destinationPath), detail.relativePath];
  for (const candidate of candidates) {
    const match = CODEX_ROLLOUT_RESUME_ID_PATTERN.exec(candidate);
    if (match) return match[1];
  }
  return null;
}

export function normalizeCodexVendorResumeId(value: unknown): string | null {
  const trimmed = readNonEmptyString(value);
  if (!trimmed) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
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

export function resolveCodexConnectedServiceCandidatePersistedSessionFile(params: Readonly<{
  metadata: unknown;
  codexHome: string;
}>): string | null {
  const metadata = readRecord(params.metadata);
  if (!metadata) return null;
  if (metadata.codexBackendMode !== 'appServer') return null;
  const vendorResumeId = normalizeCodexVendorResumeId(metadata.codexSessionId);
  if (!vendorResumeId) return null;
  const codexHome = readNonEmptyString(params.codexHome);
  if (!codexHome) return null;

  return findCodexRolloutFileByIdSync({
    sessionsRoot: join(codexHome, 'sessions'),
    vendorResumeId,
  });
}
