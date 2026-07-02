import { z } from 'zod';

import { isModelMode, isPermissionMode, type ModelMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { ReviewCommentDraftSchema } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import { SessionActionDraftSchema } from '@/sync/domains/sessionActions/sessionActionDraftMeta';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { scopedSessionLocalStateKey } from './sessionLocalStateKeys';
import { getPersistenceStorage } from './persistenceStorage';

function sessionDraftsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-drafts', scope);
}

function sessionPermissionModesKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-permission-modes', scope);
}

function sessionPermissionModeUpdatedAtsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-permission-mode-updated-ats', scope);
}

function sessionLastViewedKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-last-viewed', scope);
}

function sessionModelModesKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-model-modes', scope);
}

function sessionModelModeUpdatedAtsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-model-mode-updated-ats-v1', scope);
}

function sessionReviewCommentsDraftsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-review-comments-draft-v1', scope);
}

function workspaceReviewCommentsDraftsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('workspace-review-comments-draft-v1', scope);
}

function sessionActionDraftsKey(scope?: ServerAccountScope | null): string {
    return scopedSessionLocalStateKey('session-action-drafts-v1', scope);
}

export function loadSessionDrafts(scope?: ServerAccountScope | null): Record<string, string> {
    const mmkv = getPersistenceStorage();
    const drafts = mmkv.getString(sessionDraftsKey(scope));
    if (drafts) {
        try {
            return JSON.parse(drafts);
        } catch (e) {
            console.error('Failed to parse session drafts', e);
            return {};
        }
    }
    return {};
}

export function saveSessionDrafts(drafts: Record<string, string>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionDraftsKey(scope), JSON.stringify(drafts));
}

export type SessionReviewCommentDraftsBySessionId = Record<string, z.infer<typeof ReviewCommentDraftSchema>[]>;

export type WorkspaceReviewCommentDraftsByWorkspaceCacheKey = Record<string, z.infer<typeof ReviewCommentDraftSchema>[]>;

export function loadSessionReviewCommentsDrafts(scope?: ServerAccountScope | null): SessionReviewCommentDraftsBySessionId {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionReviewCommentsDraftsKey(scope));
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const out: SessionReviewCommentDraftsBySessionId = {};
        for (const [rawSessionId, rawDrafts] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof rawSessionId !== 'string' || !rawSessionId.trim()) continue;
            if (!Array.isArray(rawDrafts)) continue;

            const drafts: z.infer<typeof ReviewCommentDraftSchema>[] = [];
            for (const entry of rawDrafts) {
                const entryParsed = ReviewCommentDraftSchema.safeParse(entry);
                if (entryParsed.success) drafts.push(entryParsed.data);
            }
            if (drafts.length > 0) out[rawSessionId] = drafts;
        }
        return out;
    } catch (e) {
        console.error('Failed to parse session review comment drafts', e);
        return {};
    }
}

export function saveSessionReviewCommentsDrafts(
    drafts: SessionReviewCommentDraftsBySessionId,
    scope?: ServerAccountScope | null,
): void {
    const mmkv = getPersistenceStorage();
    const key = sessionReviewCommentsDraftsKey(scope);
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(key);
        return;
    }
    mmkv.set(key, JSON.stringify(drafts));
}

export function loadWorkspaceReviewCommentsDrafts(scope?: ServerAccountScope | null): WorkspaceReviewCommentDraftsByWorkspaceCacheKey {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(workspaceReviewCommentsDraftsKey(scope));
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const out: WorkspaceReviewCommentDraftsByWorkspaceCacheKey = {};
        for (const [rawWorkspaceCacheKey, rawDrafts] of Object.entries(parsed as Record<string, unknown>)) {
            const workspaceCacheKey = typeof rawWorkspaceCacheKey === 'string' ? rawWorkspaceCacheKey.trim() : '';
            if (!workspaceCacheKey) continue;
            if (!Array.isArray(rawDrafts)) continue;

            const drafts: z.infer<typeof ReviewCommentDraftSchema>[] = [];
            for (const entry of rawDrafts) {
                const entryParsed = ReviewCommentDraftSchema.safeParse(entry);
                if (entryParsed.success) drafts.push(entryParsed.data);
            }
            if (drafts.length > 0) out[workspaceCacheKey] = drafts;
        }
        return out;
    } catch (e) {
        console.error('Failed to parse workspace review comment drafts', e);
        return {};
    }
}

export function saveWorkspaceReviewCommentsDrafts(
    drafts: WorkspaceReviewCommentDraftsByWorkspaceCacheKey,
    scope?: ServerAccountScope | null,
): void {
    const mmkv = getPersistenceStorage();
    const key = workspaceReviewCommentsDraftsKey(scope);
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(key);
        return;
    }
    mmkv.set(key, JSON.stringify(drafts));
}

export type SessionActionDraftsBySessionId = Record<string, z.infer<typeof SessionActionDraftSchema>[]>;

export function loadSessionActionDrafts(scope?: ServerAccountScope | null): SessionActionDraftsBySessionId {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionActionDraftsKey(scope));
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const out: SessionActionDraftsBySessionId = {};
        for (const [rawSessionId, rawDrafts] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof rawSessionId !== 'string' || !rawSessionId.trim()) continue;
            if (!Array.isArray(rawDrafts)) continue;

            const drafts: z.infer<typeof SessionActionDraftSchema>[] = [];
            for (const entry of rawDrafts) {
                const entryParsed = SessionActionDraftSchema.safeParse(entry);
                if (entryParsed.success) drafts.push(entryParsed.data);
            }
            if (drafts.length > 0) out[rawSessionId] = drafts;
        }
        return out;
    } catch (e) {
        console.error('Failed to parse session action drafts', e);
        return {};
    }
}

