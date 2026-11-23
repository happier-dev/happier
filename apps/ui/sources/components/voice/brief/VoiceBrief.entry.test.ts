import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('leaves the Brief content and Inbox out of the closed Home entry', () => {
    const eagerImports = [
        new URL('../../hub/HomeHub.tsx', import.meta.url),
        new URL('./VoiceBriefButton.tsx', import.meta.url),
        new URL('./useVoiceBriefHomeRequest.ts', import.meta.url),
    ].filter((file) => existsSync(file)).flatMap((file) => {
        const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        return source.statements.flatMap((statement) => {
            if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly
                || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
            const module = statement.moduleSpecifier.text;
            return /\/(?:VoiceBrief|useVoiceBriefRequest|useInboxModel)$/.test(module) ? [module] : [];
        });
    });

    expect(eagerImports).toEqual([]);
});
