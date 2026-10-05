import { describe, expect, it } from 'vitest';
import {
    TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_ID_V1,
    TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_REF_V1,
    TRIAGE_SET_FIX_PULL_REQUEST_ACTION_ID_V1,
    TRIAGE_SET_FIX_PULL_REQUEST_ACTION_REF_V1,
    TriageReadFixPullRequestsResultV1Schema,
    TriageSetFixPullRequestInputV1Schema,
    MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
} from './index.js';
import { createTriageSourceV1Fixture } from '../testing/v1/fixtures.js';

const entryRef = createTriageSourceV1Fixture().detailInput.observation.entryRef;
const candidate = { entryRef, origins: ['user', 'session'], status: 'unknown', display: { title: 'Fix', scopeLabel: 'example/repo' } };

describe('public fix-PR caller contract', () => {
    it('accepts durable choices beyond relationship query pages without truncating the public read', () => {
        const candidates = Array.from({ length: 2 * MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1 }, (_, index) => ({
            ...candidate,
            entryRef: { ...entryRef, entryId: String(index) },
        }));
        const result = { v: 1, candidates, primary: candidates[0], incomplete: false };
        expect(TriageReadFixPullRequestsResultV1Schema.parse(result)).toEqual(result);
    });
    it('accepts the resolved projection and refuses private resolution inputs and undeclared fields', () => {
        const result = { v: 1, candidates: [candidate], primary: candidate, incomplete: false };
        expect(TriageReadFixPullRequestsResultV1Schema.parse(result)).toEqual(result);
        expect(TriageReadFixPullRequestsResultV1Schema.parse({ v: 1, candidates: [], primary: null, incomplete: true })).toEqual({
            v: 1, candidates: [], primary: null, incomplete: true,
        });
        for (const invalid of [
            { v: 1, linked: [], dismissed: [], coLinked: [], incomplete: false },
            { ...result, dismissed: [] },
            { ...result, candidates: [{ ...candidate, status: 'resolved' }] },
            { ...result, candidates: [{ ...candidate, origins: ['user', 'user'] }] },
            { ...result, candidates: [{ ...candidate, entryRef: { ...entryRef, accountId: 'other' } }] },
        ]) expect(TriageReadFixPullRequestsResultV1Schema.safeParse(invalid).success).toBe(false);
    });

    it('carries link/unlink intent through exact qualified Actions without storage or caller-authority input', () => {
        for (const ref of [TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_REF_V1, TRIAGE_SET_FIX_PULL_REQUEST_ACTION_REF_V1]) {
            expect(Object.isFrozen(ref)).toBe(true);
        }
        expect(`${TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_REF_V1.pluginId}/${TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_REF_V1.localId}`)
            .toBe(TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_ID_V1);
        expect(`${TRIAGE_SET_FIX_PULL_REQUEST_ACTION_REF_V1.pluginId}/${TRIAGE_SET_FIX_PULL_REQUEST_ACTION_REF_V1.localId}`)
            .toBe(TRIAGE_SET_FIX_PULL_REQUEST_ACTION_ID_V1);
        const common = { v: 1, entryRef, displayAtMark: candidate.display, fixPullRequest: entryRef };
        expect(TriageSetFixPullRequestInputV1Schema.safeParse({ ...common, linked: true, displayAtLink: candidate.display }).success).toBe(true);
        expect(TriageSetFixPullRequestInputV1Schema.safeParse({ ...common, linked: false }).success).toBe(true);
        for (const smuggled of [{ caller: 'happier.triage' }, { confirmed: true }, { markTag: 'private-row' }]) {
            expect(TriageSetFixPullRequestInputV1Schema.safeParse({ ...common, linked: false, ...smuggled }).success).toBe(false);
        }
    });
});
