import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CLI_SOURCE_ROOT = join(import.meta.dirname, '..', '..');

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
    if (!('name' in property) || !property.name) return null;
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
    return null;
}

function isNoninteractiveContext(context: ts.ObjectLiteralExpression): boolean {
    const properties = new Map(context.properties.map((property) => [propertyName(property), property]));
    for (const marker of ['actionCaller', 'reviewCommentPrincipal', 'executionRunTargetMachineId']) {
        if (properties.has(marker)) return true;
    }
    const surface = properties.get('surface');
    return Boolean(
        surface
        && ts.isPropertyAssignment(surface)
        && ts.isStringLiteral(surface.initializer)
        && ['agent', 'mcp', 'plugin'].includes(surface.initializer.text),
    );
}

describe('Action execution authority architecture', () => {
    it('requires direct noninteractive production execute callsites to stamp authority explicitly', () => {
        const files = ts.sys.readDirectory(CLI_SOURCE_ROOT, ['.ts', '.tsx'], undefined, undefined)
            .filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
        const missing: string[] = [];

        for (const file of files) {
            let sourceText: string;
            try {
                sourceText = readFileSync(file, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
            }
            if (!sourceText.includes('.execute(')) continue;
            const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
            const visit = (node: ts.Node): void => {
                if (
                    ts.isCallExpression(node)
                    && ts.isPropertyAccessExpression(node.expression)
                    && node.expression.name.text === 'execute'
                    && node.arguments.length >= 3
                    && ts.isObjectLiteralExpression(node.arguments[2])
                ) {
                    const context = node.arguments[2];
                    if (isNoninteractiveContext(context)
                        && !context.properties.some((property) => propertyName(property) === 'authority')) {
                        const position = source.getLineAndCharacterOfPosition(context.getStart(source));
                        missing.push(`${relative(CLI_SOURCE_ROOT, file)}:${position.line + 1}`);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
        }

        expect(missing).toEqual([]);
    }, 120_000);
});
