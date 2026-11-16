import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OPAQUE_MODULE, UI_PACKAGE_ROOT, evaluateMetroModule, transformLikeMetro } from '@/dev/testkit/performance/metroModuleEvaluation';

// Avatars render on the first screen; only the images they draw should be loaded.
const AVATAR = resolve(UI_PACKAGE_ROOT, 'sources/components/ui/avatar/AvatarBrutalist.tsx');

describe('AvatarBrutalist under the Metro transform', () => {
    it('loads no image asset module when the module evaluates', () => {
        const assets: string[] = [];
        evaluateMetroModule(transformLikeMetro(AVATAR), (specifier) => {
            if (/\.png$/u.test(specifier)) assets.push(specifier);
            return OPAQUE_MODULE;
        });
        expect(assets.length).toBe(0);
    });
});
