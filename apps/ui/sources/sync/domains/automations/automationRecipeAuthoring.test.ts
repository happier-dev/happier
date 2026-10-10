import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { sealAutomationRecipePayloadForAuthoring } from './automationRecipeAuthoring';

// Account mode is an HTTP boundary; currentness and envelope decisions stay real.
vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({ fetchAccountEncryptionMode: vi.fn() }));

describe('Automation authoring Account envelope', () => {
    beforeEach(() => vi.clearAllMocks());
    it('writes plain context without requiring historical Account material', async () => {
        vi.mocked(fetchAccountEncryptionMode).mockResolvedValue({ mode: 'plain', updatedAt: 1 });
        const payload = { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } };
        await expect(sealAutomationRecipePayloadForAuthoring({ credentials: { token: 'token' }, payload }))
            .resolves.toEqual({ t: 'plain', v: payload });
    });
    it('refuses E2EE disclosure after authoring authority changes', async () => {
        vi.mocked(fetchAccountEncryptionMode).mockResolvedValue({ mode: 'e2ee', updatedAt: 1 });
        const currentness = [true, false];
        await expect(sealAutomationRecipePayloadForAuthoring({ credentials: { token: 'token' },
            payload: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } },
            encryptRaw: async () => 'sealed-context', isCurrent: () => currentness.shift() ?? false }))
            .rejects.toThrow('authority changed');
    });
});
