import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type InventoryFile, type RewritePlan, type RewriteRule } from './migrationTypes.ts';

function rewriteNamedBindings(bindings: string, namedImportMap: Readonly<Record<string, string>>): string {
  const segments = bindings.split(',');

  return segments
    .map((segment) => {
      const match = /^(\s*)(type\s+)?([A-Za-z_$][\w$]*)(\s+as\s+[A-Za-z_$][\w$]*)?(\s*)$/s.exec(segment);
      if (!match) {
        return segment;
      }

      const [, leadingWhitespace, typePrefix = '', importedName, aliasSuffix = '', trailingWhitespace] = match;
      const rewrittenName = namedImportMap[importedName] ?? importedName;
      return `${leadingWhitespace}${typePrefix}${rewrittenName}${aliasSuffix}${trailingWhitespace}`;
    })
    .join(',');
}

function rewriteImportClause(prefix: string, rule: RewriteRule): string {
  if (!rule.namedImportMap) {
    return prefix;
  }

  return prefix.replace(/\{([^}]+)\}/g, (_match, bindings: string) => `{${rewriteNamedBindings(bindings, rule.namedImportMap!)}}`);
}

function rewriteModuleStatement(content: string, rule: RewriteRule): string {
  const fromStatementPattern = /(^|\n)(\s*(?:import|export)\b[\s\S]*?\bfrom\s*)(['"])([^'"]+)(\3)/g;
  const bareImportPattern = /(^|\n)(\s*import\s*)(['"])([^'"]+)(\3)/g;

  const rewriteSpecifier = (
    _match: string,
    linePrefix: string,
    statementPrefix: string,
    quote: string,
    specifier: string,
    closingQuote: string,
  ): string => {
    if (specifier !== rule.from) {
      return `${linePrefix}${statementPrefix}${quote}${specifier}${closingQuote}`;
    }

    return `${linePrefix}${rewriteImportClause(statementPrefix, rule)}${quote}${rule.to}${closingQuote}`;
  };

  const afterFromStatements = content.replace(fromStatementPattern, rewriteSpecifier);
  return afterFromStatements.replace(bareImportPattern, (_match, linePrefix, statementPrefix, quote, specifier, closingQuote) => {
    if (specifier !== rule.from) {
      return `${linePrefix}${statementPrefix}${quote}${specifier}${closingQuote}`;
    }

    return `${linePrefix}${statementPrefix}${quote}${rule.to}${closingQuote}`;
  });
}

function rewriteImportSpecifier(content: string, rule: RewriteRule): string {
  return rewriteModuleStatement(content, rule);
}

export function planImportRewrites(files: readonly InventoryFile[], rules: readonly RewriteRule[]): RewritePlan {
  const edits = files.flatMap((file) => {
    const after = rules.reduce((current, rule) => rewriteImportSpecifier(current, rule), file.content);
    if (after === file.content) {
      return [];
    }

    return [
      {
        filePath: file.filePath,
        before: file.content,
        after,
      },
    ];
  });

  return { edits };
}

export function planImportRewritesForFilePaths(
  files: readonly InventoryFile[],
  rules: readonly RewriteRule[],
  targetFilePaths: readonly string[],
): RewritePlan {
  const targetPaths = new Set(targetFilePaths);
  return planImportRewrites(
    files.filter((file) => targetPaths.has(file.filePath)),
    rules,
  );
}

export interface RewritePlanApplySkippedEdit {
  filePath: string;
  reason: 'missing-file' | 'content-mismatch';
}

export interface RewritePlanApplyResult {
  appliedEdits: readonly RewritePlan['edits'];
  skippedEdits: readonly RewritePlanApplySkippedEdit[];
}

export function applyRewritePlan(rootDir: string, plan: RewritePlan): RewritePlanApplyResult {
  const appliedEdits: RewritePlan['edits'] = [];
  const skippedEdits: RewritePlanApplySkippedEdit[] = [];

  for (const edit of plan.edits) {
    const absolutePath = join(rootDir, edit.filePath);
    if (!existsSync(absolutePath)) {
      skippedEdits.push({ filePath: edit.filePath, reason: 'missing-file' });
      continue;
    }

    const current = readFileSync(absolutePath, 'utf8');
    if (current !== edit.before) {
      skippedEdits.push({ filePath: edit.filePath, reason: 'content-mismatch' });
      continue;
    }

    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, edit.after, 'utf8');
    appliedEdits.push(edit);
  }

  return { appliedEdits, skippedEdits };
}
