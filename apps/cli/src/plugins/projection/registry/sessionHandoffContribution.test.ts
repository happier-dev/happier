import { describe, expect, it, vi } from 'vitest';

import { readSessionHandoffContribution } from './sessionHandoffContribution';

describe('session handoff catalog metadata contribution', () => {
    it('projects metadata leaves while refusing retired runtime operation factories', () => {
        const extract = vi.fn(() => []);
        const build = vi.fn(() => ({ codexSessionId: 'provider-session-1' }));

        const contribution = readSessionHandoffContribution({
            surface: vi.fn(),
            resolveReplayChildLaunch: vi.fn(),
            agentBundleRecords: { extract },
            runtimeLocalMetadata: { build },
        });

        expect(contribution).toEqual({
            agentBundleRecords: { extract },
            runtimeLocalMetadata: { build },
        });
        expect(contribution).not.toHaveProperty('surface');
        expect(contribution).not.toHaveProperty('resolveReplayChildLaunch');
    });

    it('does not retain an operation-only catalog contribution', () => {
        expect(readSessionHandoffContribution({
            surface: vi.fn(),
            resolveReplayChildLaunch: vi.fn(),
        })).toBeNull();
    });
});
