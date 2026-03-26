import { describe, expect, it } from 'vitest';

import { AgentStateSchema } from './storageTypes';

describe('AgentStateSchema capabilities', () => {
    it('preserves inFlightSteer capability when present', () => {
        const parsed = AgentStateSchema.parse({
            capabilities: { inFlightSteer: true },
        });

        expect(parsed.capabilities?.inFlightSteer).toBe(true);
    });

    it('preserves localPermissionBridgeInLocalMode capability when present', () => {
        const parsed = AgentStateSchema.parse({
            capabilities: { localPermissionBridgeInLocalMode: true },
        });

        expect(parsed.capabilities?.localPermissionBridgeInLocalMode).toBe(true);
    });

    it('preserves request source fields when present', () => {
        const parsed = AgentStateSchema.parse({
            requests: {
                req1: { tool: 'Bash', arguments: {}, source: 'claude_local_permission_bridge' },
            },
        });

        expect((parsed.requests as any)?.req1?.source).toBe('claude_local_permission_bridge');
    });

});
