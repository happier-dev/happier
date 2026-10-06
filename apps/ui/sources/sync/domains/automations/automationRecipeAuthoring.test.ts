import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES } from '@happier-dev/protocol';

import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

import { buildAutomationRecipeFromSessionAuthoring, openAutomationRecipeForAuthoring } from './automationRecipeAuthoring';

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: vi.fn(),
}));

describe('buildAutomationRecipeFromSessionAuthoring', () => {
    beforeEach(() => vi.clearAllMocks());

    it('builds the strict plain recipe for an existing Session without a legacy template envelope', async () => {
        vi.mocked(fetchAccountEncryptionMode).mockResolvedValue({ mode: 'plain', updatedAt: 1 });

        await expect(buildAutomationRecipeFromSessionAuthoring({
            credentials: { token: 'token' },
            templateVersion: 1,
            prompt: 'Review this turn',
            target: { kind: 'existingSession', sessionId: 'target-session' },
        })).resolves.toEqual({
            v: 1,
            templateVersion: 1,
            template: { t: 'plain', v: { v: 1, prompt: 'Review this turn' } },
            triggerEvidence: null,
            target: { kind: 'existingSession', sessionId: 'target-session' },
        });
    });

    it('seals only the prompt program for an E2EE Account and rechecks currentness after encryption', async () => {
        vi.mocked(fetchAccountEncryptionMode).mockResolvedValue({ mode: 'e2ee', updatedAt: 1 });
        const currentness = [true, false];

        await expect(buildAutomationRecipeFromSessionAuthoring({
            credentials: { token: 'token' },
            templateVersion: 1,
            prompt: 'Review this turn',
            target: { kind: 'existingSession', sessionId: 'target-session' },
            encryptRaw: vi.fn(async () => 'sealed-program'),
            isCurrent: () => currentness.shift() ?? false,
        })).rejects.toThrow('authority changed');
    });

    it.each(['plain', 'e2ee'] as const)('enforces the template input bound before sealing for a %s Account', async (mode) => {
        vi.mocked(fetchAccountEncryptionMode).mockResolvedValue({ mode, updatedAt: 1 });
        const encryptRaw = vi.fn(async () => 'sealed-program');
        await expect(buildAutomationRecipeFromSessionAuthoring({
            credentials: { token: 'token' },
            templateVersion: 1,
            prompt: 'x'.repeat(MAX_AUTOMATION_MATERIALIZED_INPUT_UTF8_BYTES + 1),
            target: { kind: 'existingSession', sessionId: 'target-session' },
            encryptRaw,
        })).rejects.toThrow();
        expect(encryptRaw).not.toHaveBeenCalled();
    });

});

describe('openAutomationRecipeForAuthoring', () => {
    it.each(['plain', 'encrypted'] as const)('opens unknown stored %s program fields', async (mode) => {
        const template = { v: 1, prompt: 'Review', extra: true };
        const recipe = { v: 1 as const, templateVersion: 3, triggerEvidence: null, extra: true,
            target: { kind: 'existingSession' as const, sessionId: 'session-1', extra: true },
            template: mode === 'plain' ? { t: 'plain' as const, v: template, extra: true } : { t: 'encrypted' as const, c: 'opaque', extra: true } };
        await expect(openAutomationRecipeForAuthoring({ recipe, decryptRaw: async () => template })).resolves.toEqual({ v: 1, prompt: 'Review' });
    });
    it('opens the same canonical program from plain and encrypted stored recipes', async () => {
        const base = {
            v: 1 as const,
            templateVersion: 3,
            triggerEvidence: null,
            target: { kind: 'existingSession' as const, sessionId: 'session-1' },
        };
        await expect(openAutomationRecipeForAuthoring({
            recipe: { ...base, template: { t: 'plain', v: { v: 1, prompt: 'Review', mentions: [] } } },
        })).resolves.toEqual({ v: 1, prompt: 'Review', mentions: [] });
        await expect(openAutomationRecipeForAuthoring({
            recipe: { ...base, template: { t: 'encrypted', c: 'opaque' } },
            decryptRaw: async () => ({ v: 1, prompt: 'Review', mentions: [] }),
        })).resolves.toEqual({ v: 1, prompt: 'Review', mentions: [] });
    });
});
