import { describe, expect, it } from 'vitest';

import { PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS } from '@happier-dev/protocol/plugins/ui';

import { PLUGIN_UI_COMMON_JS_HOST_MODULES } from './hostModules';

describe('PLUGIN_UI_COMMON_JS_HOST_MODULES', () => {
    it('provides exactly the Protocol-owned exhaustive host family', () => {
        expect(Object.keys(PLUGIN_UI_COMMON_JS_HOST_MODULES)).toEqual([
            ...PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
        ]);
        expect(Object.isFrozen(PLUGIN_UI_COMMON_JS_HOST_MODULES)).toBe(true);
    });

    it('exposes author components while keeping private/runtime packages out', () => {
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES['@happier-dev/plugin-ui']).toBeDefined();
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES['@happier-dev/plugin-ui/components']).toBeDefined();
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES['@happier-dev/plugin-ui/data']).toBeDefined();
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES).not.toHaveProperty('@happier-dev/plugin-ui/presentation');
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES).not.toHaveProperty('@happier-dev/plugin-ui/presentation/typeScale');
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES).not.toHaveProperty('@happier-dev/plugin-ui/testing');
        expect(Object.getOwnPropertyDescriptor(PLUGIN_UI_COMMON_JS_HOST_MODULES, '@happier-dev/plugin-sdk')?.get).toBeTypeOf('function');
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES).not.toHaveProperty('@happier-dev/protocol');
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES.zod).toBeDefined();
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES['zod/mini']).toBeDefined();
    });
});
