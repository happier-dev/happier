import { afterEach, beforeEach, vi } from 'vitest';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { CreateOrUpdateSessionOrganizationTagRequestSchema, MutateSessionTagAssignmentsRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import type { SessionOrganizationTag } from '@happier-dev/protocol/sessions/organization/tags';
import { CollectionSpacesV1Schema, createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// Only HTTP and device credentials are replaced; catalog CAS, Account policy,
// encryption and organization projection retain their real implementations.
export const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
beforeEach(async () => homes.reset());
afterEach(() => standardCleanup());

let fixtureNumber = 0;
export async function fixture() {
    const accountId = `owner-${++fixtureNumber}`;
    const serverId = await homes.addHome({ name: 'Membership', serverUrl: 'https://membership.example', accountId, active: false });
    const { getStorage } = await import('@/sync/domains/state/storageStore');
    getStorage().getState().clearSessionOrganizationForServer(serverId);
    let raw: Record<string, unknown> = { collectionSpacesV1: { v: 1, spaces: ['a', 'b', 'c'].map(id => ({
        ...createDefaultCollectionSpaceV1('sessionWork'), id, name: id,
    })) } };
    let version = 1;
    homes.answer(serverId, 'GET /v2/account/settings', { select: () => ({ body: { version, content: { t: 'plain', v: raw } } }) });
    homes.answer(serverId, 'POST /v2/account/settings', { select: input => {
        const body = AccountSettingsV2UpdateRequestSchema.parse(input);
        if (body.content?.t !== 'plain') throw new Error('Expected plain Account settings');
        if (body.expectedVersion !== version) return { body: { success: false, error: 'version-mismatch',
            currentVersion: version, currentContent: { t: 'plain', v: raw } } };
        raw = body.content.v;
        return { body: { success: true, version: ++version } };
    } });
    let tags: SessionOrganizationTag[] = [{ tagId: 'ordinary', tagKey: 'ordinary', sortKey: null,
        display: { t: 'plain', v: { label: 'Visible' } }, archivedAt: null, createdAt: 1, updatedAt: 1 }];
    let assigned = ['ordinary'];
    homes.answer(serverId, 'GET /v2/session-organization', { select: () => ({ body: { snapshot: {
        schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], orderEntries: [], labels: [], tags,
        tagAssignments: [{ sessionId: 's', tagIds: assigned }],
    } } }) });
    homes.answer(serverId, 'POST /v2/session-organization/tags', { select: input => {
        const request = CreateOrUpdateSessionOrganizationTagRequestSchema.parse(input);
        if (!request.tagId) throw new Error('Missing allocated tag');
        const tag: SessionOrganizationTag = { ...request, tagId: request.tagId, sortKey: request.sortKey ?? null,
            display: request.display ?? null, archivedAt: null, createdAt: 1, updatedAt: 1 };
        tags = [...tags, tag];
        return { body: { tag } };
    } });
    homes.answer(serverId, 'PUT /v2/session-organization/tag-assignments/s', { select: input => {
        const request = MutateSessionTagAssignmentsRequestSchema.parse(input);
        assigned = 'tagIds' in request ? request.tagIds
            : [...new Set([...assigned.filter(id => !request.removeTagIds.includes(id)), ...request.addTagIds])];
        return { body: { sessionId: 's', tagIds: assigned } };
    } });
    const { scopedHomeActionExecutor } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
    const execute = scopedHomeActionExecutor({ serverId, accountId });
    const context = { serverId, expectedAccountId: accountId, surface: 'ui' as const, authority: 'present_user' as const };
    const target = { serverId, accountId };
    const input = (spaceId: string, operation: 'add' | 'move' | 'remove' = 'add', sourceSpaceId?: string) => ({
        sessionId: 's', spaceId, operation, spaceSettingsTarget: target, ...(sourceSpaceId ? { sourceSpaceId } : {}),
    });
    return { serverId, accountId, execute, context, target, input, read: () => ({ assigned, tags, raw }),
        seedPrivate: () => {
            tags.push({ tagId: 'private', tagKey: 'private', sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1,
                display: { t: 'plain', v: { kind: 'space_membership', spaceId: 'a', spaceSettingsTarget: target } } });
            assigned.push('private');
        }, seedUnknown: () => { assigned.push('unavailable-display'); },
        seedAssociated: (spaceId: string, options: Readonly<{
            assigned?: boolean; display?: SessionOrganizationTag['display']; archivedAt?: number | null;
        }> = {}) => {
            const tagId = `membership-${spaceId}`;
            const spaces = CollectionSpacesV1Schema.parse(raw.collectionSpacesV1);
            raw = { ...raw, collectionSpacesV1: { ...spaces, spaces: spaces.spaces.map(space => space.id === spaceId
                ? { ...space, membership: { mode: 'filter_or_manual', tags: [{ ...target, tagId }] } } : space) } };
            tags.push({ tagId, tagKey: tagId, sortKey: null, archivedAt: options.archivedAt ?? null, createdAt: 1, updatedAt: 1,
                display: options.display === undefined
                    ? { t: 'plain', v: { kind: 'space_membership', spaceId, spaceSettingsTarget: target } } : options.display });
            if (options.assigned) assigned.push(tagId);
            return tagId;
        } };
}
