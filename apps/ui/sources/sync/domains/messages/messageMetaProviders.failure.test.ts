import { describe, expect, it, vi } from 'vitest';

const buildOverridesMock = vi.hoisted(() => vi.fn());

vi.mock('@/agents/registry/registryUiBehavior', async () => {
    const { createRegistryUiBehaviorModuleMock } = await import('@/dev/testkit/mocks/registryUiBehavior');
    return createRegistryUiBehaviorModuleMock({
        resolveAgentUiBehavior: () => ({
            message: {
                buildOverrides: buildOverridesMock,
            },
        }),
    });
});

import { resolveProviderMessageMetaOverrides } from '@/sync/domains/messages/messageMetaProviders';

describe('resolveProviderMessageMetaOverrides provider failures', () => {
    it('keeps caller overrides but emits a sanitized diagnostic when provider overrides throw', () => {
        buildOverridesMock.mockImplementationOnce(() => {
            throw new Error('boom secret-token');
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const passthrough = {
            happier: {
                kind: 'review_comments.v1',
                payload: { sessionId: 's1', comments: [] },
            },
        } as const;

        try {
            expect(resolveProviderMessageMetaOverrides({
                agentId: 'claude',
                session: { id: 's1' },
                metaOverrides: passthrough,
            })).toEqual(passthrough);

            expect(errorSpy).toHaveBeenCalledWith(
                '[messageMetaProviders] provider message metadata overrides failed',
                {
                    agentId: 'claude',
                    errorName: 'Error',
                },
            );
        } finally {
            errorSpy.mockRestore();
        }
    });
});
