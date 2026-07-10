import { describe, expect, it } from 'vitest';

import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
    isClaudeLocalPermissionBridgeAgentStateRequest,
} from './requestSource.js';

describe('Claude permission request source', () => {
    it('identifies local permission bridge agent-state requests', () => {
        expect(CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE).toBe('claude_local_permission_bridge');
        expect(CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON).toBe('Local permission bridge stopped');
        expect(isClaudeLocalPermissionBridgeAgentStateRequest({
            source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        })).toBe(true);
        expect(isClaudeLocalPermissionBridgeAgentStateRequest({ source: 'other' })).toBe(false);
        expect(isClaudeLocalPermissionBridgeAgentStateRequest(null)).toBe(false);
    });
});
