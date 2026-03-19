import { describe, expect, it } from 'vitest';

import { CODEX_PROVIDER_SETTINGS_PLUGIN } from './plugin';

describe('CODEX_PROVIDER_SETTINGS_PLUGIN', () => {
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
