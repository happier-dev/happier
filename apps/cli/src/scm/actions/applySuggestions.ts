import { createHash } from 'node:crypto';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import type { ScmSuggestionApplyRequest, ScmSuggestionApplyResponse, ScmSuggestionV1 } from '@happier-dev/protocol/scm';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { ScmBackendRegistry } from '@/scm/registry';
import { runScmRoute } from '@/scm/rpc/dispatch';

type FileResult = ScmSuggestionApplyResponse['files'][number];
function refused(path: string, errorCode: Extract<FileResult, { status: 'refused' }>['errorCode'], error: string): FileResult {
  return { path, status: 'refused', errorCode, error };
}

/** One verified preimage and one existing atomic file replacement for each file. */
async function applyFile(path: string, absolutePath: string, suggestions: readonly ScmSuggestionV1[]): Promise<FileResult> {
  if (suggestions.some(suggestion => suggestion.outdated)) return refused(path, 'suggestion_outdated', 'The review suggestion is outdated.');
  const ordered = [...suggestions].sort((a, b) => a.startLine - b.startLine);
  if (ordered.some((suggestion, index) => index > 0 && suggestion.startLine <= ordered[index - 1]!.endLine)) {
    return refused(path, 'suggestion_conflict', 'Suggestions overlap in this file.');
  }
  let bytes: Buffer;
  try { bytes = await currentWorkspaceSource().readFile(absolutePath); }
  catch { return refused(path, 'suggestion_conflict', 'The original file is unavailable.'); }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return refused(path, 'suggestion_conflict', 'The file is not UTF-8 text.');
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  const offsets = [0];
  for (let offset = 0; offset < text.length; offset++) if (text[offset] === '\n') offsets.push(offset + 1);
  for (const suggestion of ordered) {
    if (suggestion.endLine > lines.length || suggestion.originalLines.some((line, index) => {
      const lineIndex = suggestion.startLine - 1 + index;
      const current = lines[lineIndex];
      const hasEol = lineIndex < lines.length - 1 || text.endsWith('\n');
      return (hasEol ? current?.replace(/\r$/, '') : current) !== line;
    })) {
      return refused(path, 'suggestion_conflict', 'The checkout lines no longer match the review suggestion.');
    }
  }
  const chunks: string[] = [];
  const defaultEol = text.includes('\r\n') ? '\r\n' : '\n';
  let cursor = 0;
  for (const suggestion of ordered) {
    const start = offsets[suggestion.startLine - 1]!;
    const end = offsets[suggestion.endLine] ?? text.length;
    const original = text.slice(start, end);
    const eol = original.includes('\r\n') ? '\r\n' : original.includes('\n') ? '\n' : defaultEol;
    const replacement = suggestion.replacement.replace(/\r\n/g, '\n').split('\n').join(eol);
    const inserted = replacement === '' ? '' : replacement + (original.endsWith('\n') ? eol : '');
    chunks.push(text.slice(cursor, start), inserted);
    cursor = end;
  }
  chunks.push(text.slice(cursor));
  const written = await currentWorkspaceSource().replaceFile({ destPath: absolutePath,
    expectation: createHash('sha256').update(bytes).digest('hex'), source: { kind: 'bytes', bytes: Buffer.from(chunks.join(''), 'utf8') } });
  if (!written.success) return refused(path,
    ['hash_mismatch', 'expected_file_missing', 'expected_file_absent'].includes(written.errorCode) ? 'suggestion_conflict' : 'file_replace_failed', written.error);
  return { path, status: 'applied' };
}

async function applyAtCheckout(suggestions: readonly ScmSuggestionV1[], root: string,
  assertPathAuthorized?: (path: string) => void): Promise<ScmSuggestionApplyResponse> {
  const files: FileResult[] = [];
  const groups = new Map<string, { path: string; suggestions: ScmSuggestionV1[] }>();
  for (const suggestion of suggestions) {
    const authorized = authorizeFilesystemPath({ targetPath: suggestion.path, defaultDirectory: root,
      accessPolicy: { kind: 'restrictedRoots', roots: [root] } });
    if (!authorized.valid) { files.push(refused(suggestion.path, 'invalid_path', authorized.error)); continue; }
    try { assertPathAuthorized?.(authorized.resolvedPath); }
    catch (error) { files.push(refused(suggestion.path, 'invalid_path', error instanceof Error ? error.message : 'Path is unavailable.')); continue; }
    const group = groups.get(authorized.resolvedPath);
    if (group) group.suggestions.push(suggestion);
    else groups.set(authorized.resolvedPath, { path: suggestion.path, suggestions: [suggestion] });
  }
  for (const [absolutePath, group] of groups) files.push(await applyFile(group.path, absolutePath, group.suggestions));
  return { success: files.every(file => file.status === 'applied'), files };
}

export async function applySuggestions(request: ScmSuggestionApplyRequest, context: Readonly<{
  workingDirectory: string; accessPolicy?: FilesystemAccessPolicy; registry?: ScmBackendRegistry; signal?: AbortSignal;
}>): Promise<ScmSuggestionApplyResponse> {
  const result = await runScmRoute<ScmSuggestionApplyRequest, ScmSuggestionApplyResponse | {
    success: boolean; errorCode?: string; error?: string;
  }>({ request, ...context,
    onNonRepository: ({ cwd }) => applyAtCheckout(request.suggestions, cwd),
    runWithBackend: ({ context: repository }) => applyAtCheckout(request.suggestions,
      repository.detection.rootPath ?? repository.cwd, repository.assertFilesystemPathAuthorized),
  });
  if ('files' in result) return result;
  return { success: false, files: [...new Set(request.suggestions.map(suggestion => suggestion.path))].map(path => refused(path,
    result.errorCode === 'INVALID_PATH' ? 'invalid_path' : 'file_replace_failed', result.error ?? 'Session checkout is unavailable.')) };
}
