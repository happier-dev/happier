import { describe, expect, it } from 'vitest';

import { AgentStateSchema } from './storageTypes';

describe('AgentStateSchema capabilities', () => {
    it('preserves inFlightSteer capability when present', () => {
        const parsed = AgentStateSchema.parse({
            capabilities: { inFlightSteer: true },
        });

        expect(parsed.capabilities?.inFlightSteer).toBe(true);
    });
});

