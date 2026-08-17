import { describe, it, expect } from 'vitest';

import { AGENT_IDS as SHARED_AGENT_IDS } from '@happier-dev/agents';

import {
    AGENT_IDS,
    DEFAULT_AGENT_ID,
    getAgentCore,
    resolveBundledAgentIdFromContributionIdentity,
} from './catalog';

describe('agents/catalog', () => {
    it('re-exports the UI-supported subset of shared agent ids', () => {
        expect(Array.from(SHARED_AGENT_IDS)).toEqual(expect.arrayContaining(Array.from(AGENT_IDS)));
        expect(AGENT_IDS.length).toBeLessThanOrEqual(SHARED_AGENT_IDS.length);
        expect(DEFAULT_AGENT_ID).toBe('claude');
    });

    it('composes core + ui + behavior for known agents', () => {
        for (const id of AGENT_IDS) {
            const core = getAgentCore(id);
            expect(core.id).toBe(id);
            expect(typeof core.displayNameKey).toBe('string');
            expect(typeof core.subtitleKey).toBe('string');
            expect(core.displayNameKey.startsWith('agentInput.')).toBe(true);
            expect(core.subtitleKey.length).toBeGreaterThan(0);
            expect(typeof core.cli.detectKey).toBe('string');
            expect(core.cli.detectKey.length).toBeGreaterThan(0);
            expect(typeof core.permissions.modeGroup).toBe('string');
            expect(typeof core.permissions.promptProtocol).toBe('string');
            expect(typeof core.availability.experimental).toBe('boolean');
        }
    });

    it('returns consistent core references for repeated lookups', () => {
        for (const id of AGENT_IDS) {
            expect(getAgentCore(id)).toBe(getAgentCore(id));
        }
    });

    it('resolves exact generated contribution identities without deriving the Agent id from localId', () => {
        expect(resolveBundledAgentIdFromContributionIdentity({
            pluginId: 'happier.agent.codex',
            localId: 'codex',
        })).toBe('codex');
        expect(resolveBundledAgentIdFromContributionIdentity({
            pluginId: 'happier.agent.ohmypi',
            localId: 'ohmypi',
        })).toBe('ohMyPi');
        expect(resolveBundledAgentIdFromContributionIdentity({
            pluginId: 'acme.colliding-agent',
            localId: 'codex',
        })).toBeNull();
    });

    it('has no UI-local vendor resume id writer competing with the shared projector', async () => {
        // `projectCurrentAgentSessionView` in `@happier-dev/agents` is the single
        // owner of the current-Agent view, including the one-flat-vendor-key
        // invariant. A catalog-local writer here would silently reintroduce the
        // multi-key state that makes a Session unresumable.
        const catalogModule = await import('./catalog') as Record<string, unknown>;

        expect(catalogModule.writeAgentVendorResumeIdToMetadata).toBeUndefined();
    });
});
