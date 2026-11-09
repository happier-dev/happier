import { describe, expect, it } from 'vitest';
import { createSessionSystemRecordPayloadService } from '@/session/systemRecords/sessionSystemRecordPayloadService';
import type { LegacyHostSessionSystemRecord } from '@happier-dev/protocol';
import { createGuardSessionStopReceipt } from './sessionStopReceipt';

describe('exact Guard receipt settlement', () => {
  it.each(['stopped', 'cancelled', 'failed'] as const)('settles %s at the original address with tolerant stored reads', async status => {
    let content: LegacyHostSessionSystemRecord['content'] = { t: 'plain', v: {
      v: 1, at: 1000, rule: 'memory_guard', status: 'requested', futurePresentation: true,
    } };
    const writes: unknown[] = [];
    const records = createSessionSystemRecordPayloadService({ sessionId: 'session',
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      fetchSessionSystemRecord: async request => ({ id: 'record', sessionId: 'session',
        createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(), namespace: request.namespace, localId: request.localId,
        kind: 'session_stop.v1', content }),
      upsertSessionSystemRecord: async request => { writes.push(request); content = request.content; },
    });
    const receipt = createGuardSessionStopReceipt({ records, at: 1000, nowMs: () => 2000 });
    await receipt.settle(status); await receipt.settle(status);
    expect(writes).toEqual([{ namespace: 'activity', kind: 'session_stop.v1', localId: 'activity:session_stop:v1:1000',
      content: { t: 'plain', v: { v: 1, at: 1000, rule: 'memory_guard', status, settledAt: 2000 } } }]);
  });

  it('settles an admitted native exit without reauthorizing and retries the same record after failed publication', async () => {
    let fail = true;
    const writes: unknown[] = [];
    const records = createSessionSystemRecordPayloadService({ sessionId: 'session',
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      fetchSessionSystemRecord: async request => ({ id: 'record', sessionId: 'session',
        createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(), namespace: request.namespace, localId: request.localId,
        kind: 'session_stop.v1', content: { t: 'plain', v: { v: 1, at: 1000, rule: 'memory_guard', status: 'requested' } } }),
      upsertSessionSystemRecord: async request => { if (fail) throw new Error('HTTP unavailable'); writes.push(request); },
    });
    const receipt = createGuardSessionStopReceipt({ records, at: 1000 });
    await expect(receipt.settle('stopped')).rejects.toThrow('HTTP unavailable');
    expect(writes).toHaveLength(0);
    fail = false; await receipt.settle('stopped'); await receipt.settle('cancelled');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ content: { v: { status: 'stopped' } } });
  });

  it('does not turn a withdrawn intent into a stopped receipt when the Session exits later', async () => {
    let content: LegacyHostSessionSystemRecord['content'] = { t: 'plain', v: {
      v: 1, at: 1000, rule: 'memory_guard', status: 'requested',
    } };
    const records = createSessionSystemRecordPayloadService({ sessionId: 'session',
      getStoredContentEncryptionContext: () => ({ mode: 'plain' }),
      fetchSessionSystemRecord: async request => ({ id: 'record', sessionId: 'session',
        createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(),
        namespace: request.namespace, localId: request.localId, kind: 'session_stop.v1', content }),
      upsertSessionSystemRecord: async request => { content = request.content; },
    });
    const receipt = createGuardSessionStopReceipt({ records, at: 1000 });
    await receipt.settle('cancelled');
    await receipt.settle('stopped');
    expect(content).toMatchObject({ t: 'plain', v: { status: 'cancelled' } });
  });
});
