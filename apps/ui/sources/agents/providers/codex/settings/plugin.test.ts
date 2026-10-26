import { describe, expect, it } from 'vitest';

import { applySettings, settingsParse } from '@/sync/domains/settings/settings';

import { CODEX_PROVIDER_SETTINGS_PLUGIN } from './plugin';

describe('CODEX_PROVIDER_SETTINGS_PLUGIN', () => {
    it('offers native defaults and explicit reasoning summary generation choices independently of display', () => {
        const summaryField = CODEX_PROVIDER_SETTINGS_PLUGIN.uiSections
            .flatMap((section) => section.fields)
            .find((field) => field.key === 'codexReasoningSummaries');

        expect(summaryField?.kind).toBe('enum');
        expect(summaryField?.enumOptions?.map((option) => option.id)).toEqual(['default', 'enabled', 'disabled']);

        const original = settingsParse({ sessionThinkingDisplayMode: 'hidden' });
        expect(original.codexReasoningSummaries).toBe('default');

        const enabled = settingsParse(applySettings(original, { codexReasoningSummaries: 'enabled' }));
        expect(enabled.codexReasoningSummaries).toBe('enabled');
        expect(enabled.sessionThinkingDisplayMode).toBe('hidden');

        const visible = settingsParse(applySettings(enabled, { sessionThinkingDisplayMode: 'inline' }));
        expect(visible.codexReasoningSummaries).toBe('enabled');
        expect(visible.sessionThinkingDisplayMode).toBe('inline');
        expect(settingsParse({ codexReasoningSummaries: 'invalid' }).codexReasoningSummaries).toBe('default');
    });

    it('surfaces appServer as the default Codex backend option', () => {
        const backendField = CODEX_PROVIDER_SETTINGS_PLUGIN.uiSections
            .flatMap((section) => section.fields)
            .find((field) => field.key === 'codexBackendMode');

        expect(backendField?.kind).toBe('enum');
        expect(backendField?.enumOptions?.map((option) => option.id)).toEqual([
            'appServer',
            'acp',
            'mcp',
        ]);
    });
});
