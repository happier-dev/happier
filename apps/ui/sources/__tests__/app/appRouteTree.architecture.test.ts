import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function isSuspiciousRouteTreeModule(fileName: string): boolean {
    const moduleName = fileName.replace(/\.(ts|tsx)$/u, '');
    return /^(use|resolve)[A-Z]/u.test(moduleName) || /^[A-Z]/u.test(moduleName);
}

function collectSuspiciousRouteTreeModules(rootDir: string, currentDir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
        if (entry.name === '__tests__') {
            continue;
        }
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
            collectSuspiciousRouteTreeModules(rootDir, fullPath, acc);
            continue;
        }
        if (!/\.(ts|tsx)$/u.test(entry.name)) {
            continue;
        }
        if (/\.(test|spec)\.(ts|tsx)$/u.test(entry.name)) {
            continue;
        }
        if (/^(_layout|\+html)$/u.test(entry.name.replace(/\.(ts|tsx)$/u, ''))) {
            continue;
        }
        if (isSuspiciousRouteTreeModule(entry.name)) {
            acc.push(relative(rootDir, fullPath));
        }
    }
    return acc;
}

describe('app route tree architecture', () => {
    it('keeps non-route implementation modules outside the Expo Router app tree', () => {
        const appRoot = resolve(process.cwd(), 'sources/app');
        const suspiciousModules = collectSuspiciousRouteTreeModules(appRoot, appRoot);

        expect(suspiciousModules).toEqual([]);
    });
});
