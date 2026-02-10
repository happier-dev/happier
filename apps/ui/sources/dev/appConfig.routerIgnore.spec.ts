import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('expo-router route hygiene', () => {
    it('does not allow non-route helpers/tests to shadow the real Root Layout', () => {
        const appGroupDir = resolve(__dirname, '../app/(app)');
        const entries = readdirSync(appGroupDir);

        // Only the real layout file should use the `_layout.*` prefix in this directory.
        // Expo Router treats `_layout.*` as a layout file, and web exports can enumerate
        // module contexts in an order that would otherwise cause shadowing.
        const layoutPrefixed = entries.filter((name) => name.startsWith('_layout.'));
        expect(layoutPrefixed).toEqual(['_layout.tsx']);

        // Test helpers must live outside of `sources/app` so they can't accidentally become routes/layouts.
        expect(existsSync(resolve(appGroupDir, '_layout.testHelpers.ts'))).toBe(false);
        expect(existsSync(resolve(__dirname, 'testkit/rootLayoutTestkit.ts'))).toBe(true);
    });
});