export function saveSessionActionDrafts(
    drafts: SessionActionDraftsBySessionId,
    scope?: ServerAccountScope | null,
): void {
    const mmkv = getPersistenceStorage();
    const key = sessionActionDraftsKey(scope);
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(key);
        return;
    }
    mmkv.set(key, JSON.stringify(drafts));
}

export function loadSessionPermissionModes(scope?: ServerAccountScope | null): Record<string, PermissionMode> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionPermissionModesKey(scope));
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, PermissionMode> = {};
            for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (isPermissionMode(value)) {
                    result[sessionId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse session permission modes', e);
            return {};
        }
    }
    return {};
}

export function saveSessionPermissionModes(modes: Record<string, PermissionMode>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionPermissionModesKey(scope), JSON.stringify(modes));
}

export function loadSessionPermissionModeUpdatedAts(scope?: ServerAccountScope | null): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionPermissionModeUpdatedAtsKey(scope));
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, number> = {};
            for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    result[sessionId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse session permission mode updated timestamps', e);
            return {};
        }
    }
    return {};
}

export function saveSessionPermissionModeUpdatedAts(
    updatedAts: Record<string, number>,
    scope?: ServerAccountScope | null,
) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionPermissionModeUpdatedAtsKey(scope), JSON.stringify(updatedAts));
}

export function loadSessionLastViewed(scope?: ServerAccountScope | null): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionLastViewedKey(scope));
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, number> = {};
            for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    result[sessionId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse session last viewed timestamps', e);
            return {};
        }
    }
    return {};
}

export function saveSessionLastViewed(data: Record<string, number>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionLastViewedKey(scope), JSON.stringify(data));
}

export function loadSessionModelModes(scope?: ServerAccountScope | null): Record<string, ModelMode> {
    const mmkv = getPersistenceStorage();
    const modes = mmkv.getString(sessionModelModesKey(scope));
    if (modes) {
        try {
            const parsed: unknown = JSON.parse(modes);
            if (!parsed || typeof parsed !== 'object') {
                return {};
            }

            const result: Record<string, ModelMode> = {};
            Object.entries(parsed as Record<string, unknown>).forEach(([sessionId, mode]) => {
                if (!isModelMode(mode)) return;
                const normalized = String(mode).trim();
                if (!normalized) return;
                result[sessionId] = normalized;
            });
            return result;
        } catch (e) {
            console.error('Failed to parse session model modes', e);
            return {};
        }
    }
    return {};
}

export function saveSessionModelModes(modes: Record<string, ModelMode>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionModelModesKey(scope), JSON.stringify(modes));
}

export function loadSessionModelModeUpdatedAts(scope?: ServerAccountScope | null): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionModelModeUpdatedAtsKey(scope));
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, number> = {};
            for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    result[sessionId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse session model mode updatedAts', e);
            return {};
        }
    }
    return {};
}

export function saveSessionModelModeUpdatedAts(data: Record<string, number>, scope?: ServerAccountScope | null) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionModelModeUpdatedAtsKey(scope), JSON.stringify(data));
}

export function prepareSessionPersistenceScopeForActivation(scope: ServerAccountScope): void {
    const mmkv = getPersistenceStorage();

    if (typeof mmkv.getString(sessionDraftsKey(scope)) !== 'string') {
        const legacyDrafts = loadSessionDrafts();
        if (Object.keys(legacyDrafts).length > 0) {
            saveSessionDrafts(legacyDrafts, scope);
        }
    }

    if (typeof mmkv.getString(sessionReviewCommentsDraftsKey(scope)) !== 'string') {
        const legacyReviewDrafts = loadSessionReviewCommentsDrafts();
        if (Object.keys(legacyReviewDrafts).length > 0) {
            saveSessionReviewCommentsDrafts(legacyReviewDrafts, scope);
        }
    }

    if (typeof mmkv.getString(workspaceReviewCommentsDraftsKey(scope)) !== 'string') {
        const legacyWorkspaceReviewDrafts = loadWorkspaceReviewCommentsDrafts();
        if (Object.keys(legacyWorkspaceReviewDrafts).length > 0) {
            saveWorkspaceReviewCommentsDrafts(legacyWorkspaceReviewDrafts, scope);
        }
    }

    if (typeof mmkv.getString(sessionActionDraftsKey(scope)) !== 'string') {
        const legacyActionDrafts = loadSessionActionDrafts();
        if (Object.keys(legacyActionDrafts).length > 0) {
            saveSessionActionDrafts(legacyActionDrafts, scope);
        }
    }

    mmkv.delete(sessionDraftsKey());
    mmkv.delete(sessionReviewCommentsDraftsKey());
    mmkv.delete(workspaceReviewCommentsDraftsKey());
    mmkv.delete(sessionActionDraftsKey());
    mmkv.delete(sessionPermissionModesKey());
    mmkv.delete(sessionPermissionModeUpdatedAtsKey());
    mmkv.delete(sessionModelModesKey());
    mmkv.delete(sessionModelModeUpdatedAtsKey());
    mmkv.delete(sessionLastViewedKey());
}
