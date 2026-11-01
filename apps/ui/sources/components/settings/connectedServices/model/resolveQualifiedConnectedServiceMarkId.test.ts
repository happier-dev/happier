import { describe, expect, it } from 'vitest';

import { resolveQualifiedConnectedServiceMarkId } from './resolveQualifiedConnectedServiceMarkId';

describe('resolveQualifiedConnectedServiceMarkId', () => {
    it('resolves the generated mark alias only for the exact qualified service owner', () => {
        expect(resolveQualifiedConnectedServiceMarkId({ entries: [] }, {
            pluginId: 'happier.agent.claude', localId: 'claude-subscription',
        })).toBe('claude-subscription');
        expect(resolveQualifiedConnectedServiceMarkId({ entries: [] }, {
            pluginId: 'external.plugin', localId: 'claude-subscription',
        })).toBeNull();
    });

    it('uses the applied catalog alias without treating a descriptor service id as a brand', () => {
        const service = { pluginId: 'external.plugin', localId: 'account' };
        expect(resolveQualifiedConnectedServiceMarkId({ entries: [{
            service, serviceId: 'openai', legacyServiceId: 'claude-subscription', connectCommand: '', supportsOauth: false,
        }] }, service)).toBe('claude-subscription');
        expect(resolveQualifiedConnectedServiceMarkId({ entries: [{
            service, serviceId: 'openai', connectCommand: '', supportsOauth: false,
        }] }, service)).toBeNull();
    });
});
