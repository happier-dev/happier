import { resolve } from 'node:path';

import type { ReviewFinding } from '@happier-dev/protocol/reviews/ReviewFinding';
import type { ScmChangeOccurrence, ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { parseUnifiedDiffHunks } from '@happier-dev/protocol/diff/hunks';

type ScopeAttribution = NonNullable<ReviewFinding['scopeAttribution']>;

/** Index only captured after-side locations; unresolved evidence never consults the checkout. */
export function createReviewScopeAttribution(comparison: ScmComparison | undefined): (finding: ReviewFinding) => ScopeAttribution {
  const files = new Map<string, ReadonlyMap<number, ScopeAttribution>>();
  const duplicates = new Set<string>();
  if (comparison?.inventory.state === 'complete' && comparison.endpoints.before && comparison.endpoints.after) {
    for (const file of comparison.inventory.files) {
      const path = resolve(comparison.repository.rootPath, file.path);
      if (files.has(path)) { duplicates.add(path); continue; }
      const locations = new Map<number, ScopeAttribution>();
      files.set(path, locations);
      if (file.evidence.state !== 'available' || file.binary !== false) continue;
      const hunks = parseUnifiedDiffHunks(file.evidence.unifiedDiff);
      const beforeText = new Set(hunks.flatMap(hunk => hunk.lines.filter(line => line.kind !== 'add').map(line => line.text)));
      const occurrenceKey = (before: Readonly<{ startLine: number; lineCount: number }>,
        after: Readonly<{ startLine: number; lineCount: number }>) => `${before.startLine}:${before.lineCount}:${after.startLine}:${after.lineCount}`;
      const occurrences = new Map<string, ScmChangeOccurrence | null>();
      for (const occurrence of file.occurrences) {
        const key = occurrenceKey(occurrence.before, occurrence.after);
        occurrences.set(key, occurrences.has(key) ? null : occurrence);
      }
      for (const hunk of hunks) {
        const occurrence = occurrences.get(occurrenceKey({ startLine: hunk.oldStart, lineCount: hunk.oldLines },
          { startLine: hunk.newStart, lineCount: hunk.newLines }));
        if (!occurrence || occurrence.evidence?.state === 'unavailable'
          || (occurrence.layer !== undefined && occurrence.layer !== 'combined')
          || (file.beforeBlobId && occurrence.beforeBlobId && file.beforeBlobId !== occurrence.beforeBlobId)
          || (file.afterBlobId && occurrence.afterBlobId && file.afterBlobId !== occurrence.afterBlobId)
          || hunk.lines.filter(line => line.kind !== 'add').length !== hunk.oldLines
          || hunk.lines.filter(line => line.kind !== 'remove').length !== hunk.newLines) {
          locations.clear();
          break;
        }
        let afterLine = hunk.newStart;
        for (const line of hunk.lines) {
          if (line.kind === 'remove') continue;
          const attribution = line.kind === 'context' ? 'pre_existing'
            : beforeText.has(line.text) ? 'unknown' : 'in_selected_changes';
          const previous = locations.get(afterLine);
          locations.set(afterLine, previous && previous !== attribution ? 'unknown' : attribution);
          afterLine++;
        }
      }
    }
  }
  return finding => {
    if (!comparison || !finding.filePath || finding.startLine === undefined) return 'unknown';
    const path = resolve(comparison.repository.rootPath, finding.filePath);
    if (duplicates.has(path)) return 'unknown';
    const locations = files.get(path);
    const endLine = finding.endLine ?? finding.startLine;
    if (!locations || endLine < finding.startLine) return 'unknown';
    const attribution = locations.get(finding.startLine);
    if (!attribution || attribution === 'unknown') return 'unknown';
    for (let line = finding.startLine; line <= endLine; line++) {
      if (locations.get(line) !== attribution) return 'unknown';
    }
    return attribution;
  };
}
