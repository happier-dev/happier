import { describe, expect, it } from 'vitest';

import { AgentStateSchema } from './storageTypes';

describe('AgentStateSchema capabilities', () => {
    it('preserves inFlightSteer capability when present', () => {
        const parsed = AgentStateSchema.parse({
            capabilities: {
                inFlightSteer: true,
                inFlightSteerSupported: true,
                inFlightSteerAvailable: false,
            },
        });

        expect(parsed.capabilities?.inFlightSteer).toBe(true);
        expect(parsed.capabilities?.inFlightSteerSupported).toBe(true);
        expect(parsed.capabilities?.inFlightSteerAvailable).toBe(false);
    });

    it('preserves the steer unavailable reason and state timestamp (Seam A), permissive for forward-compat', () => {
        const parsed = AgentStateSchema.parse({
            capabilities: {
                inFlightSteerAvailable: false,
                inFlightSteerUnavailableReason: 'user_terminal_draft',
                inFlightSteerStateAt: 1234,
            },
        });

        expect(parsed.capabilities?.inFlightSteerUnavailableReason).toBe('user_terminal_draft');
        expect(parsed.capabilities?.inFlightSteerStateAt).toBe(1234);

        // Forward-compat: unknown reason strings from a newer CLI must parse, not reject.
        const forward = AgentStateSchema.parse({
            capabilities: { inFlightSteerUnavailableReason: 'some_future_reason' },
        });
        expect(forward.capabilities?.inFlightSteerUnavailableReason).toBe('some_future_reason');

        // Back-compat: older CLIs omit both fields.
        const legacy = AgentStateSchema.parse({ capabilities: { inFlightSteer: true } });
        expect(legacy.capabilities?.inFlightSteerUnavailableReason ?? null).toBeNull();
        expect(legacy.capabilities?.inFlightSteerStateAt ?? null).toBeNull();
    });

    it('preserves the in-flight config-apply capability (G4 "Apply setting & steer now" gate), fail-closed when absent', () => {
        const parsed = AgentStateSchema.parse({
            capabilities: { inFlightConfigApplySupported: true },
        });
        expect(parsed.capabilities?.inFlightConfigApplySupported).toBe(true);

        // Back-compat: older CLIs omit the field — readers must fail closed.
        const legacy = AgentStateSchema.parse({ capabilities: { inFlightSteer: true } });
        expect(legacy.capabilities?.inFlightConfigApplySupported ?? null).toBeNull();
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
