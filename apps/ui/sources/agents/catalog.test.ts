import { describe, it, expect } from 'vitest';

import { AGENT_IDS as SHARED_AGENT_IDS } from '@happier-dev/agents';

import { AGENT_IDS, DEFAULT_AGENT_ID, getAgentCore } from './catalog';

describe('agents/catalog', () => {
    it('re-exports the canonical shared agent id list', () => {
        // Reference equality ensures we’re not accidentally redefining the list in Expo.
        expect(AGENT_IDS).toBe(SHARED_AGENT_IDS);
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
});
