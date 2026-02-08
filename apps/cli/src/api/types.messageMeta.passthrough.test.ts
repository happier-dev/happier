import { describe, expect, it } from 'vitest';

import { MessageMetaSchema } from '@/api/types';

describe('MessageMetaSchema', () => {
    it('preserves unknown provider-specific keys', () => {
        const parsed = MessageMetaSchema.parse({
            source: 'ui',
            sentFrom: 'e2e',
            claudeRemoteAgentSdkEnabled: true,
        });

        expect(parsed.sentFrom).toBe('unknown');
        expect((parsed as any).claudeRemoteAgentSdkEnabled).toBe(true);
    });
});
