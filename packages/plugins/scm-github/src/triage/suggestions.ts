import { ScmSuggestionV1Schema, type ScmSuggestionV1 } from '@happier-dev/protocol/scm';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';

/** Read only complete suggestion fences, excluding fences nested in ordinary code blocks. */
function replacements(body: string): readonly string[] {
  const result: string[] = [];
  let fence: { marker: string; size: number; indent: number; suggestion: boolean; lines: string[] } | undefined;
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.size) {
        if (fence.suggestion) result.push(fence.lines.join('\n'));
        fence = undefined;
      } else if (fence.suggestion) {
        const indentation = /^ */.exec(line)![0].length;
        fence.lines.push(line.slice(Math.min(fence.indent, indentation)));
      }
    } else {
      const opening = /^( {0,3})(`{3,}|~{3,})([^`~]*)$/.exec(line);
      if (opening) fence = { marker: opening[2]![0]!, size: opening[2]!.length, indent: opening[1]!.length,
        suggestion: opening[3]!.trim() === 'suggestion', lines: [] };
    }
  }
  return result;
}

/** GitHub supplies the original right-side snapshot in the same review-comment response. */
export function projectGithubSuggestions(raw: Readonly<Record<string, unknown>>, diffSide: unknown): readonly ScmSuggestionV1[] {
  if (diffSide !== 'RIGHT' || typeof raw.body !== 'string' || typeof raw.diffHunk !== 'string'
    || typeof raw.originalLine !== 'number') return [];
  const startLine = raw.originalStartLine ?? raw.originalLine;
  if (typeof startLine !== 'number' || !Number.isSafeInteger(startLine) || startLine < 1
    || !Number.isSafeInteger(raw.originalLine) || raw.originalLine < startLine) return [];
  const originalCommit = raw.originalCommit;
  const commitOid = originalCommit !== null && typeof originalCommit === 'object' && 'oid' in originalCommit
    ? originalCommit.oid : undefined;
  const originalLines: string[] = [];
  for (const hunk of parseUnifiedDiffHunks(raw.diffHunk)) {
    let lineNumber = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === 'remove') continue;
      if (lineNumber >= startLine && lineNumber <= raw.originalLine) originalLines.push(line.noEol ? line.text : line.text.replace(/\r$/, ''));
      lineNumber++;
    }
  }
  if (originalLines.length !== raw.originalLine - startLine + 1) return [];
  return replacements(raw.body).flatMap(replacement => {
    const parsed = ScmSuggestionV1Schema.safeParse({ path: raw.path, commitOid, startLine,
      endLine: raw.originalLine, originalLines, replacement, outdated: raw.outdated });
    return parsed.success ? [parsed.data] : [];
  });
}
