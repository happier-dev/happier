import { createHash } from 'node:crypto';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { resolve } from 'node:path';
import { getScmComparisonDiscardRestriction, type ScmChangeDiscardResultEntry, type ScmComparisonDiscardEntry, type ScmComparisonFile } from '@happier-dev/protocol/scm';
import { buildReviewUnits, buildScmChangeKeys, buildScmFileReviewUnits, locateComparisonOccurrences } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { revertHunks, type Hunk, type InverseEdit } from '@happier-dev/protocol/diff/hunks';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import type { GuardedFileReplaceResult, GuardedFileAbsenceResult } from '@/rpc/handlers/fileSystem/commitGuardedFileReplace';
import { readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import type { ScmBackend, ScmBackendContext } from '@/scm/types';

type Params = Readonly<{ entry: ScmComparisonDiscardEntry; context: ScmBackendContext; backend: ScmBackend;
  sessionId?: string }>;
export type PreparedComparisonDiscard = Readonly<{ result: ScmChangeDiscardResultEntry; undoPreimage?: Uint8Array;
  commit: () => Promise<ScmChangeDiscardResultEntry> }>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function refusedEntry(path: string, errorCode: NonNullable<ScmChangeDiscardResultEntry['errorCode']>, error: string,
  hashBefore: string | null = null): ScmChangeDiscardResultEntry {
  return { path, status: 'refused', errorCode, error, hashBefore, hashAfter: hashBefore };
}
function prepared(result: ScmChangeDiscardResultEntry, mutation?: () => Promise<GuardedFileReplaceResult | GuardedFileAbsenceResult>): PreparedComparisonDiscard {
  return { result, commit: async () => {
    if (!mutation) return result;
    const written = await mutation();
    if (!written.success) return refusedEntry(result.path,
      ['hash_mismatch', 'expected_file_missing', 'expected_file_absent'].includes(written.errorCode) ? 'FILE_CHANGED' : 'COMMAND_FAILED', written.error, result.hashBefore);
    return { ...result, hashAfter: written.hash };
  } };
}
function refused(path: string, errorCode: NonNullable<ScmChangeDiscardResultEntry['errorCode']>, error: string, hashBefore: string | null = null) {
  return prepared(refusedEntry(path, errorCode, error, hashBefore));
}

/** Inverse spans contain only changed text, never unchanged file-sized context. */
function inverseEdits(text: string, hunks: readonly Hunk[]): readonly InverseEdit[] {
  const lineOffsets = [0];
  for (let offset = 0; offset < text.length; offset++) if (text[offset] === '\n') lineOffsets.push(offset + 1);
  const edits: { startUtf16: number; insertText: string; originalText: string }[] = [];
  for (const hunk of hunks) {
    const lineText = (line: Hunk['lines'][number]) => line.text + (line.noEol ? '' : '\n');
    const before = hunk.lines.filter(line => line.kind !== 'remove').map(lineText).join('');
    const after = hunk.lines.filter(line => line.kind !== 'add').map(lineText).join('');
    const at = lineOffsets[hunk.newLines ? hunk.newStart - 1 : hunk.newStart] ?? text.length;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd--; afterEnd--; }
    edits.push({ startUtf16: at + start, insertText: after.slice(start, afterEnd), originalText: before.slice(start, beforeEnd) });
  }
  edits.sort((a, b) => a.startUtf16 - b.startUtf16);
  let offset = 0;
  return edits.map(edit => {
    const inverse = { ...edit, startUtf16: edit.startUtf16 + offset, deleteLength: edit.originalText.length };
    offset += edit.insertText.length - edit.originalText.length;
    return inverse;
  });
}

