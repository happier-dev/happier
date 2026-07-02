import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const ALLOWED_RELATIVE_IMPORT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.js',
  '.json',
  '.mjs',
  '.node',
  '.sass',
  '.scss',
]);

function listProductionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      return listProductionTypeScriptFiles(path);
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) return [];
    return [path];
  });
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function hasRuntimeResolvableExtension(specifier: string): boolean {
  return ALLOWED_RELATIVE_IMPORT_EXTENSIONS.has(extname(specifier));
}

function collectRelativeModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

describe('Claude plugin ESM imports', () => {
  it('uses explicit runtime extensions for production relative imports', () => {
    const violations = listProductionTypeScriptFiles(SOURCE_ROOT).flatMap((path) => {
      const sourceText = readFileSync(path, 'utf8');
      const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
      return collectRelativeModuleSpecifiers(sourceFile)
        .filter((specifier) => isRelativeSpecifier(specifier) && !hasRuntimeResolvableExtension(specifier))
        .map((specifier) => `${relative(SOURCE_ROOT, path)} -> ${specifier}`);
    });

    expect(violations).toEqual([]);
  });

  it('does not import Claude executable message-meta shaping from the shared agents package', () => {
    const violations = listProductionTypeScriptFiles(SOURCE_ROOT).flatMap((path) => {
      const sourceText = readFileSync(path, 'utf8');
      const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
      const fileViolations: string[] = [];

      function visit(node: ts.Node): void {
        if (
          ts.isImportDeclaration(node)
          && node.moduleSpecifier
          && ts.isStringLiteral(node.moduleSpecifier)
          && node.moduleSpecifier.text === '@happier-dev/agents'
          && node.importClause?.namedBindings
          && ts.isNamedImports(node.importClause.namedBindings)
        ) {
          for (const element of node.importClause.namedBindings.elements) {
            if (element.name.text === 'buildClaudeRemoteOutgoingMessageMetaExtras') {
              fileViolations.push(relative(SOURCE_ROOT, path));
            }
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      return fileViolations;
    });

    expect(violations).toEqual([]);
  });
});
