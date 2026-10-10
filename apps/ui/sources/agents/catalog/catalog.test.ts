import { afterEach, describe, it, expect } from 'vitest';
import { clearProjectedAgentUiBehaviorDescriptors, publishProjectedAgentUiBehaviorDescriptors } from '../registry/agentUiBehaviorProjection';
import { readProjectedAgentUiBehaviorDescriptors } from '../backendCatalog/daemonContributionRegistryProjectionAdapters';

import { AGENT_IDS as SHARED_AGENT_IDS, getAgentLocalCliConfig } from '@happier-dev/agents';

import {
    AGENT_IDS,
    DEFAULT_AGENT_ID,
    getAgentCore,
    getAgentIdentityColor,
    resolveBundledAgentIdFromContributionIdentity,
} from './catalog';

describe('agents/catalog', () => {
    afterEach(clearProjectedAgentUiBehaviorDescriptors);

    it('resolves contributed identity hues and uses one neutral floor for Agents without a hue', () => {
        const light = { dark: false };
        const dark = { dark: true };
        expect(getAgentIdentityColor(light, 'claude')).toBe('#eb6834');
        expect(getAgentIdentityColor(dark, 'claude')).toBe('#d95926');
        expect(new Set(['claude', 'codex', 'gemini', 'opencode', 'pi'].map((id) => getAgentIdentityColor(light, id))).size).toBe(5);
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'identity-colors',
            accountLifetime: { isCurrent: () => true },
            descriptorsByAgentId: readProjectedAgentUiBehaviorDescriptors({
                'acme.assistant': {
                    agentId: 'acme.assistant',
                    identity: { pluginId: 'acme.colors', localId: 'assistant' },
                    ui: { identityColor: { light: '#112233', dark: '#aabbcc' } },
                },
                'acme.malformed': {
                    agentId: 'acme.malformed',
                    identity: { pluginId: 'acme.colors', localId: 'malformed' },
                    ui: { identityColor: { light: 'red', dark: '#aabbcc' } },
                },
                claude: {
                    agentId: 'claude',
                    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                    ui: { behavior: {} },
                },
            }),
        });
        expect(getAgentIdentityColor(light, 'claude')).toBe('#eb6834');
        expect(getAgentIdentityColor(light, 'acme.assistant')).toBe('#112233');
        expect(getAgentIdentityColor(dark, 'acme.assistant')).toBe('#aabbcc');
        expect(getAgentIdentityColor(light, 'acme.malformed')).toBe(getAgentIdentityColor(light, 'unknown'));
        clearProjectedAgentUiBehaviorDescriptors();
        expect(getAgentIdentityColor(light, 'acme.assistant')).toBe(getAgentIdentityColor(light, 'unknown'));
    });

    it('re-exports the UI-supported subset of shared agent ids', () => {
        expect(Array.from(SHARED_AGENT_IDS)).toEqual(expect.arrayContaining(Array.from(AGENT_IDS)));
        expect(AGENT_IDS.length).toBeLessThanOrEqual(SHARED_AGENT_IDS.length);
        expect(DEFAULT_AGENT_ID).toBe('claude');
    });

    it('composes core + ui + behavior for known agents', () => {
        for (const id of AGENT_IDS) {
            const core = getAgentCore(id);
            if (!core) throw new Error(`Missing admitted core: ${id}`);
            expect(core.id).toBe(id);
            expect(typeof core.displayNameKey).toBe('string');
            expect(typeof core.subtitleKey).toBe('string');
            expect(core.displayNameKey.startsWith('agentInput.')).toBe(true);
            expect(core.subtitleKey.length).toBeGreaterThan(0);
            expect(core.cli === null).toBe(getAgentLocalCliConfig(id) === null);
            if (core.cli) {
                expect(typeof core.cli.detectKey).toBe('string');
                expect(core.cli.detectKey.length).toBeGreaterThan(0);
            }
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
