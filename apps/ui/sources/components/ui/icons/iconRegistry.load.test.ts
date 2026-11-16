import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UI_PACKAGE_ROOT, evaluateMetroModule, transformLikeMetro } from '@/dev/testkit/performance/metroModuleEvaluation';

// The registry is reached from the first screen; each icon module should load when it is first drawn.
const REGISTRY = resolve(UI_PACKAGE_ROOT, 'sources/components/ui/icons/iconRegistry.generated.ts');

describe('icon registry under the Metro transform', () => {
    it('evaluates no icon module at load and exactly one when an icon is read', () => {
        const loaded: string[] = [];
        const exports = evaluateMetroModule(transformLikeMetro(REGISTRY), (specifier) => {
            loaded.push(specifier);
            return { __esModule: true, [`${specifier.split('/').pop()}Icon`]: specifier };
        });
        expect(loaded.length, `required at load: ${loaded.slice(0, 4).join(', ')}`).toBe(0);

        const registry = exports.ICON_REGISTRY as Readonly<Record<string, unknown>>;
        expect(Object.hasOwn(registry, 'x')).toBe(true);
        expect(registry.x).toBe('phosphor-react-native/src/icons/X');
        expect(loaded).toEqual(['phosphor-react-native/src/icons/X']);
    });
});
