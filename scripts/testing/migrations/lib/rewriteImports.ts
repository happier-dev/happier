import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';

import {
  type DeclarationRewriteAction,
  type DeclarationRewriteRow,
  type InventoryFile,
  type RewritePlan,
  type RewriteRule,
} from './migrationTypes.ts';

export type DeclarationRewriteRefusalReason =
  | 'bare-import'
  | 'default-import'
  | 'dynamic-import'
  | 'import-type'
  | 'namespace-import'
  | 'namespace-export'
  | 'unknown-symbol'
  | 'invalid-safe-row'
  | Extract<DeclarationRewriteAction, 'internalize' | 'delete' | 'manual_semantic_migration'>;

export interface DeclarationRewriteRefusal {
  filePath: string;
  sourceSpecifier: string;
  symbol: string;
  reason: DeclarationRewriteRefusalReason;
  owner: string | null;
  detail?: string;
}

export interface DeclarationRewriteMatch {
  filePath: string;
  sourceSpecifier: string;
  sourceSymbol: string;
  targetSpecifier: string | null;
  targetSymbol: string | null;
  action: DeclarationRewriteAction;
  owner: string;
  status: 'safe-edit' | 'retained' | 'refused' | 'blocked-by-declaration-refusal';
}

export interface DeclarationRangeEdit {
  filePath: string;
  start: number;
  end: number;
  before: string;
  after: string;
}

export interface DeclarationRewritePlan extends RewritePlan {
  declarationEdits: readonly DeclarationRangeEdit[];
  matches: readonly DeclarationRewriteMatch[];
  refusals: readonly DeclarationRewriteRefusal[];
}

interface PlannedBinding {
  row: DeclarationRewriteRow;
  element: ts.ImportSpecifier | ts.ExportSpecifier;
  rendered: string;
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function replaceRange(value: string, start: number, end: number, replacement: string): string {
  return `${value.slice(0, start)}${replacement}${value.slice(end)}`;
}

function renderImportSpecifier(
  sourceText: string,
  element: ts.ImportSpecifier,
  row: DeclarationRewriteRow,
): string {
  const elementStart = element.getStart();
  const original = sourceText.slice(elementStart, element.end);
  const importedName = element.propertyName ?? element.name;
  if (row.targetSymbol === importedName.text) {
    return original;
  }

  const replacement = element.propertyName
    ? row.targetSymbol!
    : `${row.targetSymbol!} as ${element.name.text}`;
  return replaceRange(
    original,
    importedName.getStart() - elementStart,
    importedName.end - elementStart,
    replacement,
  );
}

function renderExportSpecifier(
  sourceText: string,
  element: ts.ExportSpecifier,
  row: DeclarationRewriteRow,
): string {
  const elementStart = element.getStart();
  const original = sourceText.slice(elementStart, element.end);
  const sourceName = element.propertyName ?? element.name;
  if (row.targetSymbol === sourceName.text) {
    return original;
  }

  return replaceRange(
    original,
    sourceName.getStart() - elementStart,
    sourceName.end - elementStart,
    row.targetSymbol!,
  );
}

function quoteModuleSpecifier(sourceText: string, literal: ts.StringLiteral, value: string): string {
  const original = sourceText.slice(literal.getStart(), literal.end);
  const quote = original.startsWith('"') ? '"' : "'";
  return `${quote}${value}${quote}`;
}

function getIndent(sourceText: string, position: number): string {
  const lineStart = sourceText.lastIndexOf('\n', position - 1) + 1;
  const prefix = sourceText.slice(lineStart, position);
  return /^\s*$/.test(prefix) ? prefix : '';
}

function groupBindingsByTarget(bindings: readonly PlannedBinding[]): Map<string, PlannedBinding[]> {
  const groups = new Map<string, PlannedBinding[]>();
  for (const binding of bindings) {
    const target = binding.row.targetSpecifier!;
    const group = groups.get(target);
    if (group) {
      group.push(binding);
    } else {
      groups.set(target, [binding]);
    }
  }
  return groups;
}

function splitInterElementTrivia(value: string): { trailing: string; leading: string } {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    value,
  );
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    if (scanner.getToken() === ts.SyntaxKind.CommaToken) {
      return {
        trailing: value.slice(0, scanner.getTokenPos()),
        leading: value.slice(scanner.getTextPos()),
      };
    }
  }
  throw new Error('Named import/export elements must have a comma separator');
}

