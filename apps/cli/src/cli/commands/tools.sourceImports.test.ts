import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

async function eagerImports(path: string): Promise<string[]> {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return file.statements.flatMap(statement => ts.isImportDeclaration(statement)
    && !statement.importClause?.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier)
    ? [statement.moduleSpecifier.text] : []);
}

describe('Session MCP tool child startup cost', () => {
  it('loads zero Account and plugin execution roots before selecting the Session client', async () => {
    // A native Pi tool starts a fresh CLI child per call. These imports load the
    // Account graph before the Session transport can be selected. This structural
    // contract complements the real socket/call tests and the loaded RSS replay.
    const imports = await eagerImports('./tools.ts');
    const eagerExecutionRoots = imports.filter(path => path === './toolsAccount'
      || path.includes('/settings/')
      || path.includes('/agent/tools/happierTools/')
      || path === '@/persistence'
      || path === '@/daemon/controlClient'
      || path === '@/agent/runtime/initializeBackendApiContext'
      || path === '@/configuration');
    expect(eagerExecutionRoots).toEqual([]);

    const clientImports = await eagerImports('./toolsSessionMcp.ts');
    expect(clientImports.filter(path => path.endsWith('/sessionMcpToolsBridge'))).toEqual([]);
    expect(imports.filter(path => path.endsWith('/sessionMcpLocalTransport'))).toEqual([]);
  });
});
