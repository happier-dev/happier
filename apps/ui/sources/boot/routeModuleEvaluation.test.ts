import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OPAQUE_MODULE, UI_PACKAGE_ROOT, evaluateMetroModule, transformLikeMetro } from '@/dev/testkit/performance/metroModuleEvaluation';

/**
 * Native Expo Router evaluates every route module while it builds the route tree, before the first
 * screen renders (web loads routes per chunk). A route is a thin entrypoint: evaluating it must not
 * run app code. Under the Metro transform an import used only inside a component stays a deferred
 * `require`, so any first-party module required while the route module itself evaluates is work
 * every cold start pays for a screen nobody opened. Layouts render at boot and are excluded.
 */
const APP_ROOT = resolve(UI_PACKAGE_ROOT, 'sources/app');
const FIRST_PARTY = /^(?:@\/|\.\.?\/|@happier-dev\/)/u;
// The lazy-component owner a route uses to defer its screen is the one first-party module allowed.
const LAZY_ROUTE_PRIMITIVE = /(?:^|\/)components\/ui\/performance\/retryableLazy$/u;

function listRouteModules(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return listRouteModules(path);
        return /\.tsx?$/u.test(entry.name) && !/\.(?:test|spec)\.tsx?$/u.test(entry.name) && !entry.name.startsWith('_layout.')
            ? [path] : [];
    });
}

describe('route module evaluation', () => {
    it('requires no first-party module while a route module evaluates', () => {
        const offenders: string[] = [];
        for (const file of listRouteModules(APP_ROOT)) {
            const required = new Set<string>();
            evaluateMetroModule(transformLikeMetro(file), (specifier) => {
                if (FIRST_PARTY.test(specifier) && !LAZY_ROUTE_PRIMITIVE.test(specifier)) required.add(specifier);
                return OPAQUE_MODULE;
            });
            if (required.size > 0) offenders.push(`${relative(APP_ROOT, file)}: ${[...required].join(', ')}`);
        }
        expect(offenders).toEqual([]);
    }, 300_000);
});
