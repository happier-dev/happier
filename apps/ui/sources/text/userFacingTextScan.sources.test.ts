import { describe, expect, it } from 'vitest';

import path from 'node:path';

import { scanUserFacingStrings } from '../../tools/i18n/userFacingTextScan';

describe('tools/i18n/userFacingTextScan (app sources)', () => {
    it('has no user-facing hardcoded strings in sources/', () => {
        const hits = scanUserFacingStrings({ sourcesRootDir: path.resolve('sources') });

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
