import { describe, expect, it } from 'vitest';

import { buildOpenCodeMessageUpdatedUsageTelemetry } from './openCodeUsageTelemetry';

describe('openCodeUsageTelemetry', () => {
    it('preserves OpenCode message cost as provider-reported reportedUsd telemetry', () => {
        const telemetry = buildOpenCodeMessageUpdatedUsageTelemetry({
            info: {
                id: 'msg_1',
                providerID: 'openai',
                modelID: 'gpt-5.2',
                tokens: {
                    total: 120,
                    input: 50,
                    output: 40,
                    reasoning: 10,
                    cache: {
                        read: 15,
                        write: 5,
                    },
                },
                cost: {
                    total: 1.25,
                },
            },
        });

        expect(telemetry?.observation.cost).toEqual({
            reportedUsd: 1.25,
            total: 1.25,
        });
    });
});
