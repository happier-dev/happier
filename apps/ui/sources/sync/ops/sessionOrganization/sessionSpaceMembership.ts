import type { ActionExecuteResult, SessionSpaceMembershipTargetV1, SessionSpaceMembershipSetInputV1 } from '@happier-dev/protocol/actions';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { resolveCollectionSpacesV1, type CollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readCollectionSpaceDefaultV1 } from '@/components/settings/session/collectionSpaceDefaults';
import { buildSessionOrganizationServerKey, type UiSessionOrganizationTag } from '@/sync/domains/session/organization';
import { isSessionOrganizationTagForSpace } from '@/sync/domains/session/organization/spaceMembership';
import { getStorage } from '@/sync/domains/state/storageStore';
import { fetchAndApplySessionOrganizationSnapshot } from './fetchSessionOrganizationSnapshot';
import { createSessionOrganizationOpaqueId } from './sessionOrganizationIdAllocation';
import { upsertSessionTag } from './upsertSessionTag';
import { setSessionTagAssignments } from './setSessionTagAssignments';

type Failure = Readonly<{ ok: false; errorCode: string; error: string }>;
function unavailable(code = 'space_membership_unavailable'): Failure {
    return { ok: false, errorCode: code, error: code };
}
function failure(error: unknown, signal?: AbortSignal): Failure {
    if (signal?.aborted) return unavailable('action_cancelled');
    return unavailable(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'space_membership_unavailable');
}
function sameHome(left: string, right: string): boolean {
    return areServerProfileIdentifiersEquivalent(left, right);
}

async function readSpaces(catalog: LazyActionAccountContext) {
    const settings = await catalog.readSettings();
    const basis = readCollectionSpaceDefaultV1('sessionWork', settings);
    return resolveCollectionSpacesV1(settings.collectionSpacesV1, 'sessionWork', { name: basis.name, filter: basis.filter });
}

async function readTags(destination: LazyActionAccountContext): Promise<readonly UiSessionOrganizationTag[] | null> {
    let received = false;
    const snapshot = await fetchAndApplySessionOrganizationSnapshot({ credentials: destination.credentials,
        serverId: destination.serverId, requestAtEndpoint: destination.request,
        shouldContinue: destination.accountLifetime.isCurrent, onSnapshotReceived: () => { received = true; },
        request: { includeFolders: false, includeTags: true, includeLabels: false },
    });
    destination.assertCurrent();
    return received && snapshot ? snapshot.tags : null;
}

async function readAssociatedTag(destination: LazyActionAccountContext, tagId: string): Promise<UiSessionOrganizationTag | undefined> {
    const held = getStorage().getState().sessionOrganizationTagsByTagKey[buildSessionOrganizationServerKey(destination.serverId, tagId)];
    return held ?? (await readTags(destination))?.find(tag => tag.tagId === tagId);
}

async function readSpaceTags(target: SessionSpaceMembershipTargetV1, space: CollectionSpaceV1<'sessionWork'>,
    destination: LazyActionAccountContext): Promise<Readonly<{ ok: true; tags: readonly UiSessionOrganizationTag[] }> | Failure> {
    const association = space.membership?.tags.find(tag => tag.accountId === destination.accountId
        && sameHome(tag.serverId, destination.serverId));
    const tag = association ? await readAssociatedTag(destination, association.tagId) : undefined;
    // An association to unavailable or mismatched content cannot become an ordinary tag write.
    if (association && (!tag || !isSessionOrganizationTagForSpace(tag, target))) return unavailable();
    const held = getStorage().getState().sessionOrganizationTagsByTagKey;
    const members = Object.values(held).filter(tag => held[buildSessionOrganizationServerKey(destination.serverId, tag.tagId)] === tag
        && isSessionOrganizationTagForSpace(tag, target));
    if (members.length) return { ok: true, tags: members };
    const snapshot = await readTags(destination);
    return snapshot ? { ok: true, tags: snapshot.filter(tag => isSessionOrganizationTagForSpace(tag, target)) } : unavailable();
}

async function ensureTag(target: SessionSpaceMembershipTargetV1, space: CollectionSpaceV1<'sessionWork'>,
    destination: LazyActionAccountContext): Promise<Readonly<{ ok: true; tagId: string }> | Failure> {
    const members = await readSpaceTags(target, space, destination);
    if (!members.ok) return members;
    let tag = members.tags[0];
    if (!tag) {
        const tagId = createSessionOrganizationOpaqueId({ prefix: 'tag', usedIds: new Set(Object.values(
            getStorage().getState().sessionOrganizationTagsByTagKey).map(tag => tag.tagId)) });
        tag = await upsertSessionTag({ credentials: destination.credentials, serverId: destination.serverId,
            requestAtEndpoint: destination.request, assertCurrent: destination.assertCurrent,
            request: { tagId, tagKey: tagId, sortKey: null, display: { t: 'plain', v: {
                kind: 'space_membership', spaceId: target.spaceId, spaceSettingsTarget: target.spaceSettingsTarget,
            } } },
        });
    }
    return { ok: true, tagId: tag.tagId };
}

