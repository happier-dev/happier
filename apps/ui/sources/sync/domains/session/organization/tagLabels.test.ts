import { describe, expect, it } from 'vitest';
import { buildSessionOrganizationTagLabelById, readSessionOrganizationTagLabel } from './tagLabels';
import type { UiSessionOrganizationTag } from './types';

function tag(tagId: string, value: Extract<UiSessionOrganizationTag['display'], { t: 'plain' }>['v']): UiSessionOrganizationTag {
    return { tagId, tagKey: tagId, sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1,
        display: { t: 'plain', v: value }, displayState: { status: 'available', value } };
}

describe('organization tag presentation', () => {
    it('hides typed space membership from ordinary label projections without reserving label prefixes', () => {
        const internal = tag('internal', { kind: 'space_membership', spaceId: 'space-a',
            spaceSettingsTarget: { serverId: 'home', accountId: 'owner' }, label: 'Private membership' });
        const ordinary = tag('ordinary', { label: 'space_membership:ordinary' });
        expect(readSessionOrganizationTagLabel(internal)).toBeNull();
        expect(buildSessionOrganizationTagLabelById({ internal, ordinary })).toEqual({ ordinary: 'space_membership:ordinary' });
    });
});
