import { describe, expect, it } from 'vitest';

import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import { getAgentPickerOptions } from './agentPickerOptions';

describe('agents/agentPickerOptions', () => {
    it('returns options preserving caller order', () => {
        const selectedAgents: readonly AgentId[] = ['claude', 'codex', 'gemini'];
        const options = getAgentPickerOptions(selectedAgents);
        expect(options.map((option) => option.agentId)).toEqual(selectedAgents);
    });

    it('maps each selected agent to non-empty display metadata', () => {
        const options = getAgentPickerOptions(AGENT_IDS);
        for (const option of options) {
            expect(option.agentId).toBeTypeOf('string');
            expect(option.titleKey).toMatch(/^agentInput\./);
            expect(typeof option.subtitleKey).toBe('string');
            expect(typeof option.iconName).toBe('string');
            expect(option.iconName.length).toBeGreaterThan(0);
        }
    });

    it('returns an empty list for empty input', () => {
        expect(getAgentPickerOptions([])).toEqual([]);
    });
});
