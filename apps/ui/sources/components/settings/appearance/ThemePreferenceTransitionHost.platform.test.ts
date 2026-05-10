import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));

describe('ThemePreferenceTransitionHost platform boundaries', () => {
    it('keeps native screenshot dependencies out of the web host bundle', () => {
        const webHostPath = join(currentDir, 'ThemePreferenceTransitionHost.web.tsx');
        expect(existsSync(webHostPath)).toBe(true);

        const webHostSource = readFileSync(webHostPath, 'utf8');
        expect(webHostSource).not.toContain('react-native-view-shot');
        expect(webHostSource).not.toContain('@react-native-masked-view/masked-view');
    });
});
