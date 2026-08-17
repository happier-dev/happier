import { readFile } from 'node:fs/promises';

import {
    redactBugReportSensitiveText as canonicalRedactBugReportSensitiveText,
    trimBugReportTextToMaxBytes as canonicalTrimBugReportTextToMaxBytes,
} from '@happier-dev/protocol/bugs/reports';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import {
    redactBugReportSensitiveText,
    trimBugReportTextToMaxBytes,
} from './diagnostics.js';

function emittedIsolatedDeclaration(sourceText: string): string {
    const result = ts.transpileDeclaration(sourceText, {
        fileName: 'diagnostics.ts',
        compilerOptions: {
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
    });
    if (result.diagnostics?.length) {
        throw new Error(result.diagnostics.map((diagnostic) => (
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        )).join('\n'));
    }
    return result.outputText;
}

describe('Plugin SDK diagnostic projections', () => {
    it('keeps canonical bug-report redaction behavior while emitting no Protocol declaration path', async () => {
        const sourceText = await readFile(new URL('./diagnostics.ts', import.meta.url), 'utf8');

        expect(redactBugReportSensitiveText).toBe(canonicalRedactBugReportSensitiveText);
        expect(trimBugReportTextToMaxBytes).toBe(canonicalTrimBugReportTextToMaxBytes);
        expect(emittedIsolatedDeclaration(sourceText)).not.toMatch(/@happier-dev\/protocol(?:\/|['"])/u);
    });
});
