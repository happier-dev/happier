import { describe, expect, it } from 'vitest';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const EXCLUDED_DIR_NAMES = new Set(['__tests__', '__testdata__']);
const EXCLUDED_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];
const ALLOWED_REACT_NATIVE_STYLESHEET_IMPORTS = new Set([
    'components/ui/surfaces/resolveThemeHairlineBorderStyle.ts',
    'components/ui/motion/SlideTransitionBlurLayer.tsx',
    'components/ui/motion/SlideTransitionFrame.tsx',
    'components/ui/motion/StoryDeckSlideTransition.tsx',
    'components/sessions/files/views/SessionRepositoryTreeBrowserView.tsx',
    'components/onboarding/unauthShell/PlanetBackground.tsx',
    'components/ui/code/view/CodeLineRow.tsx',
]);

function shouldSkipTypeScriptFile(path: string) {
    return EXCLUDED_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function walkTypeScriptFiles(rootDir: string): string[] {
    const results: string[] = [];
    const stack: string[] = [rootDir];

    while (stack.length > 0) {
        const currentDir = stack.pop();
        if (!currentDir) {
            continue;
        }

        for (const entry of readdirSync(currentDir)) {
            const fullPath = join(currentDir, entry);
            const stat = statSync(fullPath);

            if (stat.isDirectory()) {
                if (EXCLUDED_DIR_NAMES.has(entry)) {
                    continue;
                }
                stack.push(fullPath);
                continue;
            }

            if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
                if (shouldSkipTypeScriptFile(fullPath)) {
                    continue;
                }
                results.push(fullPath);
            }
        }
    }

    return results;
}

describe('Unistyles StyleSheet import invariants', () => {
    it('does not import StyleSheet from react-native inside sources/', () => {
        const testDir = fileURLToPath(new URL('.', import.meta.url));
        const sourcesDir = join(testDir, '..'); // sources/

        const excludedPrefixes = [
            join(sourcesDir, 'dev') + '/',
            join(sourcesDir, 'sync', '__testdata__') + '/',
        ];

        const offenders: Array<{ file: string; line: number }> = [];

        for (const file of walkTypeScriptFiles(sourcesDir)) {
            const normalized = file.replaceAll('\\', '/');
            if (excludedPrefixes.some((prefix) => normalized.startsWith(prefix.replaceAll('\\', '/')))) {
                continue;
            }

            const content = readFileSync(file, 'utf8');
            if (!content.includes('StyleSheet') || !content.includes('react-native')) {
                continue;
            }

            const sourceFile = ts.createSourceFile(
                file,
                content,
                ts.ScriptTarget.Latest,
                true,
                file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
            );

            for (const statement of sourceFile.statements) {
                if (!ts.isImportDeclaration(statement)) {
                    continue;
                }

                if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'react-native') {
                    continue;
                }

                const namedBindings = statement.importClause?.namedBindings;
                if (!namedBindings || !ts.isNamedImports(namedBindings)) {
                    continue;
                }

                const hasStyleSheet = namedBindings.elements.some((specifier) => {
                    const importedName = specifier.propertyName?.text ?? specifier.name.text;
                    return importedName === 'StyleSheet';
                });

                if (!hasStyleSheet) {
                    continue;
                }

                const { line } = ts.getLineAndCharacterOfPosition(sourceFile, statement.getStart(sourceFile));
                offenders.push({ file, line: line + 1 });
            }
        }

        const unexpectedOffenders = offenders
            .map(({ file, line }) => ({
                relativePath: relative(sourcesDir, file).replaceAll('\\', '/'),
                line,
            }))
            .filter(({ relativePath }) => !ALLOWED_REACT_NATIVE_STYLESHEET_IMPORTS.has(relativePath))
            .map(({ relativePath, line }) => `${relativePath}:${line}`);

        expect(unexpectedOffenders).toEqual([]);
    }, 30_000);
});
