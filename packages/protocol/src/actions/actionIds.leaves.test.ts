import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('Action id initialization boundary', () => {
  it('loads every imported id family through an acyclic graph of import-free leaves', () => {
    const registry = fileURLToPath(new URL('./actionIds.ts', import.meta.url));
    const violations: string[] = [];
    const visited = new Set<string>();

    function runtimeDependencies(file: string) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      return source.statements.flatMap(statement => {
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.isTypeOnly) return [];
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
            && !clause.name && clause.namedBindings.elements.length > 0
            && clause.namedBindings.elements.every(element => element.isTypeOnly)) return [];
          return [{ specifier: (statement.moduleSpecifier as ts.StringLiteral).text, clause }];
        }
        if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)
            && statement.exportClause.elements.length > 0
            && statement.exportClause.elements.every(element => element.isTypeOnly)) return [];
          return [{ specifier: (statement.moduleSpecifier as ts.StringLiteral).text, clause: undefined }];
        }
        return [];
      });
    }

    function visit(file: string, ancestors: readonly string[]) {
      if (ancestors.includes(file)) {
        violations.push(`cycle: ${[...ancestors, file].join(' -> ')}`);
        return;
      }
      if (visited.has(file)) return;
      visited.add(file);
      for (const { specifier } of runtimeDependencies(file)) {
        if (!specifier.startsWith('.')) {
          violations.push(`${file}: runtime dependency ${specifier}`);
        } else {
          visit(resolve(dirname(file), specifier.replace(/\.js$/u, '.ts')), [...ancestors, file]);
        }
      }
    }

    for (const { specifier } of runtimeDependencies(registry)) {
      // These primitives build the registry's own schemas; every other import supplies identity.
      if (specifier === 'zod/mini' || specifier === '../lazyZodSchema.js') continue;
      visit(resolve(dirname(registry), specifier.replace(/\.js$/u, '.ts')), [registry]);
    }
    expect(visited.size).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
