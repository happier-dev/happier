import { describe, expect, it } from 'vitest';

import { AgentStateSchema } from './storageTypes';

describe('AgentStateSchema capabilities', () => {
    it('keeps the snapshot when structured-answer support is malformed and treats it as unsupported', () => {
        const parsed = AgentStateSchema.parse({
            requests: {},
            capabilities: { structuredQuestionAnswersV1Supported: 'stale' },
        });
        expect(parsed.requests).toEqual({});
        expect(parsed.capabilities?.structuredQuestionAnswersV1Supported).toBeUndefined();
    });

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

    it('preserves localPermissionBridgeInLocalMode capability when present', () => {
        const parsed = AgentStateSchema.parse({
            capabilities: { localPermissionBridgeInLocalMode: true },
        });

        expect(parsed.capabilities?.localPermissionBridgeInLocalMode).toBe(true);
    });

    it('preserves terminal composer clear capability fields when present', () => {
        const parsed = AgentStateSchema.parse({
            capabilities: {
                terminalComposerClearSupported: true,
                terminalComposerDraftPresent: true,
            },
        });

        expect(parsed.capabilities?.terminalComposerClearSupported).toBe(true);
        expect(parsed.capabilities?.terminalComposerDraftPresent).toBe(true);
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
