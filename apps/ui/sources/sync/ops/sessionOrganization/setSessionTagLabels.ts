import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    normalizeSessionTagLabels,
    readSessionOrganizationTagLabel,
    type UiSessionOrganizationTag,
} from '@/sync/domains/session/organization';

import { fetchAndApplySessionOrganizationSnapshot } from './fetchSessionOrganizationSnapshot';
import { createSessionOrganizationTagWithLabel, type SessionTagActionExecute } from './upsertSessionTag';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { parseToken } from '@/utils/auth/parseToken';

const executeTagAction = createFrontDoorActionExecute();

function findTagByLabel(tags: readonly UiSessionOrganizationTag[], label: string): UiSessionOrganizationTag | null {
    return tags.find((tag) => readSessionOrganizationTagLabel(tag) === label) ?? null;
}

export async function setSessionTagLabels(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
    tags: readonly string[];
    executeAction?: SessionTagActionExecute;
}>): Promise<void> {
    const expectedAccountId = parseToken(params.credentials.token);
    const account = await captureLazyActionAccountContext(params.serverId);
    try {
        account.assertCurrent();
        if (account.accountId !== expectedAccountId) throw new Error('action_account_scope_changed');
        const context = { surface: 'ui' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, serverId: account.serverId, expectedAccountId };
        const labels = normalizeSessionTagLabels(params.tags);
        let received = false;
        const snapshot = await fetchAndApplySessionOrganizationSnapshot({
            credentials: account.credentials,
            serverId: account.serverId,
            requestAtEndpoint: account.request,
            shouldContinue: account.accountLifetime.isCurrent,
            onSnapshotReceived: () => { received = true; },
            request: {
                includeFolders: false,
                includeTags: true,
                includeLabels: false,
                assignmentSessionIds: [params.sessionId],
            },
        });
        account.assertCurrent();
        if (!received || !snapshot) throw new Error('Session organization is unavailable');
        const currentTags = snapshot.tags.filter(tag => tag.archivedAt === null);

        const usedIds = new Set(currentTags.map((tag) => tag.tagId));
        const resolvedTags: UiSessionOrganizationTag[] = [];

        for (const label of labels) {
            const existing = findTagByLabel([...currentTags, ...resolvedTags], label);
            if (existing) {
                resolvedTags.push(existing);
                continue;
            }
            account.assertCurrent();
            const created = await createSessionOrganizationTagWithLabel({ credentials: account.credentials,
                serverId: account.serverId, label, usedIds, executeAction: params.executeAction });
            account.assertCurrent();
            usedIds.add(created.tagId);
            resolvedTags.push(created);
        }

        account.assertCurrent();
        const addTagIds = resolvedTags.map(tag => tag.tagId);
        const retainedIds = new Set(addTagIds);
        const visibleIds = new Set(currentTags.filter(tag => readSessionOrganizationTagLabel(tag) !== null).map(tag => tag.tagId));
        const removeTagIds = (snapshot.tagAssignments.find(entry => entry.sessionId === params.sessionId)?.tagIds ?? [])
            .filter(tagId => !retainedIds.has(tagId) && visibleIds.has(tagId));
        const input = {
            sessionId: params.sessionId,
            addTagIds,
            removeTagIds,
        };
        const assigned = params.executeAction ? await params.executeAction('session.tags.set', input)
            : await executeTagAction('session.tags.set', input, context);
        requireActionSuccess(assigned);
    } finally { account.dispose(); }
}
