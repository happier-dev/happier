import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'globals.css');
const css = readFileSync(cssPath, 'utf8');

describe('reveal word motion', () => {
    it('keeps the full desktop blur while capping mobile reveal blur at two pixels', () => {
        expect(css).toMatch(/\.reveal-word\s*{[^}]*filter:\s*blur\(10px\)/s);
        expect(css).toMatch(/@media\s+\(hover:\s*none\)\s+and\s+\(pointer:\s*coarse\)\s*{[^@]*\.reveal-word\s*{[^}]*filter:\s*blur\(2px\)/s);
    });
});
