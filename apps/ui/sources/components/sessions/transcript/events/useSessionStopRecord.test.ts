import { describe, expect, it } from 'vitest';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createSessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import { observeSessionStopRecord } from './useSessionStopRecord';

describe('stop marker Session record observation', () => {
    it('follows the same exact address through all settlements and retires disclosure with requester authority', async () => {
        const scope = { serverId: 'home-a', accountId: 'alice' };
        const session = { serverId: 'home-a', sessionId: 'session-one' };
        const address = { owner: 'host', namespace: 'activity', kind: 'session_stop.v1', localId: 'activity:session_stop:v1:1000' } as const;
        const query = { type: 'read', address } as const;
        let status: 'requested' | 'stopped' | 'cancelled' | 'failed' = 'requested';
        let allowed = true;
        let revision = 1;
        const requests: string[] = [];
        const repository = createSessionSystemRecordRepository({ scope, request: async input => {
            requests.push(String(input));
            return new Response(JSON.stringify({ record: { id: 'record-one', address,
                content: { t: 'plain', v: { v: 1, at: 1000, rule: 'memory_guard', status, futurePresentation: true } },
                revision: ['ssr1.AAAACHN5c3JlY18xAAAAAQ', 'ssr1.AAAACHN5c3JlY18xAAAAAg',
                    'ssr1.AAAACHN5c3JlY18xAAAAAw', 'ssr1.AAAACHN5c3JlY18xAAAABA'][revision - 1],
                createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' } }));
        } });
        const observed: unknown[] = [];
        const authority = { contentContext: { mode: 'plain' as const }, capabilities: { readTranscript: true, editSessionRecords: true } };
        const stop = observeSessionStopRecord({ session, repository,
            isCurrent: () => allowed, readCapabilities: () => allowed ? authority.capabilities : null,
            readContentContext: () => authority.contentContext,
            onChange: value => observed.push(value),
        }, 1000);
        await repository.refresh(session, query); await flushHookEffects();
        expect(observed.at(-1)).toMatchObject({ status: 'ready', record: { status: 'requested' } });
        for (const next of ['cancelled', 'failed', 'stopped'] as const) {
            status = next; revision++;
            repository.invalidate(session); await repository.refresh(session, query); await flushHookEffects();
            expect(observed.at(-1)).toMatchObject({ status: 'ready', record: { status: next } });
        }
        expect(new Set(requests).size).toBe(1);
        allowed = false; repository.invalidate(session); await flushHookEffects();
        expect(observed.at(-1)).toEqual({ status: 'unavailable', reason: 'forbidden' });
        stop(); repository.retire();
    });
});
