import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * L0-4 (RU2 capstone, audit PLG-1) — closure guard: no hardcoded hex colors in
 * the four capstone surfaces' component trees. Colors must come from the
 * unistyles `theme` tokens so every theme profile (incl. dark) renders
 * correctly. `BadgeGrid` was the only violator at audit time; this test keeps
 * it (and every sibling) fixed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES_ROOT = resolve(here, '../../../..'); // .../apps/ui/sources

const SURFACE_TREES = [
    'components/browser',
    'components/devices',
    'components/stream',
    'components/sessions/localServices',
    'components/plugins',
    'components/settings/plugins',
    'components/ui/layout',
] as const;

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;

function collectSourceFiles(root: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(root)) {
        const full = join(root, entry);
        if (statSync(full).isDirectory()) {
            out.push(...collectSourceFiles(full));
            continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (/\.test\.(ts|tsx)$/.test(entry) || full.includes('__tests__')) continue;
        out.push(full);
    }
    return out;
}

describe('no hardcoded hex colors in capstone surface components (L0-4 closure)', () => {
    it('every color in the four surfaces comes from theme tokens', () => {
        const violations: string[] = [];
        for (const tree of SURFACE_TREES) {
            for (const file of collectSourceFiles(resolve(SOURCES_ROOT, tree))) {
                const source = readFileSync(file, 'utf8');
                // Inspect authored values, not explanatory comments containing color examples.
                const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
                    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
                const lines = source.split('\n');
                const visit = (node: ts.Node): void => {
                    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
                        && HEX_COLOR.test(node.text)) {
                        const { line } = syntax.getLineAndCharacterOfPosition(node.getStart(syntax));
                        violations.push(`${file.slice(SOURCES_ROOT.length + 1)}:${line + 1}: ${lines[line]!.trim()}`);
                    }
                    ts.forEachChild(node, visit);
                };
                visit(syntax);
            }
        }
        expect(violations, `hardcoded hex colors found:\n${violations.join('\n')}`).toEqual([]);
    });
});
