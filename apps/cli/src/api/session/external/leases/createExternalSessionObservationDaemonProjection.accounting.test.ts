import { describe, expect, it } from 'vitest';
import { createExternalSessionObservationDaemonProjection } from './createExternalSessionObservationDaemonProjection';

describe('daemon accounting observation demand', () => {
    it('delivers native changes without a Session link and retires the physical watch', async () => {
        let changed: ((file: string) => void) | undefined;
        let watching = false;
        const received: string[] = [];
        const projection = createExternalSessionObservationDaemonProjection({
            publishField: async () => {},
            watchFile: (_file, listener) => {
                watching = true;
                changed = listener;
                return () => { watching = false; };
            },
        });
        try {
            const demand = await projection.registerAccountingSource({
                resource: { pluginId: 'example.agent', agentLocalId: 'agent', occurrenceId: 'current', resourceKey: 'native-root' },
                source: { kind: 'example', root: '/native' },
                changeObservation: 'watch_file_changes',
                watchFileChanges: { files: ['/native/accounting.jsonl'] },
                onChange: ({ reason }) => { received.push(reason); },
            });
            changed?.('/native/accounting.jsonl');
            expect(received).toEqual(['file_changed']);
            await demand.dispose();
            expect(watching).toBe(false);
            changed?.('/native/accounting.jsonl');
            expect(received).toEqual(['file_changed']);
        } finally { await projection.dispose(); }
    });
});
