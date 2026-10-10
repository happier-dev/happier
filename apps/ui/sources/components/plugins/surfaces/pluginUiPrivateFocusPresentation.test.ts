import { describe, expect, it } from 'vitest';
import { createPluginUiPrivateFocusPresentation } from './pluginUiPrivateFocusPresentation';
import { createFindSurfaceRegistry } from '@/keyboard/findSurfaceRegistry';
import { executeFindAction, registerFindActionRuntime } from '@/keyboard/findActionRuntime';
import type { FindController } from '@happier-dev/plugin-ui/presentation';

describe('mounted plugin Find presentation', () => {
    it('joins the incumbent keyboard/Action registry and rechecks layout eligibility on old handles', async () => {
        const registry = createFindSurfaceRegistry();
        const releaseRuntime = registerFindActionRuntime(registry);
        let eligible = true;
        let opened = false;
        let controller: FindController = { query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
            capabilities: { regex: true, stop: false }, setQuery() {}, setOptions() {}, step() {}, stop() {}, close() {} };
        const host = createPluginUiPrivateFocusPresentation({ isFocusEligible: () => eligible, focusTarget: () => true,
            find: { register: registry.register, refresh() {} } });
        try {
            expect(host?.find).toBeDefined();
            const dispose = host!.find!.register({ surfaceId: 'com.example.notes:body', get controller() { return controller; },
                containsFocus: () => true, open() { opened = true; }, isOpen: () => opened, isInputFocused: () => false });
            expect(registry.command('find.open')).toBe('handled');
            expect(opened).toBe(true);
            expect(await executeFindAction({ actionId: 'ui.find', input: { op: 'read', target: 'com.example.notes:body' }, context: { surface: 'agent' } }))
                .toEqual({ ok: true, result: { status: 'idle' } });
            controller = { ...controller, status: { kind: 'results', current: 1, total: 4, coverage: 'loaded' } };
            expect(await executeFindAction({ actionId: 'ui.find', input: { op: 'read', target: 'com.example.notes:body' }, context: { surface: 'agent' } }))
                .toEqual({ ok: true, result: { status: 'results', current: 1, total: 4, coverage: 'loaded' } });
            eligible = false;
            expect(host?.focusTarget({})).toBe(false);
            expect(registry.command('find.open')).toBe('pass');
            expect(await executeFindAction({ actionId: 'ui.find', input: { op: 'read', target: 'com.example.notes:body' }, context: { surface: 'agent' } }))
                .toEqual({ ok: true, result: { status: 'noMountedSurface' } });
            dispose();
            eligible = true;
            expect(registry.resolve('com.example.notes:body')).toBeUndefined();
        } finally { releaseRuntime(); }
    });
});