/** Resolve the complete reply before mutation, so the response owner can deliver every Undo payload. */
export async function prepareDiscardAgainstComparison(params: Params): Promise<PreparedComparisonDiscard> {
  const { entry, context, backend } = params;
  const root = context.detection.rootPath ?? context.cwd;
  const path = resolve(root, entry.path.replace(/\\/g, '/'));
  const authorized = authorizeFilesystemPath({ targetPath: path, defaultDirectory: root,
    accessPolicy: { kind: 'restrictedRoots', roots: [root] } });
  if (!authorized.valid) return refused(entry.path, 'INVALID_PATH', authorized.error);
  context.assertFilesystemPathAuthorized?.(path);
  let file: ScmComparisonFile | undefined;
  let selected: readonly Hunk[] = [];
  let current: Buffer | null;
  try { current = await currentWorkspaceSource().readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    current = null;
  }
  const hashBefore = current === null ? null : hash(current);
  if (entry.expectedHash !== undefined && entry.expectedHash !== hashBefore) return refused(entry.path, 'FILE_CHANGED', 'File content changed since it was displayed', hashBefore);
  try {
    if (entry.against.comparisonId) {
      const captured = await readCapturedScmComparison({ cwd: root, comparisonId: entry.against.comparisonId,
        source: entry.against.source, ...(params.sessionId ? { sessionId: params.sessionId } : {}) });
      file = captured.comparison.inventory.files.find(candidate => candidate.path === entry.path);
      if (!file || file.evidence.state !== 'available') return refused(entry.path, 'COMPARISON_UNAVAILABLE', 'Comparison file evidence is unavailable', hashBefore);
      const units = buildScmFileReviewUnits(file);
      const keys = entry.changeKeys ?? (entry.changeRefs ? entry.changeRefs.flatMap(ref => {
        const located = locateComparisonOccurrences(captured.comparison).located.get(ref);
        if (!located || located.file.path !== entry.path) return [''];
        return buildScmChangeKeys(captured.comparison).get(ref) ?? [''];
      }) : undefined);
      const chosen = keys ? units.filter(unit => keys.includes(unit.key)) : undefined;
      if (keys && chosen) {
        if (keys.some(key => !chosen.some(unit => unit.key === key))) return refused(entry.path, 'CHANGE_MOVED_ON', 'Selected changes no longer identify this file', hashBefore);
        selected = chosen.map(unit => unit.hunk);
      }
      const restriction = getScmComparisonDiscardRestriction({ kind: 'captured', file,
        ...(chosen ? { hunkIndexes: chosen.map(unit => unit.hunkIndex) } : {}) });
      if (restriction) return refused(entry.path, 'DISCARD_UNSUPPORTED', restriction.error, hashBefore);
    } else {
      if (entry.against.source.kind !== 'workingTree') return refused(entry.path, 'COMPARISON_UNAVAILABLE', 'Captured comparison identity is required', hashBefore);
      const snapshot = await backend.statusSnapshot({ context, request: { cwd: root } });
      if (!snapshot.success) return refused(entry.path, 'COMPARISON_UNAVAILABLE', 'Live repository status is unavailable', hashBefore);
      const working = snapshot.snapshot?.entries.find(candidate => candidate.path === entry.path);
      const restriction = getScmComparisonDiscardRestriction({ kind: 'live', entry: working, hunks: !!entry.changeKeys });
      if (restriction) return refused(entry.path, 'DISCARD_UNSUPPORTED', restriction.error, hashBefore);
      if (entry.changeKeys) {
        const diff = await backend.diffFile?.({ context, request: { cwd: root, path: entry.path, area: 'both' } });
        if (!diff?.success || diff.diff === undefined) return refused(entry.path, 'COMPARISON_UNAVAILABLE', 'Live diff is unavailable', hashBefore);
        const chosen = buildReviewUnits(entry.path, 'combined', diff.diff).filter(unit => entry.changeKeys!.includes(unit.key));
        if (entry.changeKeys.some(key => !chosen.some(unit => unit.key === key))) return refused(entry.path, 'CHANGE_MOVED_ON', 'Selected changes no longer identify the live diff', hashBefore);
        selected = chosen.map(unit => unit.hunk);
      }
    }
  } catch { return refused(entry.path, 'COMPARISON_UNAVAILABLE', 'Captured comparison is unavailable for this caller', hashBefore); }
  const unitArm = !!(entry.changeKeys || entry.changeRefs);
  let replacement: Buffer;
  let undo: readonly InverseEdit[] | undefined;
  let previous: ScmChangeDiscardResultEntry['previous'];
  if (file?.changeKind === 'added' && !file.beforeBlobId) {
    const after = file.afterBlobId ? await backend.fileAtRevision?.({ context, request: { cwd: root,
      path: entry.path, selector: { blobId: file.afterBlobId } } }) : undefined;
    if (!after?.success) return refused(entry.path, 'COMPARISON_UNAVAILABLE', 'Comparison after bytes are unavailable', hashBefore);
    if (current === null || !current.equals(Buffer.from(after.contentBase64, 'base64'))) {
      return prepared({ path: entry.path, status: 'kept_edited', hashBefore, hashAfter: hashBefore });
    }
    if (entry.includeUndo) {
      previous = { inlineBase64: current.toString('base64') };
    }
    return prepared({ path: entry.path, status: 'deleted', hashBefore, hashAfter: null, ...(previous ? { previous } : {}) }, async () => {
      context.signal?.throwIfAborted();
      await context.beforeFilesystemMutation?.();
      return await currentWorkspaceSource().replaceFile({ destPath: path, expectation: hashBefore, source: { kind: 'absent' } });
    });
  }
  if (file && !file.beforeBlobId) return refused(entry.path, 'COMPARISON_UNAVAILABLE', 'Comparison before bytes are unavailable', hashBefore);
  if (unitArm) {
    if ((current === null && file?.changeKind !== 'deleted') || selected.length === 0) return refused(entry.path, 'CHANGE_MOVED_ON', 'The file no longer contains these changes', hashBefore);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(current ?? new Uint8Array()); }
    catch { return refused(entry.path, 'DISCARD_UNSUPPORTED', 'Hunk discard requires valid UTF-8', hashBefore); }
    const result = revertHunks(text, selected);
    if (!result.ok) return refused(entry.path, 'CHANGE_MOVED_ON', 'The file changed. Review it again.', hashBefore);
    replacement = Buffer.from(result.text, 'utf8');
    if (entry.includeUndo && current !== null) {
      undo = inverseEdits(text, selected);
    }
  } else {
    const response = await backend.fileAtRevision?.({ context, request: { cwd: root, path: entry.path,
      selector: file?.beforeBlobId ? { blobId: file.beforeBlobId } : { side: 'before', area: 'both' } } });
    if (!response?.success) return refused(entry.path, 'COMPARISON_UNAVAILABLE', 'Comparison before bytes are unavailable', hashBefore);
    replacement = Buffer.from(response.contentBase64, 'base64');
    if (entry.includeUndo && current !== null) {
      previous = { inlineBase64: current.toString('base64') };
    }
  }
  const operation = prepared({ path: entry.path, status: current === null ? 'recreated' : unitArm ? 'reverted' : 'restored', hashBefore, hashAfter: hash(replacement),
    ...(undo ? { inverseEdits: [...undo] } : {}), ...(previous ? { previous } : {}) }, async () => {
    context.signal?.throwIfAborted();
    await context.beforeFilesystemMutation?.();
    return await currentWorkspaceSource().replaceFile({ destPath: path, expectation: hashBefore, source: { kind: 'bytes', bytes: replacement } });
  });
  return undo && current !== null ? { ...operation, undoPreimage: current } : operation;
}