async function withCatalog<T>(target: SessionSpaceMembershipTargetV1, destination: LazyActionAccountContext,
    signal: AbortSignal | undefined, run: (catalog: LazyActionAccountContext) => Promise<T>): Promise<T | Failure> {
    let catalog: LazyActionAccountContext | undefined;
    try {
        catalog = sameHome(target.spaceSettingsTarget.serverId, destination.serverId)
            ? destination : await captureLazyActionAccountContext(target.spaceSettingsTarget.serverId, signal);
        if (catalog.accountId !== target.spaceSettingsTarget.accountId) return unavailable('action_account_scope_changed');
        return await run(catalog);
    } finally { if (catalog && catalog !== destination) catalog.dispose(); }
}

/** New authoring seeds this tag into the existing organizationPlacement before Session creation. */
export async function ensureSessionSpaceMembershipTag(params: SessionSpaceMembershipTargetV1 & Readonly<{
    serverId: string; expectedAccountId: string; signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; tagId: string }> | Failure> {
    let destination: LazyActionAccountContext | undefined;
    try {
        destination = await captureLazyActionAccountContext(params.serverId, params.signal);
        if (!sameHome(destination.serverId, params.serverId) || destination.accountId !== params.expectedAccountId) {
            return unavailable('action_account_scope_changed');
        }
        const ownDestination = destination;
        return await withCatalog(params, destination, params.signal, async catalog => {
            const space = (await readSpaces(catalog)).find(space => space.id === params.spaceId);
            if (!space) return unavailable('space_not_found');
            return ensureTag(params, space, ownDestination);
        });
    } catch (error) { return failure(error, params.signal); }
    finally { destination?.dispose(); }
}

/** The standard answering-client Action transport supplies the admitted Session authority. */
export async function setSessionSpaceMembership(args: Readonly<{ input: SessionSpaceMembershipSetInputV1; context: ActionExecutorContext }>,
    captured?: LazyActionAccountContext): Promise<ActionExecuteResult> {
    const { input, context } = args;
    let destination = captured;
    try {
        const expectedAccountId = context.expectedAccountId ?? context.runtimeAccountId;
        if (!context.serverId || !expectedAccountId) return unavailable('action_account_scope_changed');
        destination ??= await captureLazyActionAccountContext(context.serverId, context.signal);
        if (!sameHome(destination.serverId, context.serverId) || destination.accountId !== expectedAccountId) {
            return unavailable('action_account_scope_changed');
        }
        const ownDestination = destination;
        return await withCatalog(input, destination, context.signal, async catalog => {
            const spaces = await readSpaces(catalog);
            const space = spaces.find(space => space.id === input.spaceId);
            const source = input.operation === 'move' ? spaces.find(space => space.id === input.sourceSpaceId) : space;
            if (!space || input.operation === 'move' && !source) return unavailable('space_not_found');
            const sourceTags = input.operation === 'add' || !source ? { ok: true as const, tags: [] }
                : await readSpaceTags({ ...input, spaceId: source.id }, source, ownDestination);
            if (!sourceTags.ok) return sourceTags;
            const added = input.operation === 'remove' ? null : await ensureTag(input, space, ownDestination);
            if (added && !added.ok) return added;
            const addTagIds = added?.ok ? [added.tagId] : [];
            const removeTagIds = sourceTags.tags.map(tag => tag.tagId).filter(tagId => !addTagIds.includes(tagId));
            ownDestination.assertCurrent();
            const response = await setSessionTagAssignments({ credentials: ownDestination.credentials,
                serverId: ownDestination.serverId, requestAtEndpoint: ownDestination.request,
                assertCurrent: ownDestination.assertCurrent, sessionId: input.sessionId, addTagIds, removeTagIds });
            return { ok: true, result: { ...response, operation: input.operation, spaceId: input.spaceId,
                smartMatchMayRemain: input.operation !== 'add' && source?.membership?.mode !== 'manual_only' } };
        });
    } catch (error) { return failure(error, context.signal); }
    finally { if (destination && destination !== captured) destination.dispose(); }
}
