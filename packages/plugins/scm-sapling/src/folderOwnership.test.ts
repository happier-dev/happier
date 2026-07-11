import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sourceDir = dirname(fileURLToPath(import.meta.url));

describe('scm-sapling folder ownership', () => {
    it('does not keep final plugin implementation under src/backend', () => {
        expect(existsSync(join(sourceDir, 'backend'))).toBe(false);
    });
});
