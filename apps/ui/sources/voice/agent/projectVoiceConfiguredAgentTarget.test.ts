import { describe, expect, it } from 'vitest';

import { projectVoiceConfiguredAgentTarget } from './projectVoiceConfiguredAgentTarget';

describe('released raw-id Voice Agent selection', () => {
    it.each([false, true])('honors Account enablement %s before resolving a raw-id profile', (enabled) => {
        const result = projectVoiceConfiguredAgentTarget({
            selection: { agentId: 'claude', agentTargetKey: null, agentIdentity: null },
            entries: null,
            backendEnabledByTargetKey: { 'agent:happier.agent.claude/claude': enabled },
        });
        expect(result).toMatchObject(enabled
            ? { ok: true, kind: 'legacy', agentId: 'claude' }
            : { ok: false, errorCode: 'voice_agent_selection_unavailable', agentId: 'claude' });
    });
});
