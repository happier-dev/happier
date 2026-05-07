import { existsSync, readdirSync, statSync } from 'node:fs';
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

    it('does not allow Vitest test/spec files inside sources/app (they can become routes and shadow screens)', () => {
        const appRoot = resolve(__dirname, '../app');

        /** @param {string} dir */
        const walk = (dir: string): string[] => {
            const out: string[] = [];
            for (const entry of readdirSync(dir)) {
                const full = resolve(dir, entry);
                const st = statSync(full);
                if (st.isDirectory()) {
                    out.push(...walk(full));
                } else {
                    out.push(full);
                }
            }
            return out;
        };

        const forbidden = walk(appRoot).filter((filePath) =>
            /\.(?:spec|test)\.[tj]sx?$/.test(filePath) || /\.testHelpers\.[tj]sx?$/.test(filePath),
        );

        expect(forbidden).toEqual([]);
    });

    it('does not allow non-route modules at the router root (they become top-level routes)', () => {
        const appRoot = resolve(__dirname, '../app');
        const topLevelFiles = readdirSync(appRoot).filter((name) => {
            const full = resolve(appRoot, name);
            try {
                return statSync(full).isFile();
            } catch {
                return false;
            }
        });

        const unexpected = topLevelFiles.filter((name) => {
            if (name === '_layout.tsx') return false;
            if (name.startsWith('+')) return false;
            return true;
        });

        expect(unexpected).toEqual([]);
    });

    it('does not allow non-route implementation modules inside sources/app', () => {
        const appRoot = resolve(__dirname, '../app');

        const walk = (dir: string): string[] => {
            const out: string[] = [];
            for (const entry of readdirSync(dir)) {
                const full = resolve(dir, entry);
                const st = statSync(full);
                if (st.isDirectory()) {
                    out.push(...walk(full));
                } else {
                    out.push(full);
                }
            }
            return out;
        };

        const unexpected = walk(appRoot).filter((filePath) => {
            if (filePath.endsWith('.ts')) return true;
            const fileName = filePath.split(/[\\/]/u).pop() ?? '';
            return /^[A-Z].*\.tsx$/u.test(fileName);
        });
        expect(unexpected).toEqual([]);
    });
});
