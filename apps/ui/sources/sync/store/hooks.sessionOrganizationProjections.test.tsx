import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionOrganizationServerKey, type SessionOrganizationProjection } from '@/sync/domains/session/organization';

import * as storageHooks from './hooks';

type MultiHomeOrganizationProjectionHook = (
    serverIds: readonly string[],
) => Readonly<Record<string, SessionOrganizationProjection>>;

const HOME_A = 'multi-projection-home-a';
const HOME_B = 'multi-projection-home-b';

function tag(tagId: string, label: string) {
    return {
        tagId,
        tagKey: `tag/${tagId}`,
        sortKey: tagId,
        display: { t: 'plain' as const, v: { label } },
        displayState: { status: 'available' as const, value: { label } },
        archivedAt: null,
        createdAt: 1,
        updatedAt: 1,
    };
}

describe('useSessionOrganizationProjections', () => {
    let previousState: ReturnType<typeof storage.getState>;

    beforeEach(() => {
        previousState = storage.getState();
        storage.setState((state) => ({
            ...state,
            sessionOrganizationSchemaVersionByServerId: { [HOME_A]: 1, [HOME_B]: 1 },
            sessionOrganizationSnapshotVersionByServerId: { [HOME_A]: 1, [HOME_B]: 1 },
            sessionOrganizationTagsByTagKey: {
                [buildSessionOrganizationServerKey(HOME_A, 'urgent')]: tag('urgent', 'Urgent'),
                [buildSessionOrganizationServerKey(HOME_B, 'review')]: tag('review', 'Review'),
            },
        }));
    });

    afterEach(() => {
        standardCleanup();
        storage.setState(previousState, true);
    });

    it('projects organization tags for every selected Home through the canonical owner', async () => {
        const useSessionOrganizationProjections = (
            storageHooks as unknown as Readonly<{
                useSessionOrganizationProjections?: MultiHomeOrganizationProjectionHook;
            }>
        ).useSessionOrganizationProjections;

        expect(typeof useSessionOrganizationProjections).toBe('function');
        if (!useSessionOrganizationProjections) return;

        const hook = await renderHook(() => useSessionOrganizationProjections([
            ` ${HOME_A} `,
            HOME_B,
            HOME_A,
        ]));

        expect(Object.keys(hook.getCurrent())).toEqual([HOME_A, HOME_B]);
        expect(Object.keys(hook.getCurrent()[HOME_A]?.tagsById ?? {})).toEqual(['urgent']);
        expect(Object.keys(hook.getCurrent()[HOME_B]?.tagsById ?? {})).toEqual(['review']);
    });
});
