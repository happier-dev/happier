import { beforeEach, describe, expect, it, vi } from 'vitest';

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

});

describe('openAutomationRecipeForAuthoring', () => {
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
