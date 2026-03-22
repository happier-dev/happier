import { describe, expect, it } from 'vitest';

import { CUSTOM_ACP_UI_BEHAVIOR_OVERRIDE } from './uiBehavior';

describe('CUSTOM_ACP_UI_BEHAVIOR_OVERRIDE', () => {
    it('does not encode configured ACP backend selection into provider option state', () => {
        const result = CUSTOM_ACP_UI_BEHAVIOR_OVERRIDE.newSession?.buildNewSessionOptions?.({
            agentId: 'customAcp',
            agentOptionState: {
                configuredAcpBackendId: 'custom-preset',
            },
        });

        expect(result).toBeNull();
    });

    it('does not expose a legacy configured ACP backend chip in the agent-input action bar', () => {
        const result = CUSTOM_ACP_UI_BEHAVIOR_OVERRIDE.newSession?.getAgentInputExtraActionChips?.({
            agentId: 'customAcp',
            agentOptionState: {
                configuredAcpBackendId: 'custom-preset',
            },
            setAgentOptionState: () => {},
        });

        expect(result).toEqual([]);
    });

    it('does not use provider-local option state to bypass CLI detection anymore', () => {
        const result = CUSTOM_ACP_UI_BEHAVIOR_OVERRIDE.newSession?.canSelectWithoutDetectedCli?.({
            agentId: 'customAcp',
            settings: {} as any,
            agentOptionState: {
                configuredAcpBackendId: 'custom-preset',
            },
        });

        expect(result).toBe(false);
    });
});
