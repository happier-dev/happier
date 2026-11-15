import { describe, expect, it } from 'vitest';

import { PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS } from '@happier-dev/protocol/plugins/ui';
import { PLUGIN_UI_HOST_PROVIDED_PROTOCOL_SPECIFIERS } from '@happier-dev/protocol/plugins/ui/hostProvidedProtocolSubpaths.generated';

import { PLUGIN_UI_COMMON_JS_HOST_MODULES } from './hostModules';

describe('PLUGIN_UI_COMMON_JS_HOST_MODULES', () => {
    it('provides exactly the Protocol-owned exhaustive host family, including every generated Protocol subpath', () => {
        expect(Object.keys(PLUGIN_UI_COMMON_JS_HOST_MODULES).sort()).toEqual([
            ...PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS,
            ...PLUGIN_UI_HOST_PROVIDED_PROTOCOL_SPECIFIERS,
        ].sort());
        expect(Object.isFrozen(PLUGIN_UI_COMMON_JS_HOST_MODULES)).toBe(true);
    });

    it('exposes author components while keeping private/runtime packages out', () => {
        // Author families load on an artifact's first require (hostModules.load.test.ts).
        for (const specifier of ['@happier-dev/plugin-ui', '@happier-dev/plugin-ui/components', '@happier-dev/plugin-ui/data', '@happier-dev/protocol']) {
            expect(Object.getOwnPropertyDescriptor(PLUGIN_UI_COMMON_JS_HOST_MODULES, specifier)?.get).toBeTypeOf('function');
        }
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES).not.toHaveProperty('@happier-dev/plugin-ui/presentation');
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES).not.toHaveProperty('@happier-dev/plugin-ui/presentation/typeScale');
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES).not.toHaveProperty('@happier-dev/plugin-ui/testing');
        expect(Object.getOwnPropertyDescriptor(PLUGIN_UI_COMMON_JS_HOST_MODULES, '@happier-dev/plugin-sdk')?.get).toBeTypeOf('function');
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES.zod).toBeDefined();
        expect(PLUGIN_UI_COMMON_JS_HOST_MODULES['zod/mini']).toBeDefined();
    });
});
