import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks } from './sessionSettingsEntryTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSettingsEntryModuleMocks();

describe('legacy prompts library route', () => {
    it('redirects back to the prompts settings home', async () => {
        const module = await import('@/app/(app)/settings/prompts/library');

        const screen = await renderScreen(React.createElement(module.default));
        const redirect = screen.findByType('Redirect' as any);

        expect(redirect.props.href).toBe('/settings/prompts');
    });
});
