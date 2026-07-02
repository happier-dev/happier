import { describe, expect, it, vi } from 'vitest';

vi.mock('./generatedBundledPluginEntries.messageMetaOverrides', () => ({
    BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_DESCRIPTORS: {},
    BUNDLED_PROVIDER_MESSAGE_META_OVERRIDE_BUILDERS: {
        claude: () => {
            throw new Error('broken generated descriptor adapter');
        },
    },
}));

import { resolveProviderRegisteredMessageMetaOverrides } from './providerMessageMetaOverrides';

describe('resolveProviderRegisteredMessageMetaOverrides', () => {
    it('fails closed when a generated descriptor adapter throws', () => {
        expect(resolveProviderRegisteredMessageMetaOverrides({
            agentId: 'claude',
            session: {},
            metaOverrides: { keep: true },
        })).toEqual({ keep: true });
    });
});
