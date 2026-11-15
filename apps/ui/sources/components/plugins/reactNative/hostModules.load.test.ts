import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UI_PACKAGE_ROOT, evaluateMetroModule, transformLikeMetro } from '@/dev/testkit/performance/metroModuleEvaluation';

// The host module map is evaluated before the first Plugin UI program runs, during cold start.
const HOST_OWNED = /^(?:@happier-dev\/(?:protocol|plugin-ui|plugin-sdk)(?:\/|$)|\.\.?\/)/u;
// The Protocol-generated host tables are evaluated for real so their own requires are counted too.
const GENERATED_HOST_TABLE = /^@happier-dev\/protocol\/plugins\/ui\/(hostProvidedProtocolModule(?:s|Loaders)\.generated)$/u;
const protocolUiSource = resolve(UI_PACKAGE_ROOT, '../../packages/protocol/src/plugins/ui');

function evaluateCounting(filename: string, loaded: string[]): Record<string, unknown> {
    return evaluateMetroModule(transformLikeMetro(filename), (specifier) => {
        const table = GENERATED_HOST_TABLE.exec(specifier);
        if (table) return evaluateCounting(resolve(protocolUiSource, `${table[1]}.ts`), loaded);
        if (HOST_OWNED.test(specifier)) {
            loaded.push(specifier);
            return { __esModule: true, specifier };
        }
        // React, React Native and Zod are opaque values here.
        return { __esModule: true, external: specifier };
    });
}

describe('Plugin UI host module map under the Metro transform', () => {
    it('evaluates no Protocol, Plugin UI or SDK module until an artifact requires one, then only that one', () => {
        const loaded: string[] = [];
        const exports = evaluateCounting(resolve(UI_PACKAGE_ROOT, 'sources/components/plugins/reactNative/hostModules.ts'), loaded);
        expect(loaded.length, `required at load: ${loaded.slice(0, 6).join(', ')}`).toBe(0);

        const modules = exports.PLUGIN_UI_COMMON_JS_HOST_MODULES as Readonly<Record<string, unknown>>;
        expect(Object.isFrozen(modules)).toBe(true);
        expect(modules['@happier-dev/protocol/abortSignal']).toEqual({ __esModule: true, specifier: '@happier-dev/protocol/abortSignal' });
        expect(loaded).toEqual(['@happier-dev/protocol/abortSignal']);
    });
});
