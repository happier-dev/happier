import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps the closed Customize and Look editor graphs behind their entry controls', () => {
    const entries = [
        new URL('./HomeHub.tsx', import.meta.url),
        new URL('../atmosphere/look/LookChip.tsx', import.meta.url),
    ];
    const eagerEditors = entries.flatMap((file) => {
        const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        return source.statements.flatMap((statement) => {
            if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly
                || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
            const module = statement.moduleSpecifier.text;
            return /\/(?:HomeCustomizeBar|LookPanel)$/.test(module) ? [module] : [];
        });
    });

    expect(eagerEditors).toEqual([]);
});
