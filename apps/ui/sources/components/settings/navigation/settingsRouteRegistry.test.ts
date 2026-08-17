import { describe, expect, it } from 'vitest';

import {
    getSettingsStackScreenDefinitions,
    resolveSettingsRouteParentPathname,
} from './settingsRouteRegistry';

const translate = (key: string) => key;

describe('settingsRouteRegistry', () => {
    it('adds deterministic parent navigation to settings subroute headers', () => {
        const definitions = getSettingsStackScreenDefinitions(translate as never);
        const indexRoute = definitions.find((definition) => definition.name === 'index');
        const sessionRoute = definitions.find((definition) => definition.name === 'session');

        expect(indexRoute?.options.headerLeft).toBeUndefined();
        expect(typeof sessionRoute?.options.headerLeft).toBe('function');
    });

    it('resolves route parent paths from the current settings pathname', () => {
        expect(resolveSettingsRouteParentPathname('/settings')).toBeNull();
        expect(resolveSettingsRouteParentPathname('/settings/session')).toBe('/settings');
        expect(resolveSettingsRouteParentPathname('/settings/session/transcript/advanced')).toBe('/settings/session/transcript');
        expect(resolveSettingsRouteParentPathname('/settings/prompts/docs/doc%2F1/export')).toBe('/settings/prompts/docs/doc%2F1');
        expect(resolveSettingsRouteParentPathname('/settings/plugins/examples.descriptor-only/settings')).toBe('/settings/plugins/examples.descriptor-only');
        expect(resolveSettingsRouteParentPathname('/session/s1')).toBeNull();
    });

    it('registers model-management and native plugin-panel routes', () => {
        const names = getSettingsStackScreenDefinitions(translate as never).map((definition) => definition.name);
        expect(names).toContain('providers/[connectionId]/models');
        expect(names).toContain('agents/[agentId]/models');
        expect(names).toContain('plugins/panels');
        expect(names).toContain('plugins/webhooks');
        expect(names).toContain('plugins/[pluginId]/[pageId]');
    });

    it('registers each Voice intent as a nested settings destination', () => {
        const names = getSettingsStackScreenDefinitions(translate as never).map((definition) => definition.name);

        expect(names).toEqual(expect.arrayContaining([
            'voice/dictation',
            'voice/conversations',
            'voice/privacy',
            'voice/advanced',
        ]));
    });
});
