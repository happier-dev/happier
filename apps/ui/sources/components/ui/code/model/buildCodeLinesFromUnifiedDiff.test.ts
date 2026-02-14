import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromUnifiedDiff } from './buildCodeLinesFromUnifiedDiff';

describe('buildCodeLinesFromUnifiedDiff', () => {
    it('assigns old/new line numbers for add/remove/context lines', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,2 @@',
            '-const a = 1;',
            '+const a = 2;',
            ' const b = 3;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        const body = lines.filter((l) => !l.renderIsHeaderLine);

        expect(body[0]).toMatchObject({
            kind: 'remove',
            oldLine: 1,
            newLine: null,
            renderPrefixText: '-',
            renderCodeText: 'const a = 1;',
        });

        expect(body[1]).toMatchObject({
            kind: 'add',
            oldLine: null,
            newLine: 1,
            renderPrefixText: '+',
            renderCodeText: 'const a = 2;',
        });

        expect(body[2]).toMatchObject({
            kind: 'context',
            oldLine: 2,
            newLine: 2,
            renderPrefixText: ' ',
            renderCodeText: 'const b = 3;',
        });
    });
});

