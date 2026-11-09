import { describe, expect, it } from 'vitest';
import { buildSessionOriginV1, readSessionOriginV1, readSessionOriginViaV1 } from './sessionOrigin.js';

describe('session origin metadata', () => {
    it('treats absent, malformed and unsupported provenance as unknown, independently of transcript ancestry', () => {
        for (const metadata of [null, {}, { forkV1: { parentSessionId: 'planner' } },
            { sessionOriginV1: { v: 2, kind: 'agent', creatorSessionId: 'planner' } },
            { sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: ' ' } }]) {
            expect(readSessionOriginV1(metadata)).toBeNull();
        }
        expect(readSessionOriginV1({
            forkV1: { parentSessionId: 'transcript-source' },
            sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'planner', future: true },
        })).toEqual({ v: 1, kind: 'agent', creatorSessionId: 'planner', future: true });
    });

    it('keeps an origin without via unchanged in value, as the session_agent spawn writes it', () => {
        expect(buildSessionOriginV1({ creatorSessionId: ' lead ' })).toEqual({ v: 1, kind: 'agent', creatorSessionId: 'lead' });
        expect(readSessionOriginViaV1({ sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'lead' } })).toBeNull();
        expect(() => buildSessionOriginV1({ creatorSessionId: ' ' })).toThrow('session-origin-creator-required');
    });

    it('distinguishes run-hosted and assembled children while older readers still nest by creator', () => {
        const runHosted = { sessionOriginV1: buildSessionOriginV1({ creatorSessionId: 'lead', via: { kind: 'execution_run', runId: 'run_1' } }) };
        const assembled = { sessionOriginV1: buildSessionOriginV1({ creatorSessionId: 'lead', via: { kind: 'team_assembly', assignmentId: 'a1' } }) };
        expect(readSessionOriginViaV1(runHosted)).toEqual({ kind: 'execution_run', runId: 'run_1' });
        expect(readSessionOriginViaV1(assembled)).toEqual({ kind: 'team_assembly', assignmentId: 'a1' });
        expect(readSessionOriginV1(assembled)?.creatorSessionId).toBe('lead');

        const future = { sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'lead', via: { kind: 'future_form' } } };
        expect(readSessionOriginV1(future)?.creatorSessionId).toBe('lead');
        expect(readSessionOriginViaV1(future)).toBeNull();
    });
});
