import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const startupOwners = [
    'hub/composer/HubComposerSection.tsx',
    'sessions/new/components/NewSessionDockedHost.tsx',
];

describe('New Session startup boundary', () => {
    it.each(startupOwners)('%s leaves the editor graph unloaded until the editor is requested', (owner) => {
        const url = new URL(`../../${owner}`, import.meta.url);
        const source = ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true);
        const eagerEditorImports = source.statements.flatMap((statement) => {
            if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly
                || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
            const module = statement.moduleSpecifier.text;
            return module.endsWith('/NewSessionScreen') ? [module] : [];
        });

        expect(eagerEditorImports).toEqual([]);
    });
});
