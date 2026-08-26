import { describe, expect, it } from 'vitest';

import { buildClaudePredecessorMessageMeta } from './predecessorMessageMeta.js';

describe('buildClaudePredecessorMessageMeta', () => {
    it('writes the moving predecessor Claude CLI metadata shape without unrelated current-runtime settings', () => {
        const meta = buildClaudePredecessorMessageMeta({
            claudeCodeExperimentalAgentTeamsEnabled: true,
            claudeRemoteAdvancedOptionsJson: ' { "betas": ["agent-teams"] } ',
            claudeUnifiedTerminalWorkspaceTrust: 'trusted',
        });

        expect(meta.claudeCodeExperimentalAgentTeamsEnabled).toBe(true);
        expect(meta.claudeRemoteAdvancedOptionsJson).toBe('{"betas":["agent-teams"]}');
        expect(meta).not.toHaveProperty('claudeUnifiedTerminalWorkspaceTrust');
    });
});
