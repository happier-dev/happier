import { describe, expect, it } from 'vitest';
import { makeSessionWorkflowRunSnapshot } from '@/dev/testkit';
import { buildWorkflowRunSystemRecordLocalId } from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
import { openWorkflowRunSystemRecord } from './sessionWorkflowActivityRecords';

describe('workflow System Record projection', () => {
    it('opens persisted snapshots while dropping unknown payload fields', async () => {
        const payload = makeSessionWorkflowRunSnapshot({ runId: 'run-one' });
        const result = await openWorkflowRunSystemRecord({
            runId: 'run-one', context: { mode: 'plain' },
            record: { id: 'record-one', address: { owner: 'host', namespace: 'activity', kind: 'workflow_run.v1',
                localId: buildWorkflowRunSystemRecordLocalId({ runId: 'run-one' }) },
                content: { t: 'plain', v: { ...payload, retired: true } },
                revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' },
        });
        expect(result).toMatchObject({ status: 'ready', value: payload });
        if (result.status === 'ready') expect(result.value).not.toHaveProperty('retired');
    });
    it('rejects a plain envelope for a persisted encrypted Session instead of displaying it', async () => {
        const payload = makeSessionWorkflowRunSnapshot({ runId: 'run-one' });
        expect(await openWorkflowRunSystemRecord({
            runId: 'run-one',
            context: { mode: 'e2ee', encryption: null },
            record: {
                id: 'record-one',
                address: {
                    owner: 'host',
                    namespace: 'activity',
                    kind: 'workflow_run.v1',
                    localId: buildWorkflowRunSystemRecordLocalId({ runId: 'run-one' }),
                },
                content: { t: 'plain', v: payload },
                revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
                createdAt: '2026-09-05T00:00:00.000Z',
                updatedAt: '2026-09-05T00:00:00.000Z',
            },
        })).toEqual({ status: 'mode_mismatch' });
    });
});
