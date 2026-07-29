import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    normalizeSessionTagLabels,
    readSessionOrganizationServerScopedId,
    readSessionOrganizationTagLabel,
} from '@/sync/domains/session/organization';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { SessionOrganizationTag } from '@happier-dev/protocol';

import { setSessionTagAssignments } from './setSessionTagAssignments';
import { fetchAndApplySessionOrganizationSnapshot } from './fetchSessionOrganizationSnapshot';
import { createSessionOrganizationOpaqueId } from './sessionOrganizationIdAllocation';
import { upsertSessionTag } from './upsertSessionTag';

function readCurrentServerTags(serverId: string): SessionOrganizationTag[] {
    const state = getStorage().getState();
    const tags: SessionOrganizationTag[] = [];
    for (const [key, tag] of Object.entries(state.sessionOrganizationTagsByTagKey)) {
        if (readSessionOrganizationServerScopedId(key, serverId) !== tag.tagId) continue;
        if (tag.archivedAt != null) continue;
        tags.push(tag);
    }
    return tags.sort((a, b) => {
        const leftSort = a.sortKey ?? '';
        const rightSort = b.sortKey ?? '';
        if (leftSort !== rightSort) return leftSort.localeCompare(rightSort);
        return a.tagId.localeCompare(b.tagId);
    });
}

function findTagByLabel(tags: readonly SessionOrganizationTag[], label: string): SessionOrganizationTag | null {
    return tags.find((tag) => readSessionOrganizationTagLabel(tag) === label) ?? null;
}

function resolveExistingTagsByLabel(params: Readonly<{
    labels: readonly string[];
    tags: readonly SessionOrganizationTag[];
}>): {
    resolvedTags: SessionOrganizationTag[];
    missingLabels: string[];
} {
    const resolvedTags: SessionOrganizationTag[] = [];
    const missingLabels: string[] = [];
    for (const label of params.labels) {
        const existing = findTagByLabel([...params.tags, ...resolvedTags], label);
        if (existing) {
            resolvedTags.push(existing);
        } else {
            missingLabels.push(label);
        }
    }
    return { resolvedTags, missingLabels };
}

export async function setSessionTagLabels(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    sessionId: string;
    tags: readonly string[];
}>): Promise<void> {
    const labels = normalizeSessionTagLabels(params.tags);
    if (labels.length === 0) {
        await setSessionTagAssignments({
            credentials: params.credentials,
            serverId: params.serverId,
            serverUrl: params.serverUrl,
            sessionId: params.sessionId,
            tagIds: [],
        });
        return;
    }

    let currentTags = readCurrentServerTags(params.serverId);
    const firstResolution = resolveExistingTagsByLabel({ labels, tags: currentTags });
    if (firstResolution.missingLabels.length > 0) {
        await fetchAndApplySessionOrganizationSnapshot({
            credentials: params.credentials,
            serverId: params.serverId,
            serverUrl: params.serverUrl,
            request: {
                includeFolders: false,
                includeTags: true,
                includeLabels: false,
            },
        });
        currentTags = readCurrentServerTags(params.serverId);
    }

    const usedIds = new Set(currentTags.map((tag) => tag.tagId));
    const resolvedTags: SessionOrganizationTag[] = [];

    for (const label of labels) {
        const existing = findTagByLabel([...currentTags, ...resolvedTags], label);
        if (existing) {
            resolvedTags.push(existing);
            continue;
        }
        const tagId = createSessionOrganizationOpaqueId({ prefix: 'tag', usedIds });
        usedIds.add(tagId);
        const created = await upsertSessionTag({
            credentials: params.credentials,
            serverId: params.serverId,
            serverUrl: params.serverUrl,
            request: {
                tagId,
                tagKey: tagId,
                sortKey: null,
                display: { t: 'plain', v: { label } },
            },
        });
        resolvedTags.push(created);
    }

    await setSessionTagAssignments({
        credentials: params.credentials,
        serverId: params.serverId,
        serverUrl: params.serverUrl,
        sessionId: params.sessionId,
        tagIds: resolvedTags.map((tag) => tag.tagId),
    });
}
