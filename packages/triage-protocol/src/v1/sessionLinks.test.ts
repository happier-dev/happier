import { describe, expect, it } from 'vitest';

import { createTriageSourceV1Fixture } from '../testing/v1/index.js';
import {
    TriageSourceLinkSessionInputV1Schema,
    TriageSourceLinkSessionResultV1Schema,
    TriageSourceReadSessionLinksInputV1Schema,
    TriageSourceReadSessionLinksResultV1Schema,
} from './index.js';

const fixture = createTriageSourceV1Fixture();
const instance = { ...fixture.configuredInstance, binding: { purpose: 'example.api', source: 'accountData' } };
const localRef = fixture.getInput.localRef;

describe('source-owned Session relationships', () => {
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

    it('reads complete source-owned links with optional entry and Session filters and explicit failures', () => {
        for (const filters of [{}, { localRef }, { sessionId: 'session-1' }, { localRef, sessionId: 'session-1' }]) {
            expect(TriageSourceReadSessionLinksInputV1Schema.safeParse({ v: 1, instance, ...filters }).success).toBe(true);
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
