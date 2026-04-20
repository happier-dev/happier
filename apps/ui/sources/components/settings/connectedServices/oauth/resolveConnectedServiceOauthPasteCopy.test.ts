import { describe, expect, it, vi } from 'vitest';

import { getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('resolveConnectedServiceOauthPasteCopy', () => {
    it('projects the Claude paste copy from connected service registry metadata', async () => {
        const entry = getConnectedServiceRegistryEntry('claude-subscription');
        const { resolveConnectedServiceOauthPasteCopy } = await import('./resolveConnectedServiceOauthPasteCopy');

        const copy = resolveConnectedServiceOauthPasteCopy('claude-subscription');

        expect(copy.connectWebDescription).toBe(`${entry.oauthPasteCopyKeyPrefix}.connectWebDescription`);
        expect(copy.pasteRedirectUrlPromptBody).toBe(`${entry.oauthPasteCopyKeyPrefix}.pasteRedirectUrlPromptBody`);
        expect(copy.pasteRedirectUrlPlaceholder).toBe(`${entry.oauthPasteCopyKeyPrefix}.pasteRedirectUrlPlaceholder`);
        expect(copy.missingStateError).toBe(`${entry.oauthPasteCopyKeyPrefix}.errors.missingState`);
    });
});
