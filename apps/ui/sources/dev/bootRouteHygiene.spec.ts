import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('boot route hygiene', () => {
    it('does not keep resolveBootCredentials under sources/app where Expo Router will treat it as a route', () => {
        expect(existsSync(resolve(__dirname, '../app/boot/resolveBootCredentials.ts'))).toBe(false);
        expect(existsSync(resolve(__dirname, '../app/boot/resolveBootCredentials.test.ts'))).toBe(false);
    });
});
