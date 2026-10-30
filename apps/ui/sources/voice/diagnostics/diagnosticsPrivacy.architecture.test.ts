import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

function valueImports(text: string, path: string) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return source.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const clause = statement.importClause;
    if (clause?.isTypeOnly) return [];
    const bindings = clause?.namedBindings;
    const named = bindings && ts.isNamedImports(bindings) ? bindings.elements : null;
    if (!clause?.name && named && named.length > 0 && named.every(binding => binding.isTypeOnly)) return [];
    return [{
      module: statement.moduleSpecifier.text,
      names: [
        ...(clause?.name ? [clause.name.text] : []),
        ...(named ? named.filter(binding => !binding.isTypeOnly).flatMap(binding => [binding.propertyName?.text ?? binding.name.text, binding.name.text])
          : bindings && ts.isNamespaceImport(bindings) ? [bindings.name.text] : []),
      ],
    }];
  });
}

describe('local speech diagnostics privacy boundary', () => {
  it('does not import sync upload, analytics, crash-report, or provider-context owners', () => {
    expect(valueImports(`
      // import 'comment-only';
      const example = "import 'string-only'";
      import type { Ignored } from 'type-only';
      import { type AlsoIgnored } from 'named-type-only';
      import {
        type IgnoredAlongsideValue,
        live as renamed,
      } from 'multiline-value';
      import 'side-effect';
      import DefaultValue, { type OtherType } from 'default-value';
    `, 'import-control.ts').map(edge => edge.module)).toEqual(['multiline-value', 'side-effect', 'default-value']);
    const files = sourceFiles(join(process.cwd(), 'sources/voice/diagnostics'))
      .filter((path) => !/\.(?:test|spec)\.tsx?$/.test(path));
    const allowedEncryptedDownloadOwners = [
      '@/sync/domains/transfers/runtime/transferRuntime/carriers/downloadBulkPayloadViaMachineRpcToDestination',
      '@/sync/domains/transfers/runtime/transferRuntime/plumbing/bulkTransferFileDestination',
    ];
    const forbidden = [
      '@/sync/domains/transfers',
      '@/sync/api',
      '@/utils/system/sentry',
      '@/voice/context',
      'analytics',
      'crashReport',
    ];
    for (const file of files) {
      const imports = valueImports(readFileSync(file, 'utf8'), file)
        .filter(edge => !allowedEncryptedDownloadOwners.includes(edge.module))
        .flatMap(edge => [edge.module, ...edge.names]).join('\n');
      for (const token of forbidden) expect(imports, `${file} must not import ${token}`).not.toContain(token);
    }
  });
});
