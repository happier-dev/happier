import { describe, expect, it } from 'vitest';

import {
    resolveAgentUiBehavior,
    resolveBundledAgentUiBehaviorProjection,
} from '@/agents/registry/registryUiBehavior';
import { createRegistryUiBehaviorModuleMock } from './registryUiBehavior';

describe('createRegistryUiBehaviorModuleMock', () => {
    it('keeps an external Agent identity out of bundled behavior projection', () => {
        const registry = createRegistryUiBehaviorModuleMock();

        expect(registry.resolveBundledAgentUiBehaviorProjection('acme.agent')).toBeNull();
    });
});

describe('Agent UI behavior identity boundaries', () => {
    it('keeps an external Agent neutral rather than projecting it as a bundled Agent', () => {
        expect(resolveBundledAgentUiBehaviorProjection('acme.agent')).toBeNull();
        expect(resolveAgentUiBehavior('acme.agent').agentId).toBeUndefined();
    });
});
