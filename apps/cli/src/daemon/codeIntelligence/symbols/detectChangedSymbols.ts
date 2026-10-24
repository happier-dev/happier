import type { CodeIntelligenceChangedSymbolV1 } from '@happier-dev/protocol';

import type { FileHunks, LineRange } from '../git/observedGit';
import { scanDeclarations, type ScannedDeclaration } from './declarationScan';

function innermostContaining(declarations: readonly ScannedDeclaration[], line: number): ScannedDeclaration | null {
  let best: ScannedDeclaration | null = null;
  for (const declaration of declarations) {
    if (line < declaration.startLine || line > declaration.endLine) continue;
    if (!best || declaration.endLine - declaration.startLine < best.endLine - best.startLine) best = declaration;
  }
  return best;
}

function hitDeclarations(declarations: readonly ScannedDeclaration[], ranges: readonly LineRange[]): Set<ScannedDeclaration> {
  const hits = new Set<ScannedDeclaration>();
  for (const range of ranges) {
    for (let line = range.start; line <= range.end; line += 1) {
      const declaration = innermostContaining(declarations, line);
      if (declaration) hits.add(declaration);
    }
  }
  return hits;
}

function toChangedSymbol(
  path: string,
  declaration: ScannedDeclaration,
  changeKind: CodeIntelligenceChangedSymbolV1['changeKind'],
): CodeIntelligenceChangedSymbolV1 {
  return {
    filePath: path,
    name: declaration.name,
    kind: declaration.kind,
    startLine: declaration.startLine,
    endLine: declaration.endLine,
    changeKind,
    accuracy: 'declaration_scan',
  };
}

/**
 * Maps a file's changed line ranges onto scanned declarations. A changed line belongs to the
 * innermost declaration containing it; a declaration only on the new side is `added`, only on the
 * old side `deleted`. Line ranges for added and deleted symbols are reported on their own side.
 */
export function detectChangedSymbols(input: Readonly<{
  path: string;
  oldContent: string | null;
  newContent: string | null;
  hunks: FileHunks;
}>): CodeIntelligenceChangedSymbolV1[] {
  const oldDeclarations = input.oldContent === null ? [] : scanDeclarations({ path: input.path, content: input.oldContent });
  const newDeclarations = input.newContent === null ? [] : scanDeclarations({ path: input.path, content: input.newContent });
  const oldNames = new Set(oldDeclarations.map((declaration) => declaration.qualifiedName));
  const newNames = new Set(newDeclarations.map((declaration) => declaration.qualifiedName));

  const changed: CodeIntelligenceChangedSymbolV1[] = [];
  const reported = new Set<string>();

  const newHits = input.oldContent === null ? new Set(newDeclarations) : hitDeclarations(newDeclarations, input.hunks.newRanges);
  const oldHits = hitDeclarations(oldDeclarations, input.hunks.oldRanges);
  const modifiedFromOldSide = new Set(
    [...oldHits].filter((declaration) => newNames.has(declaration.qualifiedName)).map((declaration) => declaration.qualifiedName),
  );

  for (const declaration of newDeclarations) {
    const isHit = newHits.has(declaration) || modifiedFromOldSide.has(declaration.qualifiedName);
    if (!isHit || reported.has(declaration.qualifiedName)) continue;
    reported.add(declaration.qualifiedName);
    changed.push(toChangedSymbol(input.path, declaration, oldNames.has(declaration.qualifiedName) ? 'modified' : 'added'));
  }

  const deletedCandidates = input.newContent === null ? oldDeclarations : [...oldHits];
  for (const declaration of oldDeclarations) {
    if (!deletedCandidates.includes(declaration) || newNames.has(declaration.qualifiedName) || reported.has(declaration.qualifiedName)) continue;
    reported.add(declaration.qualifiedName);
    changed.push(toChangedSymbol(input.path, declaration, 'deleted'));
  }

  return changed;
}
