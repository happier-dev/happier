import { describe, expect, it } from 'vitest';

import { getSessionLocalControlState, isSessionLocallyAttached } from './sessionLocalControl';
import type { Session } from '@/sync/domains/state/storageTypes';

describe('sessionLocalControl', () => {
    it('does not expose local control for inactive sessions even when controlledByUser is still recorded', () => {
        const session = {
            active: false,
            metadata: {
                flavor: 'codex',
            },
            agentState: {
                controlledByUser: true,
            },
        } as Session;

        expect(getSessionLocalControlState(session)).toBeNull();
        expect(isSessionLocallyAttached(session)).toBe(false);
    });
});
