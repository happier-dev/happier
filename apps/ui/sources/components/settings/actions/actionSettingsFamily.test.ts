import { describe, expect, it } from 'vitest';

import {
    ACTION_SETTINGS_FAMILY_ORDER,
    resolveActionSettingsFamily,
} from './actionSettingsFamily';

describe('resolveActionSettingsFamily', () => {
    it('maps runtime browser actions to the browser family', () => {
        expect(resolveActionSettingsFamily('browser.navigate')).toBe('browser');
        expect(resolveActionSettingsFamily('browser.automation.snapshot')).toBe('browser');
        expect(resolveActionSettingsFamily('browser.recording.start')).toBe('browser');
    });

    it('maps simulator device actions to the simulator family', () => {
        expect(resolveActionSettingsFamily('devices.simulator.input.tap')).toBe('simulator');
        expect(resolveActionSettingsFamily('devices.simulator.stream.keyframe')).toBe('simulator');
    });

    it('maps local-services actions to the localServices family', () => {
        expect(resolveActionSettingsFamily('localServices.publicPreview.create')).toBe('localServices');
        expect(resolveActionSettingsFamily('localServices.actions.stopManaged')).toBe('localServices');
    });

    it('maps plugin permission-grant actions to the plugins family', () => {
        expect(resolveActionSettingsFamily('plugins.permissions.grants.grant')).toBe('plugins');
    });

    it('maps session/core actions to the session family', () => {
        expect(resolveActionSettingsFamily('session.stop')).toBe('session');
        expect(resolveActionSettingsFamily('session.message.send')).toBe('session');
    });

    it('falls back to the general family for unclassified actions', () => {
        expect(resolveActionSettingsFamily('memory.search')).toBe('general');
    });

    it('exposes a stable family order with runtime families ahead of general', () => {
        expect(ACTION_SETTINGS_FAMILY_ORDER).toContain('browser');
        expect(ACTION_SETTINGS_FAMILY_ORDER).toContain('simulator');
        expect(ACTION_SETTINGS_FAMILY_ORDER).toContain('localServices');
        expect(ACTION_SETTINGS_FAMILY_ORDER).toContain('plugins');
        expect(ACTION_SETTINGS_FAMILY_ORDER[ACTION_SETTINGS_FAMILY_ORDER.length - 1]).toBe('general');
    });
});
