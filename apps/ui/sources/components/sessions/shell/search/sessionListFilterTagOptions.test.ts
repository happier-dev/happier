import { describe, expect, it } from 'vitest';

import type { SessionOrganizationProjection, UiSessionOrganizationTag } from '@/sync/domains/session/organization/types';

import { buildSessionListFilterTagOptions } from './sessionListFilterTagOptions';

function tag(tagId: string, label: string, archivedAt: number | null = null): UiSessionOrganizationTag {
    return {
        tagId,
        tagKey: tagId,
        sortKey: null,
        display: { t: 'plain', v: { label } },
        displayState: { status: 'available', value: { label } },
        archivedAt,
        createdAt: 1,
        updatedAt: 1,
    } as unknown as UiSessionOrganizationTag;
}

function projection(tags: readonly UiSessionOrganizationTag[]): SessionOrganizationProjection {
    return {
        schemaVersion: 1,
        version: 1,
        orderedPinSessionIds: [],
        pinnedSessionIds: [],
        railPinnedSessionIds: [],
        pinsBySessionId: {},
        foldersById: {},
        folderAssignmentsBySessionId: {},
        tagsById: Object.fromEntries(tags.map((value) => [value.tagId, value])),
        tagAssignmentsBySessionId: {},
        attentionStandingsBySessionId: {},
        appearancesBySessionId: {},
        sessionAppearancesBySessionId: {},
        sessionAppearancesSupported: false,
        orderEntriesByScopeKey: {},
        labelsByLabelKey: {},
    };
}

describe('buildSessionListFilterTagOptions', () => {
    it('keeps two Homes with equal labels as two distinguishable qualified options', () => {
        const options = buildSessionListFilterTagOptions({
            homeOptions: [
                { serverId: 'home-a', label: 'Studio' },
                { serverId: 'home-b', label: 'Laptop' },
            ],
            organizationProjectionsByServerId: {
                'home-a': projection([tag('tag_01HX', 'urgent')]),
                'home-b': projection([tag('tag_7ZQ', 'urgent')]),
            },
        });

        // Options read in label order; the Home suffix is what keeps the two apart.
        expect(options).toEqual([
            { serverId: 'home-b', tagId: 'tag_7ZQ', label: 'urgent · Laptop' },
            { serverId: 'home-a', tagId: 'tag_01HX', label: 'urgent · Studio' },
        ]);
    });

    it('keeps the id opaque and the label untouched for a single Home', () => {
        const options = buildSessionListFilterTagOptions({
            homeOptions: [{ serverId: 'home-a', label: 'Studio' }],
            organizationProjectionsByServerId: {
                'home-a': projection([tag('tag_01HX', 'urgent')]),
            },
        });

        // The tag reads `urgent` and is addressed as `tag_01HX`; neither is derived
        // from the other, and one Home needs no disambiguating suffix.
        expect(options).toEqual([{ serverId: 'home-a', tagId: 'tag_01HX', label: 'urgent' }]);
    });

    it('omits archived tags and tags whose label is not readable yet', () => {
        const locked = {
            ...tag('tag_locked', 'locked'),
            display: { t: 'encrypted', c: 'x' },
            displayState: { status: 'locked', reason: 'account_key_unavailable' },
        } as unknown as UiSessionOrganizationTag;

        expect(buildSessionListFilterTagOptions({
            homeOptions: [{ serverId: 'home-a', label: 'Studio' }],
            organizationProjectionsByServerId: {
                'home-a': projection([tag('tag_archived', 'old', 10), locked, tag('tag_live', 'live')]),
            },
        })).toEqual([{ serverId: 'home-a', tagId: 'tag_live', label: 'live' }]);
    });
});
