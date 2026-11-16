import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OPAQUE_MODULE, UI_PACKAGE_ROOT, evaluateMetroModule, transformLikeMetro } from '@/dev/testkit/performance/metroModuleEvaluation';

/**
 * Metro's inline requires defer a named import to its first use, but a default or namespace import
 * (`_interopRequireDefault(require(...))`) is evaluated with the importing module. Crash reporting is
 * off without a DSN, after the crash-reports opt-out and in embed windows, yet a namespace import made
 * every start evaluate the whole Sentry SDK (~375 modules on web). Protocol modules evaluate at start
 * and use semver only inside validators. Importing these SDKs by name keeps them for the code that runs.
 */
const REPO_ROOT = resolve(UI_PACKAGE_ROOT, '../..');
const SENTRY_IMPORTERS = ['sources/utils/system/sentry.ts', 'sources/app/_layout.tsx'].map((file) => resolve(UI_PACKAGE_ROOT, file));
function listModules(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return listModules(path);
        return /\.ts$/u.test(entry.name) && !/\.(?:test|spec)\.ts$/u.test(entry.name) ? [path] : [];
    });
}
const SEMVER_IMPORTERS = listModules(resolve(REPO_ROOT, 'packages/protocol/src')).filter((file) => readFileSync(file, 'utf8').includes("from 'semver'"));

function packagesRequiredAtLoad(file: string, packages: ReadonlySet<string>): string[] {
    const required: string[] = [];
    evaluateMetroModule(transformLikeMetro(file), (specifier) => {
        if (packages.has(specifier)) required.push(specifier);
        return OPAQUE_MODULE;
    });
    return required;
}

describe('optional SDK evaluation under the Metro transform', () => {
    it('evaluates neither the Sentry SDK nor semver while their importers evaluate', () => {
        expect(SEMVER_IMPORTERS.length).toBeGreaterThan(0);
        const offenders = [
            ...SENTRY_IMPORTERS.flatMap((file) => packagesRequiredAtLoad(file, new Set(['@sentry/react-native'])).map((p) => `${relative(REPO_ROOT, file)}: ${p}`)),
            ...SEMVER_IMPORTERS.flatMap((file) => packagesRequiredAtLoad(file, new Set(['semver'])).map((p) => `${relative(REPO_ROOT, file)}: ${p}`)),
        ];
        expect(offenders).toEqual([]);
    }, 300_000);
});
