import { readFile } from 'node:fs/promises';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { defineBrowserAction } from './actions.js';
import { defineBrowserTarget } from './targets.js';

const display = {
    title: 'Preview',
    iconToken: 'browser',
    tone: 'info',
} as const;

describe('browser SDK helpers', () => {
    it('publishes browser contribution helpers beside the retained toolchain packet', async () => {
        const sourceText = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
        const sourceFile = ts.createSourceFile(
            'browser/index.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const exportedNames = sourceFile.statements.flatMap((statement) => (
            ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
                ? statement.exportClause.elements.map((element) => element.name.text)
                : []
        ));

        expect(exportedNames).toEqual(expect.arrayContaining([
            'PUBLIC_TOOLCHAIN_COMPATIBILITY_V1',
            'BrowserActionContribution',
            'BrowserActionContributionInput',
            'BrowserTargetContribution',
            'BrowserTargetContributionInput',
            'defineBrowserAction',
            'defineBrowserTarget',
        ]));
    });

    it('defines browser targets and actions without exposing browser internals', () => {
        const browserTarget = defineBrowserTarget({
            id: 'preview-target',
            title: 'Preview target',
            url: 'https://preview.example.com',
        });

        const action = defineBrowserAction({
            id: 'open-preview',
            title: 'Open preview',
            action: 'open-preview',
            target: 'preview-target',
            order: 100,
        });

        expect(browserTarget.url).toBe('https://preview.example.com');
        expect(browserTarget.launch).toBe('newView');
        expect(browserTarget.profile).toBe('user');
        expect(action.target).toBe('preview-target');
        expect(action.placement).toBe('toolbar');
    });

    it('rejects attempts to define browser chrome or adapter internals', () => {
        expect(() => defineBrowserAction({
            id: 'bad-browser-action',
            title: 'Bad browser action',
            action: 'open-preview',
            target: 'preview-target',
            chrome: { hideAddressBar: true },
        } as never)).toThrow();
    });
});
