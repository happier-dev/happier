import { describe, expect, it } from 'vitest';

import { AGENT_IDS, getAgentAdvancedModeCapabilities, type AgentId, type AgentRuntimeModeSwitchKind } from '@happier-dev/agents';

describe('getAgentAdvancedModeCapabilities', () => {
    it('matches expected capabilities for representative providers', () => {
        const cases: Array<{
            agentId: AgentId;
            supportsPlanMode: boolean;
            supportsAcceptEdits: boolean;
            supportsRuntimeModeSwitch: AgentRuntimeModeSwitchKind;
        }> = [
            { agentId: 'claude', supportsPlanMode: true, supportsAcceptEdits: true, supportsRuntimeModeSwitch: 'provider-native' },
            { agentId: 'opencode', supportsPlanMode: true, supportsAcceptEdits: false, supportsRuntimeModeSwitch: 'acp-setSessionMode' },
            { agentId: 'codex', supportsPlanMode: false, supportsAcceptEdits: false, supportsRuntimeModeSwitch: 'metadata-gating' },
        ];

        for (const testCase of cases) {
            expect(getAgentAdvancedModeCapabilities(testCase.agentId)).toMatchObject({
                supportsPlanMode: testCase.supportsPlanMode,
                supportsAcceptEdits: testCase.supportsAcceptEdits,
                supportsRuntimeModeSwitch: testCase.supportsRuntimeModeSwitch,
            });
        }
    });

    it('returns valid runtime switch kinds for all canonical agents', () => {
        const validKinds: readonly AgentRuntimeModeSwitchKind[] = [
            'none',
            'metadata-gating',
            'acp-setSessionMode',
            'provider-native',
        ];

        for (const agentId of AGENT_IDS) {
            expect(validKinds).toContain(getAgentAdvancedModeCapabilities(agentId).supportsRuntimeModeSwitch);
        }
    });

    it('keeps accept-edits exclusive to claude', () => {
        for (const agentId of AGENT_IDS) {
            expect(getAgentAdvancedModeCapabilities(agentId).supportsAcceptEdits).toBe(agentId === 'claude');
        }
    });

    it('is deterministic across repeated calls', () => {
        for (const agentId of AGENT_IDS) {
            expect(getAgentAdvancedModeCapabilities(agentId)).toEqual(getAgentAdvancedModeCapabilities(agentId));
        }
    });
});
