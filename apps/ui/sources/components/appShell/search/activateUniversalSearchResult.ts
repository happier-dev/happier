import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import type { OpenProjectOptions } from '@/components/projects/useOpenProject';
import type { FileFindSeed as FindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';

import type { UniversalSearchTarget } from './universalSearchResult';
import { memoryDocumentSearchHitHref } from '@/components/memory/memoryDocumentRoutes';

/**
 * The one place a built-in Universal Search row turns into navigation.
 *
 * It is an ADAPTER, not a navigation owner: every branch below hands the exact
 * target facts to the canonical owner that already knows how to reach that
 * entity (the scoped session-navigation hook, the project-opening owner, the
 * settings route). Nothing here invents a route shape, and no branch falls back
 * to "whatever is focused right now" — a target that can no longer be resolved
 * fails as `unavailable` so the surface can say so, rather than silently opening
 * a different entity.
 *
 * Ordering (plan §4.2) is owned by the caller: commit the identity, dismiss the
 * host, then AWAIT this. This function therefore returns a promise the caller
 * must await and catch; it never fires and forgets.
 */

export type UniversalSearchActivationOutcome =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'failed' }>;

export type UniversalSearchActivationOwners = Readonly<{
    openExternalConversation?: (target: Extract<UniversalSearchTarget, { kind: 'externalConversation' }>) => Promise<boolean>;
    /** Canonical scoped session navigation (Home switch + telemetry + singular route). */
    navigateToSession: (
        sessionId: string,
        options?: Readonly<{
            serverId?: string;
            query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
        }>,
    ) => void | Promise<void>;
    /** Canonical router push for non-session destinations. */
    push: (path: string) => void;
    /** Canonical project opener, including persisted surface/worktree state. */
    openProject: (workspaceRefId: string, options?: OpenProjectOptions) => boolean;
    stageFileFindSeed?: (target: Extract<UniversalSearchTarget, { kind: 'workspaceFile' }>, seed: FindSeed) => (() => void) | null;
    /**
     * Re-resolves whether the exact target still exists for this reader RIGHT
     * NOW. Returning `false` keeps the surface coherent instead of navigating to
     * a retired Home, deleted session or detached workspace.
     */
    isTargetCurrent?: (target: UniversalSearchTarget) => boolean;
}>;

export async function activateUniversalSearchResult(
    target: UniversalSearchTarget,
    owners: UniversalSearchActivationOwners,
): Promise<UniversalSearchActivationOutcome> {
    if (owners.isTargetCurrent && !owners.isTargetCurrent(target)) {
        return { ok: false, reason: 'unavailable' };
    }

    try {
        switch (target.kind) {
            case 'externalConversation':
                return await owners.openExternalConversation?.(target) ? { ok: true } : { ok: false, reason: 'unavailable' };
            case 'memoryDocument': {
                owners.push(memoryDocumentSearchHitHref(target));
                return { ok: true };
            }
            case 'session': {
                const sessionId = target.sessionId.trim();
                if (!sessionId) return { ok: false, reason: 'unavailable' };
                await owners.navigateToSession(sessionId, {
                    ...(target.serverId ? { serverId: target.serverId } : {}),
                    // A transcript hit is message-granular: the sequence is part
                    // of the identity the user selected, not a nicety.
                    ...(typeof target.seq === 'number' && Number.isFinite(target.seq)
                        ? { query: { jumpSeq: Math.max(0, Math.trunc(target.seq)) } }
                        : {}),
                });
                return { ok: true };
            }
            case 'project': {
                if (!target.workspaceRefId.trim()) return { ok: false, reason: 'unavailable' };
                if (!owners.openProject(target.workspaceRefId, { serverId: target.serverId })) {
                    return { ok: false, reason: 'unavailable' };
                }
                return { ok: true };
            }
            case 'settingsPage': {
                if (!target.route.trim()) return { ok: false, reason: 'unavailable' };
                owners.push(target.route);
                return { ok: true };
            }
            case 'workspaceFile': {
                const cancelSeed = target.find ? owners.stageFileFindSeed?.(target, target.find) : undefined;
                if (target.find && cancelSeed === null) return { ok: false, reason: 'unavailable' };
                try {
                    if (target.workspaceRefId) {
                        const opened = owners.openProject(target.workspaceRefId, {
                            serverId: target.scope.serverId,
                            activeRootPath: target.scope.rootPath,
                            initialResource: { kind: 'file', path: target.path, ...(target.anchor ? { anchor: target.anchor } : {}),
                                ...(target.anchorSource ? { anchorSource: target.anchorSource } : {}), ...(target.find ? { find: target.find } : {}) },
                        });
                        if (!opened) cancelSeed?.();
                        return opened ? { ok: true } : { ok: false, reason: 'unavailable' };
                    }
                    // The canonical file-detail owner is the session pane's details
                    // tab, addressed through the same URL state that owner already
                    // parses — not a second file-opening path.
                    if (!target.sessionId) { cancelSeed?.(); return { ok: false, reason: 'unavailable' }; }
                    await owners.navigateToSession(target.sessionId, {
                        ...(target.serverId ? { serverId: target.serverId } : {}),
                        query: {
                            ...serializeSessionPaneUrlState({
                                rightTabId: 'files',
                                details: { kind: 'file', path: target.path, ...(target.anchor ? { anchor: target.anchor } : {}),
                                    ...(target.anchorSource ? { anchorSource: target.anchorSource } : {}) },
                            }),
                        },
                    });
                } catch (error) {
                    cancelSeed?.();
                    throw error;
                }
                return { ok: true };
            }
            case 'workspaceCommit': {
                if (target.workspaceRefId) {
                    return owners.openProject(target.workspaceRefId, {
                        serverId: target.scope.serverId,
                        activeRootPath: target.scope.rootPath,
                        initialResource: { kind: 'commit', sha: target.sha },
                    }) ? { ok: true } : { ok: false, reason: 'unavailable' };
                }
                if (!target.sessionId) return { ok: false, reason: 'unavailable' };
                await owners.navigateToSession(target.sessionId, {
                    ...(target.serverId ? { serverId: target.serverId } : {}),
                    query: {
                        ...serializeSessionPaneUrlState({
                            rightTabId: 'git',
                            details: { kind: 'commit', sha: target.sha },
                        }),
                    },
                });
                return { ok: true };
            }
        }
    } catch {
        return { ok: false, reason: 'failed' };
    }
}
