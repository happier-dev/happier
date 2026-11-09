import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** Resume an existing draft with its owning Home and Account, without creating a seed. */
export function buildNewSessionDraftContinueRoute(draftId: string, scope: ServerAccountScope): Readonly<{
    pathname: '/new';
    params: Readonly<{ draftId: string; spawnServerId: string; draftServerId: string; draftAccountId: string }>;
}> {
    return { pathname: '/new', params: { draftId, spawnServerId: scope.serverId,
        draftServerId: scope.serverId, draftAccountId: scope.accountId } };
}

export async function navigateToSavedNewSessionDraft(draftId: string, scope: ServerAccountScope,
    isCurrent: () => boolean): Promise<boolean> {
    try {
        const [{ router }, { interceptNewSessionEntry }] = await Promise.all([
            import('expo-router'),
            import('@/components/sessions/new/navigation/newSessionEntry'),
        ]);
        if (!isCurrent()) return false;
        const href = buildNewSessionDraftContinueRoute(draftId, scope);
        if (!interceptNewSessionEntry(href)) router.push(href);
        return true;
    } catch {
        return false;
    }
}