function renderNamedBindings(
  sourceText: string,
  namedBindings: ts.NamedImports | ts.NamedExports,
  bindings: readonly PlannedBinding[],
): Map<string, string> {
  const leadingByElement = new Map<ts.ImportSpecifier | ts.ExportSpecifier, string>();
  const trailingByElement = new Map<ts.ImportSpecifier | ts.ExportSpecifier, string>();
  const elements = namedBindings.elements;
  const firstElement = elements[0]!;
  leadingByElement.set(
    firstElement,
    sourceText.slice(namedBindings.getStart() + 1, firstElement.getStart()),
  );
  for (let index = 1; index < elements.length; index += 1) {
    const previousElement = elements[index - 1]!;
    const element = elements[index]!;
    const trivia = splitInterElementTrivia(
      sourceText.slice(previousElement.end, element.getStart()),
    );
    trailingByElement.set(previousElement, trivia.trailing);
    leadingByElement.set(element, trivia.leading);
  }
  const lastElement = elements[elements.length - 1]!;
  trailingByElement.set(
    lastElement,
    sourceText.slice(lastElement.end, namedBindings.end - 1),
  );

  const groups = groupBindingsByTarget(bindings);
  const result = new Map<string, string>();
  for (const [target, group] of groups) {
    const body = group.map((binding) => (
      `${leadingByElement.get(binding.element) ?? ''}${binding.rendered}${trailingByElement.get(binding.element) ?? ''}`
    )).join(',');
    const ownsOriginalTail = group.some((binding) => (
      binding.element === lastElement
    ));
    const closingPadding = ownsOriginalTail || /\s$/.test(body) ? '' : ' ';
    result.set(target, `{${body}${closingPadding}}`);
  }
  return result;
}

function findRow(
  rowsBySource: ReadonlyMap<string, ReadonlyMap<string, DeclarationRewriteRow>>,
  sourceSpecifier: string,
  sourceSymbol: string,
): DeclarationRewriteRow | undefined {
  return rowsBySource.get(sourceSpecifier)?.get(sourceSymbol);
}

function isExactRetainedSpecifier(
  rowsBySource: ReadonlyMap<string, ReadonlyMap<string, DeclarationRewriteRow>>,
  sourceSpecifier: string,
): boolean {
  const rows = rowsBySource.get(sourceSpecifier);
  return rows !== undefined
    && rows.size > 0
    && [...rows.values()].every((row) => (
      row.action === 'retain'
      && row.targetSpecifier === row.sourceSpecifier
      && row.targetSymbol === row.sourceSymbol
    ));
}

function refusalForRow(
  filePath: string,
  row: DeclarationRewriteRow,
): DeclarationRewriteRefusal | null {
  if (row.action === 'internalize' || row.action === 'delete' || row.action === 'manual_semantic_migration') {
    return {
      filePath,
      sourceSpecifier: row.sourceSpecifier,
      symbol: row.sourceSymbol,
      reason: row.action,
      owner: row.owner,
      detail: row.reason,
    };
  }
  if (
    row.action === 'retain'
    && (row.targetSpecifier !== row.sourceSpecifier || row.targetSymbol !== row.sourceSymbol)
  ) {
    return {
      filePath,
      sourceSpecifier: row.sourceSpecifier,
      symbol: row.sourceSymbol,
      reason: 'invalid-safe-row',
      owner: row.owner,
      detail: 'retain row must preserve both source specifier and source symbol',
    };
  }
  if ((row.action === 'move' || row.action === 'rename') && (!row.targetSpecifier || !row.targetSymbol)) {
    return {
      filePath,
      sourceSpecifier: row.sourceSpecifier,
      symbol: row.sourceSymbol,
      reason: 'invalid-safe-row',
      owner: row.owner,
      detail: 'safe move/rename row requires a target specifier and target symbol',
    };
  }
  return null;
}

/**
 * Plans AST-discovered, declaration-range-only import/re-export rewrites.
 *
 * The semantic row set remains external to this generic owner. This function never
 * infers a rename, rewrites non-declaration strings, or applies a refused declaration.
 */
