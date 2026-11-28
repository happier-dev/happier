import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AccountPlanResponseV1 } from '@happier-dev/protocol';

import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/sync/http/client';

import {
    getAccountPlanEntry,
    invalidateAccountPlan,
    refreshAccountPlan,
    resetAccountPlanResourceForTests,
    retainAccountPlan,
    retireAccountPlan,
} from './accountPlanResource';

function planFixture(overrides: Partial<AccountPlanResponseV1> = {}): AccountPlanResponseV1 {
    return {
        plan: null,
        limits: {
            sessionRetentionDays: 60,
            subagentRetentionDays: 7,
            toolOutputRetentionDays: null,
            pinnedSessions: 50,
            artifactStorageBytes: null,
        },
        usage: { pinnedSessions: 3, artifactStorageBytes: null },
        supporter: { active: false, since: null, number: null, recurringSince: null },
        supporterRing: false,
        ...overrides,
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('accountPlanResource', () => {
    let planReads = 0;
    let respond: () => Response = () => new Response(JSON.stringify(planFixture()), { status: 200 });

    beforeEach(() => {
        resetAccountPlanResourceForTests();
        upsertAndActivateServer({ serverUrl: 'http://plans.example.test' });
        planReads = 0;
        respond = () => new Response(JSON.stringify(planFixture()), { status: 200 });
        setRuntimeFetch(async (input) => {
            if (String(input).endsWith('/v1/account/plan')) planReads += 1;
            return respond();
        });
    });

    afterEach(() => {
        resetRuntimeFetch();
    });

    it('reads once per open, shares it with a second consumer and reads nothing while nobody is mounted', async () => {
        invalidateAccountPlan();
        await flush();
        expect(planReads).toBe(0);

        const releaseFirst = retainAccountPlan();
        const releaseSecond = retainAccountPlan();
        await flush();
        expect(planReads).toBe(1);
        expect(getAccountPlanEntry().data?.limits.pinnedSessions).toBe(50);

        releaseFirst();
        releaseSecond();
        invalidateAccountPlan();
        await flush();
        expect(planReads).toBe(1);
    });

    it('re-reads on a change hint while mounted and keeps the previous identity when nothing changed', async () => {
        const release = retainAccountPlan();
        await flush();
        const first = getAccountPlanEntry().data;

        invalidateAccountPlan();
        await flush();
        expect(planReads).toBe(2);
        expect(getAccountPlanEntry().data).toBe(first);

        respond = () => new Response(JSON.stringify(planFixture({
            plan: { id: 'plus', name: 'Plus', via: 'account', source: 'polar', endsAt: 1, renews: true, graceEndsAt: null, overdue: false },
        })), { status: 200 });
        invalidateAccountPlan();
        await flush();
        expect(getAccountPlanEntry().data?.plan?.id).toBe('plus');
        release();
    });

    it('keeps the last-known plan after a failed read and never reports a plan it did not read', async () => {
        respond = () => new Response('nope', { status: 500 });
        const releaseFirst = retainAccountPlan();
        await flush();
        expect(getAccountPlanEntry()).toMatchObject({ data: null, status: 'error' });
        releaseFirst();

        respond = () => new Response(JSON.stringify(planFixture()), { status: 200 });
        const release = retainAccountPlan();
        await flush();
        const known = getAccountPlanEntry().data;
        expect(known).not.toBeNull();

        respond = () => new Response('nope', { status: 502 });
        await refreshAccountPlan();
        expect(getAccountPlanEntry()).toMatchObject({ status: 'error' });
        expect(getAccountPlanEntry().data).toBe(known);
        release();
    });

    it('reports an unavailable surface when the server answers 404', async () => {
        respond = () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        const release = retainAccountPlan();
        await flush();
        expect(getAccountPlanEntry()).toMatchObject({ data: null, status: 'unavailable' });
        release();
    });

    it('drops the previous Account’s plan and ignores its in-flight response on the same server', async () => {
        const release = retainAccountPlan();
        await flush();
        expect(getAccountPlanEntry().data).not.toBeNull();

        let replyToOldRead: (response: Response) => void = () => {};
        setRuntimeFetch(() => new Promise((resolve) => { replyToOldRead = resolve; }));
        const oldRead = refreshAccountPlan();
        await flush();
        retireAccountPlan();
        expect(getAccountPlanEntry().data).toBeNull();

        setRuntimeFetch(async () => new Response(JSON.stringify(planFixture()), { status: 200 }));
        await refreshAccountPlan();
        replyToOldRead(new Response(JSON.stringify(planFixture({ supporterRing: true })), { status: 200 }));
        await oldRead;
        expect(getAccountPlanEntry().data?.supporterRing).toBe(false);
        release();
    });
});
