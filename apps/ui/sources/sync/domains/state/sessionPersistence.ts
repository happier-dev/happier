import { z } from 'zod';

import { isModelMode, isPermissionMode, type ModelMode, type PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { ReviewCommentDraftSchema } from '@/sync/domains/input/reviewComments/reviewCommentMeta';
import { SessionActionDraftSchema } from '@/sync/domains/sessionActions/sessionActionDraftMeta';
import { getPersistenceStorage } from './persistenceStorage';

function sessionDraftsKey(): string {
    return 'session-drafts';
}

function sessionPermissionModesKey(): string {
    return 'session-permission-modes';
}

function sessionPermissionModeUpdatedAtsKey(): string {
    return 'session-permission-mode-updated-ats';
}

function sessionLastViewedKey(): string {
    return 'session-last-viewed';
}

function sessionModelModesKey(): string {
    return 'session-model-modes';
}

function sessionModelModeUpdatedAtsKey(): string {
    return 'session-model-mode-updated-ats-v1';
}

function sessionReviewCommentsDraftsKey(): string {
    return 'session-review-comments-draft-v1';
}

function workspaceReviewCommentsDraftsKey(): string {
    return 'workspace-review-comments-draft-v1';
}

function sessionActionDraftsKey(): string {
    return 'session-action-drafts-v1';
}

export function loadSessionDrafts(): Record<string, string> {
    const mmkv = getPersistenceStorage();
    const drafts = mmkv.getString(sessionDraftsKey());
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

export function saveSessionDrafts(drafts: Record<string, string>) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionDraftsKey(), JSON.stringify(drafts));
}

export type SessionReviewCommentDraftsBySessionId = Record<string, z.infer<typeof ReviewCommentDraftSchema>[]>;

export type WorkspaceReviewCommentDraftsByWorkspaceCacheKey = Record<string, z.infer<typeof ReviewCommentDraftSchema>[]>;

export function loadSessionReviewCommentsDrafts(): SessionReviewCommentDraftsBySessionId {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionReviewCommentsDraftsKey());
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

export function saveSessionReviewCommentsDrafts(drafts: SessionReviewCommentDraftsBySessionId): void {
    const mmkv = getPersistenceStorage();
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(sessionReviewCommentsDraftsKey());
        return;
    }
    mmkv.set(sessionReviewCommentsDraftsKey(), JSON.stringify(drafts));
}

export function loadWorkspaceReviewCommentsDrafts(): WorkspaceReviewCommentDraftsByWorkspaceCacheKey {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(workspaceReviewCommentsDraftsKey());
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

export function saveWorkspaceReviewCommentsDrafts(drafts: WorkspaceReviewCommentDraftsByWorkspaceCacheKey): void {
    const mmkv = getPersistenceStorage();
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(workspaceReviewCommentsDraftsKey());
        return;
    }
    mmkv.set(workspaceReviewCommentsDraftsKey(), JSON.stringify(drafts));
}

export type SessionActionDraftsBySessionId = Record<string, z.infer<typeof SessionActionDraftSchema>[]>;

export function loadSessionActionDrafts(): SessionActionDraftsBySessionId {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionActionDraftsKey());
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

export function saveSessionActionDrafts(drafts: SessionActionDraftsBySessionId): void {
    const mmkv = getPersistenceStorage();
    if (!drafts || typeof drafts !== 'object' || Object.keys(drafts).length === 0) {
        mmkv.delete(sessionActionDraftsKey());
        return;
    }
    mmkv.set(sessionActionDraftsKey(), JSON.stringify(drafts));
}

export function loadSessionPermissionModes(): Record<string, PermissionMode> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionPermissionModesKey());
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

export function saveSessionPermissionModes(modes: Record<string, PermissionMode>) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionPermissionModesKey(), JSON.stringify(modes));
}

export function loadSessionPermissionModeUpdatedAts(): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionPermissionModeUpdatedAtsKey());
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

export function saveSessionPermissionModeUpdatedAts(updatedAts: Record<string, number>) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionPermissionModeUpdatedAtsKey(), JSON.stringify(updatedAts));
}

export function loadSessionLastViewed(): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionLastViewedKey());
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

export function saveSessionLastViewed(data: Record<string, number>) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionLastViewedKey(), JSON.stringify(data));
}

export function loadSessionModelModes(): Record<string, ModelMode> {
    const mmkv = getPersistenceStorage();
    const modes = mmkv.getString(sessionModelModesKey());
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

export function saveSessionModelModes(modes: Record<string, ModelMode>) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionModelModesKey(), JSON.stringify(modes));
}

export function loadSessionModelModeUpdatedAts(): Record<string, number> {
    const mmkv = getPersistenceStorage();
    const raw = mmkv.getString(sessionModelModeUpdatedAtsKey());
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

export function saveSessionModelModeUpdatedAts(data: Record<string, number>) {
    const mmkv = getPersistenceStorage();
    mmkv.set(sessionModelModeUpdatedAtsKey(), JSON.stringify(data));
}
