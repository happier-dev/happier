import { afterEach, expect, it, vi } from 'vitest';
import { createUsageQuerySessionInputs, type SessionInputEvidence } from './usageQuerySessionInputs';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { projectUsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';

afterEach(() => vi.restoreAllMocks());

it('reuses settled Session inputs without per-Session cancellation subscriptions and reads only a changed Session', async () => {
    // The loaded Account's complete phase contained 3,634 Sessions (FREEZE-3).
    const scope = { serverId: 'usage-settled-input-cost.test', accountId: 'account' };
    const previous = storage.getState();
    storage.setState({ profileScope: scope, sessions: {} });
    const controller = new AbortController();
    const owner = createUsageQuerySessionInputs({ lifetime: { scope, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) }, signal: controller.signal, assertCurrent() {} });
    const ids = Array.from({ length: 3_634 }, (_, index) => `session-${index}`);
    let loads = 0;
    const values = new Map<string, SessionInputEvidence>();
    const read = async (id: string) => {
        const value = await owner.read(id, false, async () => {
            loads++;
            const session = projectUsageSessionInput(createSessionFixture({ id, encryptionMode: 'plain',
                seq: storage.getState().sessions[id]?.seq ?? 1 }));
            return { session, callerDataKeyEnvelope: null, completeMessageCoverage: true,
                detail: { status: 'available', facts: [] } };
        }, value => { values.set(id, value); }, undefined, 'range', 'widget', controller.signal);
        if (value) values.set(id, value);
        return value;
    };
    const subscriptions = vi.spyOn(AbortSignal.prototype, 'addEventListener');
    try {
        await Promise.all(ids.map(read));
        expect(loads).toBe(ids.length);
        const admitted = new Map(values);
        subscriptions.mockClear();
        loads = 0;
        await Promise.all(ids.map(read));
        expect(loads, 'entering an already-read range acquires no Session inputs').toBe(0);
        expect(subscriptions.mock.calls.filter(([type]) => type === 'abort'),
            'settled work cannot be cancelled and must not subscribe once per Session on a view switch').toHaveLength(0);
        for (const id of ids) expect(values.get(id)).toBe(admitted.get(id));
        storage.setState({ sessions: { [ids[0]!]: createSessionFixture({ id: ids[0]!, seq: 2, encryptionMode: 'plain' }) } });
        expect(owner.reconcile([ids[0]!])).toBe(true);
        await Promise.all(ids.map(read));
        expect(loads, 'one changed Session acquires one replacement input').toBe(1);
        expect(values.get(ids[0]!)?.session.seq).toBe(2);
        for (const id of ids.slice(1)) expect(values.get(id)).toBe(admitted.get(id));
    } finally {
        owner.dispose();
        controller.abort();
        storage.setState({ profileScope: previous.profileScope, sessions: previous.sessions });
    }
});
