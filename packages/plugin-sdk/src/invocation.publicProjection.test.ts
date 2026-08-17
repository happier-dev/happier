import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/* @sdk-negative-type-case:src-invocation-publicProjection-test-ts-1:UGx1Z2luIGludm9jYXRpb24gY2FsbGVyIHByb3ZlbmFuY2UgaXMgcHVibGlzaGVkIG9ubHkgZnJvbSB0aGUgcm9vdCBpbnZvY2F0aW9uIGJvdW5kYXJ5Lg==:aW1wb3J0IHR5cGUgeyBQbHVnaW5JbnZvY2F0aW9uQ2FsbGVyIGFzIEFnZW50UnVudGltZVBsdWdpbkludm9jYXRpb25DYWxsZXIgfSBmcm9tICcuL2FnZW50cy9ydW50aW1lL2luZGV4LmpzJzs= */
type AgentRuntimePluginInvocationCaller = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-invocation-publicProjection-test-ts-2:UGx1Z2luIGludm9jYXRpb24gb3JpZ2luIHByb3ZlbmFuY2UgaXMgcHVibGlzaGVkIG9ubHkgZnJvbSB0aGUgcm9vdCBpbnZvY2F0aW9uIGJvdW5kYXJ5Lg==:aW1wb3J0IHR5cGUgeyBQbHVnaW5JbnZvY2F0aW9uT3JpZ2luU3VyZmFjZSBhcyBBZ2VudFJ1bnRpbWVQbHVnaW5JbnZvY2F0aW9uT3JpZ2luU3VyZmFjZSB9IGZyb20gJy4vYWdlbnRzL3J1bnRpbWUvaW5kZXguanMnOw== */
type AgentRuntimePluginInvocationOriginSurface = never; /* @sdk-negative-type-case-end */

async function readDirectTypeProjection(
    path: URL,
    moduleSpecifier: string,
): Promise<readonly string[]> {
    const sourceText = await readFile(path, 'utf8');
    const sourceFile = ts.createSourceFile(
        path.pathname,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    return sourceFile.statements.flatMap((statement) => {
        if (!ts.isExportDeclaration(statement)
            || !statement.moduleSpecifier
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== moduleSpecifier
            || !statement.exportClause
            || !ts.isNamedExports(statement.exportClause)
        ) {
            return [];
        }
        return statement.exportClause.elements.map((element) => element.name.text);
    });
}

describe('invocation provenance public projections', () => {
    it('publishes caller provenance from the root invocation boundary without an Agent-runtime alias', async () => {
        const [root, agentRuntime] = await Promise.all([
            readDirectTypeProjection(new URL('./index.ts', import.meta.url), './invocation.js'),
            readDirectTypeProjection(new URL('./agents/runtime/index.ts', import.meta.url), '../../invocation.js'),
        ]);

        expect(root).toEqual(expect.arrayContaining([
            'PluginInvocationCaller',
            'PluginInvocationOriginSurface',
        ]));
        expect(agentRuntime).not.toEqual(expect.arrayContaining([
            'PluginInvocationCaller',
            'PluginInvocationOriginSurface',
        ]));
    });
});
