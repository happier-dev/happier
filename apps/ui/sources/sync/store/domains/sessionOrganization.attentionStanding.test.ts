import { describe, expect, it } from 'vitest';
import type { SessionAttentionStanding, SessionOrganizationSnapshot } from '@happier-dev/protocol';

import { buildSessionOrganizationServerKey } from '@/sync/domains/session/organization';

import {
    createSessionOrganizationDomain,
    type SessionOrganizationDomain,
} from './sessionOrganization';

type State = SessionOrganizationDomain;

function createHarness(): { get: () => State } {
    let state = {} as State;
    const get = () => state;
    const set = (updater: (draft: State) => Partial<State>) => {
        state = { ...state, ...updater(state) };
    };
    // The domain factory is typed against the full store; this harness supplies only the slice
    // under test, the same way the sibling sessionOrganization.test.ts harness does.
    state = createSessionOrganizationDomain({ get, set } as any);
    return { get };
}

function snapshot(input: Partial<SessionOrganizationSnapshot> = {}): SessionOrganizationSnapshot {
    return {
        schemaVersion: 1,
        version: input.version ?? 1,
        pins: [],
        folders: [],
        folderAssignments: [],
        tags: [],
        tagAssignments: [],
        orderEntries: [],
        labels: [],
        ...(input.attentionStandings ? { attentionStandings: input.attentionStandings } : {}),
    };
}

function standing(sessionId: string, value: boolean, updatedAt = 1): SessionAttentionStanding {
    return { sessionId, standing: value, updatedAt };
}

describe('session organization attention standings in the store', () => {
    it('replaces standings for the requesting server and leaves other servers alone', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', snapshot({
            version: 1,
            attentionStandings: [standing('s1', true), standing('s2', false)],
        }));
        harness.get().applySessionOrganizationSnapshot('srv-b', snapshot({
            version: 1,
            attentionStandings: [standing('other', true)],
        }));

        harness.get().applySessionOrganizationSnapshot('srv-a', snapshot({
            version: 2,
            attentionStandings: [standing('s2', true, 2)],
        }));

        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's2')]: standing('s2', true, 2),
            [buildSessionOrganizationServerKey('srv-b', 'other')]: standing('other', true),
        });
    });

    it('keeps standings a snapshot did not fetch', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', snapshot({
            version: 1,
            attentionStandings: [standing('s1', true)],
        }));
        const afterFetch = harness.get().sessionOrganizationAttentionStandingsBySessionKey;

        // A refresh that did not ask for standings omits the array entirely. Treating that as an
        // empty collection would silently drop every "Keep in Needs attention" the user declared.
        harness.get().applySessionOrganizationSnapshot('srv-a', snapshot({ version: 2 }));

        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toBe(afterFetch);
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: standing('s1', true),
        });
    });

    it('rolls a standing back and rebases the optimistic writes that outlived it', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', snapshot({
            version: 1,
            attentionStandings: [standing('s1', true)],
        }));

        const failing = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', null);
        const later = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's2', standing('s2', false, 5));
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's2')]: standing('s2', false, 5),
        });

        harness.get().rollbackSessionOrganizationOptimistic(failing);

        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: standing('s1', true),
            [buildSessionOrganizationServerKey('srv-a', 's2')]: standing('s2', false, 5),
        });
        expect(Object.keys(harness.get().sessionOrganizationOptimisticRecords)).toEqual([later]);
    });

    it('drops only the cleared server standings when a server is torn down', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', snapshot({
            version: 1,
            attentionStandings: [standing('s1', true)],
        }));
        harness.get().applySessionOrganizationSnapshot('srv-b', snapshot({
            version: 1,
            attentionStandings: [standing('other', false)],
        }));

        harness.get().clearSessionOrganizationForServer('srv-a');

        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-b', 'other')]: standing('other', false),
        });
    });
});
