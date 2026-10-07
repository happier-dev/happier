import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';

// The Action host is the system boundary; scope admission below it stays real.
const dispatch = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true, result: { updated: true } })));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => dispatch }));

import { roleActions } from './roleActions';

const previous = storage.getState();
afterEach(() => { storage.setState(previous); dispatch.mockClear(); });

describe('session role Action Home routing', () => {
    it('keeps notes and role writes at the explicitly selected Home despite a colliding live Session', async () => {
        storage.setState({ sessions: { worker: createSessionFixture({ id: 'worker', serverId: 'home-a' }) } });
        await roleActions.setSessionNotes('worker', 'Notes for B', { serverId: 'home-b' });
        await roleActions.setSessionRole('worker', 'builder', { serverId: 'home-b' });
        expect(dispatch.mock.calls.map(([id, input, context]) => ({ id, input, context }))).toEqual([
            { id: 'session.notes.set', input: { sessionId: 'worker', notes: 'Notes for B' }, context: { surface: 'ui', serverId: 'home-b' } },
            { id: 'session.role.set', input: { sessionId: 'worker', roleId: 'builder' }, context: { surface: 'ui', serverId: 'home-b' } },
        ]);
    });

    it('refuses an ambiguous bare Session instead of choosing the focused Home', async () => {
        storage.setState({ sessions: { worker: createSessionFixture({ id: 'worker', serverId: 'home-a' }) },
            ordinarySessionListMembershipByServerId: { 'home-a': ['worker'], 'home-b': ['worker'] } });
        const result = await roleActions.setSessionNotes('worker', 'Ambiguous');
        expect(result.ok).toBe(false);
        expect(dispatch).not.toHaveBeenCalled();
    });
});
