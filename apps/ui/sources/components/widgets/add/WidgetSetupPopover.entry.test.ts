import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps the widget setup step out of the closed editor entry', () => {
    const url = new URL('./WidgetSetupPopover.tsx', import.meta.url);
    const source = ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true);
    const eagerSetupImports = source.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly
            || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
        const module = statement.moduleSpecifier.text;
        return /WidgetSetup(?:Step|PopoverBody)$/.test(module) ? [module] : [];
    });

    expect(eagerSetupImports).toEqual([]);
});
