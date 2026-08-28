import { describe, expect, it } from 'vitest';

import { BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES } from '@/agents/registry/generatedBundledPluginEntries';

import { resolveNewSessionOperationalProviderId } from './newSessionCapabilityProbeContext';

/**
 * Operational provider identity for New Session ACP config-option controls.
 *
 * Regression contract: a configured ACP backend must key its provider
 * identity by `backendTarget.configuredBackendId ?? backendTarget.backendId`
 * (the canonical `providerId` in `NewSessionEngineOptionDetail`), never by
 * the resolved catalog entry's generic `entry.backendId` carrier — a
 * discovered configured target can carry a backend carrier id that differs
 * from the configured backend the user actually selected.
 * `NewSessionFavoriteModelsDetail` consumes this owner at both its provider
 * option and sanitization sites so the two panes cannot diverge.
 */
describe('resolveNewSessionOperationalProviderId', () => {
    it('keys a configured ACP backend by its configured backend id, not the backend carrier id', () => {
        expect(resolveNewSessionOperationalProviderId({
            backendTarget: { kind: 'backend', backendId: 'provider-x', configuredBackendId: 'my-preset' },
            runtimeCarrierAgentId: 'provider-x',
        })).toBe('my-preset');
    });

    it('falls back to the backend carrier id when no configured backend id exists', () => {
        expect(resolveNewSessionOperationalProviderId({
            backendTarget: { kind: 'backend', backendId: 'claude' },
            runtimeCarrierAgentId: 'claude',
        })).toBe('claude');
    });

    it('resolves an Agent-carrier target through the operational runtime carrier', () => {
        expect(resolveNewSessionOperationalProviderId({
            backendTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'provider' } },
            runtimeCarrierAgentId: 'acme.review.provider',
        })).toBe('acme.review.provider');
    });

    it('resolves a bundled Agent carrier to its bundled agent id', () => {
        expect(resolveNewSessionOperationalProviderId({
            backendTarget: { kind: 'agent', identity: BUNDLED_CANONICAL_AGENT_CONTRIBUTION_IDENTITIES.claude },
            runtimeCarrierAgentId: 'claude',
        })).toBe('claude');
    });
});
