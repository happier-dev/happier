import { createTwoFilesPatch } from 'diff';
import type { WorkspaceFileEditSetFile } from '@happier-dev/protocol/machines/workspaceFiles';
import { applyWorkspaceFileTextEdits } from '@happier-dev/protocol/machines/workspaceFilesReplace';

/**
 * One reviewed file of a semantic edit set (rename, file rename, code fix) as the shared review
 * renderer shows it: a unified patch of what the Machine's guarded writer will write, built with the
 * writer's own text transform. Null when the text on hand does not take the edits (it moved on since
 * the preview, or is not the text the server read); the writer's hash guard still decides the apply.
 */
export function buildEditSetPreviewDiff(
  file: WorkspaceFileEditSetFile,
  text: string,
): string | null {
  try {
    const next = applyWorkspaceFileTextEdits(text, file.edits).text;
    const to = file.renameTo ?? file.path;
    return createTwoFilesPatch(file.path, to, text, next, '', '', {
      context: 2,
    });
  } catch {
    return null;
  }
}

/**
 * One file's changes as its review shows them: edits that touch the same lines are one change (a
 * formatter answers one reflowed line as many small whitespace edits), and a move counts once.
 */
export function countEditSetFileChanges(file: WorkspaceFileEditSetFile): number {
  const spans = file.edits
    .map((edit) => [edit.range.start.line, edit.range.end.line] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let changes = 0;
  let lastLine = -1;
  for (const [start, end] of spans) {
    if (changes === 0 || start > lastLine) changes += 1;
    lastLine = Math.max(lastLine, end);
  }
  return changes + (file.renameTo ? 1 : 0);
}

/** "4 changes in 2 files", each file counted as `countEditSetFileChanges`. */
export function countEditSetChanges(
  files: readonly WorkspaceFileEditSetFile[],
): Readonly<{ changes: number; files: number }> {
  let changes = 0;
  for (const file of files) changes += countEditSetFileChanges(file);
  return { changes, files: files.length };
}
