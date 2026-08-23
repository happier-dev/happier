import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function hasSyntacticDefaultExport(filePath: string, source: string): boolean {
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    return sourceFile.statements.some((statement) => {
        if (ts.isExportAssignment(statement)) {
            return !statement.isExportEquals;
        }

        if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            return statement.exportClause.elements.some((element) => element.name.text === 'default');
        }

        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
        return Boolean(
            modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
            && modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
        );
    });
}

describe('expo-router route hygiene', () => {
    it('does not allow non-route helpers/tests to shadow the real Root Layout', () => {
        const appGroupDir = resolve(__dirname, '../app/(app)');
        const entries = readdirSync(appGroupDir);

        // Only the real layout file should use the `_layout.*` prefix in this directory.
        // Expo Router treats `_layout.*` as a layout file, and web exports can enumerate
        // module contexts in an order that would otherwise cause shadowing.
        const layoutPrefixed = entries.filter((name) => name.startsWith('_layout.'));
        expect(layoutPrefixed).toEqual(['_layout.tsx']);

        // Test helpers must live outside of `sources/app` so they can't accidentally become routes/layouts.
        expect(existsSync(resolve(appGroupDir, '_layout.testHelpers.ts'))).toBe(false);
        expect(existsSync(resolve(__dirname, 'testkit/rootLayoutTestkit.ts'))).toBe(true);
    });

    it('does not allow Vitest test/spec files inside sources/app (they can become routes and shadow screens)', () => {
        const appRoot = resolve(__dirname, '../app');

        /** @param {string} dir */
        const walk = (dir: string): string[] => {
            const out: string[] = [];
            for (const entry of readdirSync(dir)) {
                const full = resolve(dir, entry);
                const st = statSync(full);
                if (st.isDirectory()) {
                    out.push(...walk(full));
                } else {
                    out.push(full);
                }
            }
            return out;
        };

        const forbidden = walk(appRoot).filter((filePath) =>
            /\.(?:spec|test)\.[tj]sx?$/.test(filePath) || /\.testHelpers\.[tj]sx?$/.test(filePath),
        );

        expect(forbidden).toEqual([]);
    });

    it('does not allow non-route modules at the router root (they become top-level routes)', () => {
        const appRoot = resolve(__dirname, '../app');
        const topLevelFiles = readdirSync(appRoot).filter((name) => {
            const full = resolve(appRoot, name);
            try {
                return statSync(full).isFile();
            } catch {
                return false;
            }
        });

        const unexpected = topLevelFiles.filter((name) => {
            if (name === '_layout.tsx') return false;
            if (name.startsWith('+')) return false;
            return true;
        });

        expect(unexpected).toEqual([]);
    });

    it('does not allow non-route implementation modules inside sources/app', () => {
        const appRoot = resolve(__dirname, '../app');

        const walk = (dir: string): string[] => {
            const out: string[] = [];
            for (const entry of readdirSync(dir)) {
                const full = resolve(dir, entry);
                const st = statSync(full);
                if (st.isDirectory()) {
                    out.push(...walk(full));
                } else {
                    out.push(full);
                }
            }
            return out;
        };

        const unexpected = walk(appRoot).filter((filePath) => {
            if (filePath.split('/').at(-1)?.startsWith('+')) return false;
            if (filePath.endsWith('.ts')) return true;
            if (!filePath.endsWith('.tsx')) return false;

            const source = readFileSync(filePath, 'utf8');
            return !hasSyntacticDefaultExport(filePath, source);
        });
        expect(unexpected).toEqual([]);
    });

    it('recognizes default exports by syntax rather than comments or strings', () => {
        expect(hasSyntacticDefaultExport('direct.tsx', 'export default function Route() { return null; }')).toBe(true);
        expect(hasSyntacticDefaultExport('named.tsx', 'export { Route as default } from "./Route";')).toBe(true);
        expect(hasSyntacticDefaultExport('forwarded.tsx', 'export { default } from "./Route";')).toBe(true);
        expect(hasSyntacticDefaultExport('comment.tsx', '// export default function Route() {}\nexport const helper = true;')).toBe(false);
        expect(hasSyntacticDefaultExport('string.tsx', 'export const example = "export default";')).toBe(false);
    });
});
