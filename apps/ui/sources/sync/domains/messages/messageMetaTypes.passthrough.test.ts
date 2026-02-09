import { describe, expect, it } from 'vitest';

import { MessageMetaSchema } from '@/sync/domains/messages/messageMetaTypes';

describe('MessageMetaSchema passthrough', () => {
    it('preserves unknown provider-specific keys for forward compatibility', () => {
        const parsed = MessageMetaSchema.parse({
            source: 'ui',
            sentFrom: 'e2e',
            permissionMode: 'default',
            appendSystemPrompt: 'SYSTEM',
            claudeRemoteAgentSdkEnabled: true,
        });

        expect(parsed.sentFrom).toBe('e2e');
        expect((parsed as any).claudeRemoteAgentSdkEnabled).toBe(true);
    });

    it('drops dangerous prototype-related keys while preserving safe unknown keys', () => {
        const payload = JSON.parse(
            '{"source":"ui","safeProviderFlag":true,"__proto__":{"polluted":true},"constructor":{"prototype":{"evil":true}},"prototype":{"x":1}}',
        );
        const parsed = MessageMetaSchema.parse(payload);

        expect((parsed as any).safeProviderFlag).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(parsed, 'constructor')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(parsed, 'prototype')).toBe(false);

        const merged: Record<string, unknown> = {};
        Object.assign(merged, parsed);
        expect(({} as any).polluted).toBeUndefined();
        expect(({} as any).evil).toBeUndefined();
    });
});
