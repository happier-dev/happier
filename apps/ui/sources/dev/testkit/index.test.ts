import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('UI testkit barrel', () => {
    it('does not re-export the plugin surface fixture that loads the text module', async () => {
        const barrelSource = await readFile(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

        expect(barrelSource).not.toContain("./fixtures/pluginSurfaceContextFixture");
    });
});
