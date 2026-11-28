import { describe, expect, it } from 'vitest';

import { createTriageSourceV1Fixture } from '../testing/v1/index.js';
import {
    resolveTriageSourceSessionLinkSlicesV1,
    TriageReadSourceSessionLinksInputV1Schema,
    TriageReadSourceSessionLinksResultV1Schema,
    TriageSourceLinkSessionInputV1Schema,
    TriageSourceLinkSessionResultV1Schema,
    TriageSourceReadSessionLinksInputV1Schema,
    TriageSourceReadSessionLinksResultV1Schema,
} from './index.js';

const fixture = createTriageSourceV1Fixture();
const instance = { ...fixture.configuredInstance, binding: { purpose: 'example.api', source: 'accountData' } };
const localRef = fixture.getInput.localRef;

describe('source-owned Session relationships', () => {
    it('accepts canonical Session IDs in both directions of the aggregate relation', () => {
        for (const sessionId of ['s'.repeat(129), 's'.repeat(191)]) {
            const input = { v: 1, sessionId };
            const result = { kind: 'complete', links: [{
                entryRef: { ...localRef, source: fixture.configuredInstance.instance.source },
                sessionId, linkedAtMs: 1234, displayPath: 'Task 17',
            }] };
            expect.soft(TriageReadSourceSessionLinksInputV1Schema.safeParse(input)).toMatchObject({ success: true, data: input });
            expect.soft(TriageReadSourceSessionLinksResultV1Schema.safeParse(result)).toMatchObject({ success: true, data: result });
        }
        for (const sessionId of ['', ' leading-space', 's'.repeat(192)]) {
            expect(TriageReadSourceSessionLinksInputV1Schema.safeParse({ v: 1, sessionId }).success).toBe(false);
        }
    });

    it('admits explicit link and unlink intent without caller-selected Account or Home authority', () => {
        for (const linked of [true, false]) {
            const input = { v: 1, instance, localRef, sessionId: 'session-1', linked };
            expect(TriageSourceLinkSessionInputV1Schema.parse(input)).toEqual(input);
            expect(TriageSourceLinkSessionInputV1Schema.safeParse({ ...input, homeId: 'other-home' }).success).toBe(false);
            expect(TriageSourceLinkSessionInputV1Schema.safeParse({ ...input, linked: 'true' }).success).toBe(false);
            expect(TriageSourceLinkSessionInputV1Schema.safeParse({ ...input, linkedAtMs: 1234 }).success).toBe(false);
            expect(TriageSourceLinkSessionInputV1Schema.safeParse({ ...input, localRef: { ...localRef, accountId: 'other-account' } }).success).toBe(false);
        }
        for (const status of ['linked', 'unlinked', 'failed']) {
            expect(TriageSourceLinkSessionResultV1Schema.safeParse({ status }).success).toBe(true);
        }
        expect(TriageSourceLinkSessionResultV1Schema.safeParse({ status: 'linked', retry: true }).success).toBe(false);
    });

    it('accepts entry reads and nonempty exact Session sets and retires the singleton operand', () => {
        for (const filters of [{ localRef }, { sessionIds: ['session-1', 'session-2'] }, { sessionIds: ['session-2', 'session-1'] }]) {
            expect(TriageSourceReadSessionLinksInputV1Schema.safeParse({ v: 1, instance, ...filters }).success).toBe(true);
        }
        for (const filters of [{}, { sessionId: 'session-1' }, { sessionIds: [] }]) {
            expect(TriageSourceReadSessionLinksInputV1Schema.safeParse({ v: 1, instance, ...filters }).success).toBe(false);
        }
        const link = { localRef, sessionId: 'session-1', linkedAtMs: 1234, displayPath: 'Task 17' };
        const result = { kind: 'complete', links: Array.from({ length: 65 }, () => link) };
        expect(TriageSourceReadSessionLinksResultV1Schema.parse(result)).toEqual(result);
        expect(TriageSourceReadSessionLinksResultV1Schema.safeParse({
            kind: 'complete', links: [{ ...link, sourceInstanceId: 'other-instance' }],
        }).success).toBe(false);
        expect(TriageSourceReadSessionLinksResultV1Schema.safeParse({
            kind: 'failed', failure: { class: 'permission', code: 'account-data-unavailable' },
        }).success).toBe(true);
        expect(TriageSourceReadSessionLinksResultV1Schema.safeParse({ kind: 'failed' }).success).toBe(false);
    });

    it('keeps independently complete, empty, partial and failed slices', () => {
        const link = { localRef, sessionId: 'linked', linkedAtMs: 1234, displayPath: 'Task 17' };
        const result = { kind: 'sessionSet', slices: [
            { sessionId: 'linked', result: { kind: 'complete', links: [link] } },
            { sessionId: 'empty', result: { kind: 'complete', links: [] } },
            { sessionId: 'partial', result: { kind: 'partial', links: [], unavailableRefs: [localRef] } },
            { sessionId: 'refused', result: { kind: 'failed', failure: { class: 'permission', code: 'session_target_unavailable' } } },
        ] };
        expect(TriageSourceReadSessionLinksResultV1Schema.parse(result)).toEqual(result);
        const normalized = resolveTriageSourceSessionLinkSlicesV1(
            ['empty', 'partial', 'linked', 'refused', 'missing', 'empty'],
            { kind: 'sessionReadSet', result: { ...result, slices: [...result.slices.slice(0, -1),
                { sessionId: 'outside', result: { kind: 'complete', links: [] } }] },
            failures: [{ sessionId: 'refused', result: { ok: false, errorCode: 'session_target_unavailable', error: 'session_target_unavailable' } }] },
        );
        expect(normalized.slices).toEqual([
            result.slices[1], result.slices[2], result.slices[0], result.slices[3],
            { sessionId: 'missing', result: { kind: 'failed', failure: { class: 'transient', code: 'sessionLinksIncomplete' } } },
        ]);
    });

    it('preserves readable links beside exact unavailable task references without declaring complete coverage', () => {
        const unavailableRef = { kindId: 'task', collisionScope: 'account:other', entryId: localRef.entryId };
        const result = { kind: 'partial', links: [{ localRef, sessionId: 'session-1', linkedAtMs: 1234, displayPath: 'Readable task' }],
            unavailableRefs: [unavailableRef] };
        expect(TriageSourceReadSessionLinksResultV1Schema.parse(result)).toEqual(result);
        expect(TriageSourceReadSessionLinksResultV1Schema.safeParse({ ...result, unavailableRefs: [] }).success).toBe(false);
        expect(TriageSourceReadSessionLinksResultV1Schema.safeParse({ ...result,
            unavailableRefs: [{ ...unavailableRef, accountId: 'caller-selected' }] }).success).toBe(false);
    });

});
