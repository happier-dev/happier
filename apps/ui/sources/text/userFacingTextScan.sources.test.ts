import { describe, expect, it } from 'vitest';

import path from 'node:path';

import { scanUserFacingStrings } from '../../tools/i18n/userFacingTextScan';
import type { UserFacingStringHit } from '../../tools/i18n/userFacingTextScan';

const IGNORED_SCAN_TEXTS = new Set([
    'SKILL.md',
    // UI typography token (non-user-facing style value).
    'semiBold',
    // Internal notification permission status enum token.
    'notGranted',
]);

const IGNORED_SCAN_FILE_PATH_SEGMENTS = [
    `${path.sep}sources${path.sep}components${path.sep}ui${path.sep}selectionList${path.sep}storySurface${path.sep}`,
];

function isIgnoredHit(hit: UserFacingStringHit): boolean {
    if (IGNORED_SCAN_FILE_PATH_SEGMENTS.some((segment) => hit.filePath.includes(segment))) {
        return true;
    }

    const { text } = hit;
    if (IGNORED_SCAN_TEXTS.has(text)) {
        return true;
    }

    return /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_-]+)+$/.test(text);
}

describe('tools/i18n/userFacingTextScan (app sources)', () => {
    it('has no user-facing hardcoded strings in sources/', () => {
        const hits = scanUserFacingStrings({ sourcesRootDir: path.resolve('sources') })
            .filter((hit) => !isIgnoredHit(hit));

        if (hits.length > 0) {
            const sample = hits
                .slice(0, 40)
                .map((h) => `${h.filePath}:${h.line}:${h.column} ${JSON.stringify(h.text)} (${h.kind})`)
                .join('\n');
            throw new Error(
                [
                    `Found ${hits.length} likely user-facing hardcoded strings in sources/.`,
                    'Replace these with t(...) and add the keys to sources/text/translations/*.ts.',
                    '',
                    'Sample:',
                    sample,
                ].join('\n')
            );
        }

        expect(hits).toEqual([]);
    }, 120_000);
});
