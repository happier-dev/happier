import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// A.13q.1 Outcome B requires that the host-session-runtime-plan compatibility ABI,
// internalized behind `@happier-dev/plugin-sdk/internal/runtime/session`, is consumed
// only by first-party bundled plugin adapters and never by third-party / public / example
// plugin code. The root-export fence in engineSurfaceContract.ts proves it is not reachable
// from the public SDK root; this fence proves the only deliberate subpath importers are the
// first-party bundled plugins under `packages/plugins/<id>/src/**`.

const INTERNAL_SUBPATHS = [
    {
        specifier: '@happier-dev/plugin-sdk/internal/runtime/session',
        label: 'session turn-operations ABI',
        isAllowedImporter: (rel: string): boolean => /^packages\/plugins\/[^/]+\/src\//.test(rel),
    },
    {
        specifier: '@happier-dev/plugin-sdk/internal/runtime/executionRun',
        label: 'execution-run turn-operations adapter ABI',
        isAllowedImporter: (rel: string): boolean => /^packages\/plugins\/[^/]+\/src\//.test(rel)
            || rel === 'apps/cli/src/agent/runtime/bridges/executionRun/hostRuntimeFromTurnOps.ts',
    },
] as const;
const SKIP_DIR_NAMES = new Set([
    'node_modules',
    'dist',
    'package-dist',
    'build',
    'coverage',
    '.git',
    '.project',
    '.next',
    '.turbo',
]);

function findRepoRoot(start: string): string {
    let current = start;
    for (;;) {
        if (existsSync(join(current, 'apps')) && existsSync(join(current, 'packages'))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            throw new Error('Could not locate repository root from plugin-sdk fence test');
        }
        current = parent;
    }
}

function collectSourceFiles(root: string, scanDirs: readonly string[]): string[] {
    const out: string[] = [];
    const walk = (absDir: string): void => {
        let entries: ReturnType<typeof readdirSync>;
        try {
            entries = readdirSync(absDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (SKIP_DIR_NAMES.has(entry.name)) {
                    continue;
                }
                walk(join(absDir, entry.name));
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
                out.push(join(absDir, entry.name));
            }
        }
    };
    for (const scanDir of scanDirs) {
        walk(join(root, scanDir));
    }
    return out;
}

describe('A.13q internal runtime compatibility subpath fence', () => {
    const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
    const selfRelative = relative(root, fileURLToPath(import.meta.url));

    const sourceFiles = collectSourceFiles(root, ['apps', 'packages'])
        .filter((file) => {
            const rel = relative(root, file);
            // The fence test itself references the specifier string; exclude all test files.
            return !/\.test\.(ts|tsx|js|jsx)$/.test(file) && rel !== selfRelative;
        });

    for (const subpath of INTERNAL_SUBPATHS) {
        const importers = sourceFiles
            .filter((file) => readFileSync(file, 'utf8').includes(subpath.specifier))
            .map((file) => relative(root, file).split(sep).join('/'));

        it(`${subpath.label} is imported only by accepted first-party owners`, () => {
            expect(importers.filter((rel) => !subpath.isAllowedImporter(rel))).toEqual([]);
        });

        it(`${subpath.label} has at least one known consumer`, () => {
            // If this ever drops to zero the internal subpath is unused and should be deleted
            // (Outcome A), not left as a dangling internal ABI.
            expect(importers.length).toBeGreaterThan(0);
        });
    }
});
