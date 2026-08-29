import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const CANONICAL_JSON_OWNER_IMPORT = "from '@happier-dev/protocol/crypto/canonicalJson'";

describe('External Sessions canonical JSON ownership', () => {
    it.each([
        'candidateQuery.ts',
        'hookInstallationConfiguration.ts',
    ])('uses the Protocol serializer without a private walker in %s', async (fileName) => {
        const source = await readFile(new URL(`./${fileName}`, import.meta.url), 'utf8');

        expect(source).toContain(CANONICAL_JSON_OWNER_IMPORT);
        expect(source).not.toMatch(/function canonicalJson\s*\(/u);
    });
});
