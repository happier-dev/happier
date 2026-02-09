import { describe, expect, it, vi } from 'vitest';

describe('permissionModeOptions i18n descriptions', () => {
    it('builds descriptions from translation keys instead of hardcoded English', async () => {
        vi.resetModules();
        vi.doMock('@/text', () => ({
            t: (key: string) => `tx:${key}`,
        }));

        const { getPermissionModeOptionsForAgentType } = await import('./permissionModeOptions');

        const codex = getPermissionModeOptionsForAgentType('codex');
        const claude = getPermissionModeOptionsForAgentType('claude');

        expect(codex.every((opt) => opt.description.startsWith('tx:'))).toBe(true);
        expect(claude.every((opt) => opt.description.startsWith('tx:'))).toBe(true);
    });
});
