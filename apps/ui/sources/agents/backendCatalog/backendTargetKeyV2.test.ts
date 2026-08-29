import { describe, expect, it } from 'vitest';

import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';

import {
    backendTargetKeysMatch,
    resolveBackendTargetKeyV2,
} from './backendTargetKeyV2';

describe('resolveBackendTargetKeyV2', () => {
    it('derives one canonical qualified key for a bundled Agent regardless of input vocabulary', () => {
        const fromAgentIdentity = resolveBackendTargetKeyV2({
            kind: 'agent',
            identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES.claude,
        });
        const fromBackendRef = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
        const fromPersistedRef = resolveBackendTargetKeyV2({
            kind: 'backend',
            backendId: 'claude',
            sourceKind: 'built_in',
        });
        const fromLegacyKey = resolveBackendTargetKeyV2('backend:claude');

        expect(fromAgentIdentity).toBe('agent:happier.agent.claude/claude');
        expect(fromBackendRef).toBe(fromAgentIdentity);
        expect(fromPersistedRef).toBe(fromAgentIdentity);
        expect(fromLegacyKey).toBe(fromAgentIdentity);
    });

    it('keeps configured ACP instances and unknown backend ids distinct from the canonical Agent key', () => {
        expect(resolveBackendTargetKeyV2({
            kind: 'backend',
            backendId: 'custom-acp',
            configuredBackendId: 'instance-1',
        })).toBe('backend:custom-acp:configured:instance-1');
        expect(resolveBackendTargetKeyV2('backend:custom-acp:configured:instance-1'))
            .toBe('backend:custom-acp:configured:instance-1');
        expect(resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'totally-custom-plugin-agent' }))
            .toBe('backend:totally-custom-plugin-agent');
    });

    it('matches persisted legacy keys against their canonical Agent target', () => {
        expect(backendTargetKeysMatch('backend:claude', 'agent:happier.agent.claude/claude')).toBe(true);
        expect(backendTargetKeysMatch('backend:codex', 'agent:happier.agent.codex/codex')).toBe(true);
        expect(backendTargetKeysMatch('backend:claude', 'agent:happier.agent.codex/codex')).toBe(false);
        expect(backendTargetKeysMatch('backend:custom-acp:configured:instance-1', 'backend:custom-acp')).toBe(false);
        expect(backendTargetKeysMatch('not-a-key', 'backend:claude')).toBe(false);
    });
});
