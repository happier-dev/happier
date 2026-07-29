import { describe, expect, it, vi } from 'vitest';

import { createExternalSessionStatusDemandBatcher } from './createExternalSessionStatusDemandBatcher';

describe('createExternalSessionStatusDemandBatcher', () => {
    it('emits one semantic replace-set for a scroll change and coalesces loaded, visible, and open', () => {
        const emit = vi.fn();
        const batcher = createExternalSessionStatusDemandBatcher({ emit });

        batcher.replace({
            loaded: [
                {
                    sessionId: 'session-1',
                    machineId: 'machine-1',
                    linkGeneration: 'generation-1',
                },
                {
                    sessionId: 'session-2',
                    machineId: 'machine-1',
                    linkGeneration: 'generation-1',
                },
            ],
            visible: [{
                sessionId: 'session-2',
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
            }],
            open: [{
                sessionId: 'session-2',
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
            }],
        });

        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith('external-session-status-demand-v1', {
            v: 1,
            type: 'replace',
            revision: 1,
            entries: [
                {
                    sessionId: 'session-1',
                    machineId: 'machine-1',
                    linkGeneration: 'generation-1',
                    demand: 'loaded',
                },
                {
                    sessionId: 'session-2',
                    machineId: 'machine-1',
                    linkGeneration: 'generation-1',
                    demand: 'open',
                },
            ],
        });

        batcher.replace({
            loaded: [],
            visible: [],
            open: [],
        });
        expect(emit).toHaveBeenCalledTimes(2);
        expect(emit.mock.calls[1]?.[1]).toMatchObject({ revision: 2, entries: [] });
    });

    it('suppresses unchanged sets, resends on reconnect, and rejects an over-bound set', () => {
        const emit = vi.fn();
        const batcher = createExternalSessionStatusDemandBatcher({ emit });
        const loaded = [{
            sessionId: 'session-1',
            machineId: 'machine-1',
            linkGeneration: 'generation-1',
        }];

        batcher.replace({ loaded, visible: [], open: [] });
        batcher.replace({ loaded, visible: [], open: [] });
        expect(emit).toHaveBeenCalledTimes(1);

        batcher.resend();
        expect(emit).toHaveBeenCalledTimes(2);
        expect(emit.mock.calls[1]?.[1]).toMatchObject({ revision: 2 });

        expect(() => batcher.replace({
            loaded: Array.from({ length: 257 }, (_, index) => ({
                sessionId: `session-${index}`,
                machineId: 'machine-1',
                linkGeneration: 'generation-1',
            })),
            visible: [],
            open: [],
        })).toThrow();
        expect(emit).toHaveBeenCalledTimes(2);
    });
});