export function planDeclarationRewrites(
  files: readonly InventoryFile[],
  rows: readonly DeclarationRewriteRow[],
): DeclarationRewritePlan {
  const rowsBySource = new Map<string, Map<string, DeclarationRewriteRow>>();
  for (const row of rows) {
    const bySymbol = rowsBySource.get(row.sourceSpecifier) ?? new Map<string, DeclarationRewriteRow>();
    if (bySymbol.has(row.sourceSymbol)) {
      throw new Error(`Duplicate declaration rewrite row: ${row.sourceSpecifier}#${row.sourceSymbol}`);
    }
    bySymbol.set(row.sourceSymbol, row);
    rowsBySource.set(row.sourceSpecifier, bySymbol);
  }

  const declarationEdits: DeclarationRangeEdit[] = [];
  const matches: DeclarationRewriteMatch[] = [];
  const refusals: DeclarationRewriteRefusal[] = [];
  const edits = files.flatMap((file) => {
    const fileRefusalStart = refusals.length;
    const fileMatchStart = matches.length;
    const sourceFile = ts.createSourceFile(
      file.filePath,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(file.filePath),
    );
    const fileDeclarationEdits: DeclarationRangeEdit[] = [];

    const reportNonDeclarationImports = (node: ts.Node): void => {
      if (
        ts.isImportTypeNode(node)
        && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteral(node.argument.literal)
        && rowsBySource.has(node.argument.literal.text)
      ) {
        const sourceSpecifier = node.argument.literal.text;
        const sourceSymbol = node.qualifier?.getText(sourceFile) ?? '(import-type)';
        const row = findRow(rowsBySource, sourceSpecifier, sourceSymbol);
        const rowRefusal = row ? refusalForRow(file.filePath, row) : null;
        if (row) {
          matches.push({
            filePath: file.filePath,
            sourceSpecifier,
            sourceSymbol,
            targetSpecifier: row.targetSpecifier,
            targetSymbol: row.targetSymbol,
            action: row.action,
            owner: row.owner,
            status: rowRefusal ? 'refused' : row.action === 'retain' ? 'retained' : 'safe-edit',
          });
        }
        if (rowRefusal) {
          refusals.push(rowRefusal);
        } else if (
          (!row || row.action !== 'retain')
          && !isExactRetainedSpecifier(rowsBySource, sourceSpecifier)
        ) {
          refusals.push({
            filePath: file.filePath,
            sourceSpecifier,
            symbol: sourceSymbol,
            reason: 'import-type',
            owner: row?.owner ?? null,
          });
        }
      } else if (
        ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length > 0
        && ts.isStringLiteral(node.arguments[0]!)
        && rowsBySource.has(node.arguments[0]!.text)
      ) {
        const sourceSpecifier = node.arguments[0]!.text;
        if (!isExactRetainedSpecifier(rowsBySource, sourceSpecifier)) {
          refusals.push({
            filePath: file.filePath,
            sourceSpecifier,
            symbol: '(dynamic-import)',
            reason: 'dynamic-import',
            owner: null,
          });
        }
      }
      ts.forEachChild(node, reportNonDeclarationImports);
    };
    reportNonDeclarationImports(sourceFile);

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const sourceSpecifier = statement.moduleSpecifier.text;
      if (!rowsBySource.has(sourceSpecifier)) continue;

      let namedBindings: ts.NamedImports | ts.NamedExports | null = null;
      let clauseIsTypeOnly = false;
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause) {
          if (isExactRetainedSpecifier(rowsBySource, sourceSpecifier)) continue;
          refusals.push({ filePath: file.filePath, sourceSpecifier, symbol: '(side-effect)', reason: 'bare-import', owner: null });
          continue;
        }
        if (clause.name) {
          if (isExactRetainedSpecifier(rowsBySource, sourceSpecifier)) continue;
          refusals.push({ filePath: file.filePath, sourceSpecifier, symbol: 'default', reason: 'default-import', owner: null });
          continue;
        }
        clauseIsTypeOnly = clause.isTypeOnly;
        if (!clause.namedBindings) {
          if (isExactRetainedSpecifier(rowsBySource, sourceSpecifier)) continue;
          refusals.push({ filePath: file.filePath, sourceSpecifier, symbol: '(side-effect)', reason: 'bare-import', owner: null });
          continue;
        }
        if (ts.isNamespaceImport(clause.namedBindings)) {
          if (isExactRetainedSpecifier(rowsBySource, sourceSpecifier)) continue;
          refusals.push({ filePath: file.filePath, sourceSpecifier, symbol: '*', reason: 'namespace-import', owner: null });
          continue;
        }
        namedBindings = clause.namedBindings;
      } else {
        clauseIsTypeOnly = statement.isTypeOnly;
        if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
          if (isExactRetainedSpecifier(rowsBySource, sourceSpecifier)) continue;
          refusals.push({ filePath: file.filePath, sourceSpecifier, symbol: '*', reason: 'namespace-export', owner: null });
          continue;
        }
        namedBindings = statement.exportClause;
      }

      if (namedBindings.elements.length === 0) {
        if (isExactRetainedSpecifier(rowsBySource, sourceSpecifier)) continue;
        refusals.push({
          filePath: file.filePath,
          sourceSpecifier,
          symbol: '(empty)',
          reason: 'unknown-symbol',
          owner: null,
        });
        continue;
      }

      const plannedBindings: PlannedBinding[] = [];
      const statementRefusals: DeclarationRewriteRefusal[] = [];
      const statementMatchStart = matches.length;
      for (const element of namedBindings.elements) {
        const sourceSymbol = (element.propertyName ?? element.name).text;
        const row = findRow(rowsBySource, sourceSpecifier, sourceSymbol);
        if (!row) {
          statementRefusals.push({ filePath: file.filePath, sourceSpecifier, symbol: sourceSymbol, reason: 'unknown-symbol', owner: null });
          continue;
        }
        const refusal = refusalForRow(file.filePath, row);
        matches.push({
          filePath: file.filePath,
          sourceSpecifier,
          sourceSymbol,
          targetSpecifier: row.targetSpecifier,
          targetSymbol: row.targetSymbol,
          action: row.action,
          owner: row.owner,
          status: refusal ? 'refused' : row.action === 'retain' ? 'retained' : 'safe-edit',
        });
        if (refusal) {
          statementRefusals.push(refusal);
          continue;
        }
        const plannedRow: DeclarationRewriteRow = row.action === 'retain'
          ? {
              ...row,
              targetSpecifier: sourceSpecifier,
              targetSymbol: sourceSymbol,
            }
          : row;
        plannedBindings.push({
          row: plannedRow,
          element,
          rendered: ts.isImportSpecifier(element)
            ? renderImportSpecifier(file.content, element, plannedRow)
            : renderExportSpecifier(file.content, element, plannedRow),
        });
      }
      if (statementRefusals.length > 0) {
        for (let index = statementMatchStart; index < matches.length; index += 1) {
          const match = matches[index]!;
          if (match.status === 'safe-edit') {
            matches[index] = { ...match, status: 'blocked-by-declaration-refusal' };
          }
        }
        refusals.push(...statementRefusals);
        continue;
      }
      if (plannedBindings.length === 0) continue;

      const renderedBindings = renderNamedBindings(file.content, namedBindings, plannedBindings);
      const moduleTail = file.content.slice(statement.moduleSpecifier.end, statement.end);
      const indent = getIndent(file.content, statement.getStart());
      const renderedDeclarations = [...renderedBindings.entries()].map(([targetSpecifier, bindings]) => {
        const moduleSpecifier = quoteModuleSpecifier(file.content, statement.moduleSpecifier as ts.StringLiteral, targetSpecifier);
        if (ts.isImportDeclaration(statement)) {
          return `import ${clauseIsTypeOnly ? 'type ' : ''}${bindings} from ${moduleSpecifier}${moduleTail}`;
        }
        return `export ${clauseIsTypeOnly ? 'type ' : ''}${bindings} from ${moduleSpecifier}${moduleTail}`;
      });
      const start = statement.getStart();
      const end = statement.end;
      const declarationEdit = {
        filePath: file.filePath,
        start,
        end,
        before: file.content.slice(start, end),
        after: renderedDeclarations.join(`\n${indent}`),
      };
      if (declarationEdit.before !== declarationEdit.after) {
        fileDeclarationEdits.push(declarationEdit);
      }
    }

    if (refusals.length > fileRefusalStart) {
      for (let index = fileMatchStart; index < matches.length; index += 1) {
        const match = matches[index]!;
        if (match.status === 'safe-edit') {
          matches[index] = { ...match, status: 'blocked-by-declaration-refusal' };
        }
      }
      return [];
    }
    if (fileDeclarationEdits.length === 0) return [];
    declarationEdits.push(...fileDeclarationEdits);
    const after = [...fileDeclarationEdits]
      .sort((left, right) => right.start - left.start)
      .reduce((current, edit) => (
        `${current.slice(0, edit.start)}${edit.after}${current.slice(edit.end)}`
      ), file.content);
    return [{ filePath: file.filePath, before: file.content, after }];
  });

  return { edits, declarationEdits, matches, refusals };
}

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
  appliedEdits: RewritePlan['edits'];
  skippedEdits: readonly RewritePlanApplySkippedEdit[];
}

export function applyRewritePlan(rootDir: string, plan: RewritePlan): RewritePlanApplyResult {
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
    }
  }

  if (skippedEdits.length > 0) {
    return { appliedEdits: [], skippedEdits };
  }

  for (const edit of plan.edits) {
    const absolutePath = join(rootDir, edit.filePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, edit.after, 'utf8');
  }

  return { appliedEdits: plan.edits, skippedEdits };
}
