import type { SessionNewSessionSeedOutcome } from '@happier-dev/protocol/plugins/ui';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { admitProjectAuthoringOrigin } from '@/components/projects/detail/projectRouteState';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
import type { ComposerDraftAppendContent } from '@/components/sessions/composer/admitComposerDraftItems';

/** Page-host navigation adapter shared by semantic Host API and authoring Actions. */
export async function openOrdinaryNewSessionSeed(params: Readonly<{
    seed: unknown;
    configurationDraft?: NewSessionDraft;
    /** Host-owned prepared media; never part of the public seed. */
    media?: ComposerDraftAppendContent;
    pluginId?: string;
    scope: ServerAccountScope;
    signal?: AbortSignal;
    isCurrent: () => boolean;
}>): Promise<SessionNewSessionSeedOutcome> {
    try {
        const [{ seedAndOpenNewSession }, { router }] = await Promise.all([
            import('./newSessionSeedComposer'),
            import('expo-router'),
        ]);
        const outcome = seedAndOpenNewSession({
            seed: params.seed,
            ...(params.configurationDraft ? { configurationDraft: params.configurationDraft } : {}),
            ...(params.media ? { media: params.media } : {}),
            ...(params.pluginId ? { pluginId: params.pluginId } : {}),
            scope: params.scope,
            ...(params.signal ? { signal: params.signal } : {}),
            isCurrent: params.isCurrent,
            admitOrigin: origin => admitProjectAuthoringOrigin(origin, params.scope),
            navigateToNewSession: ({ dataId, draftId, worktree, spawnServerId, machineId, directory }) => {
                router.push({
                    pathname: '/new',
                    params: {
                        draftId,
                        ...(params.configurationDraft ? {
                            draftServerId: params.scope.serverId,
                            draftAccountId: params.scope.accountId,
                        } : {}),
                        ...(dataId === null ? {} : { dataId }),
                        ...(worktree === undefined ? {} : { worktree }),
                        ...(spawnServerId === undefined ? {} : { spawnServerId }),
                        ...(machineId === undefined ? {} : { machineId }),
                        ...(directory === undefined ? {} : { directory }),
                    },
                });
            },
        });
        if (outcome.kind === 'opened' && params.media) {
            const [{ flushAttachmentDraftsForKey }, { newSessionAttachmentDraftKey }, { resolveNewSessionDraftAttachmentFlowId }] = await Promise.all([
                import('@/components/sessions/attachments/attachmentDraftMemoryStore'),
                import('./attachments/newSessionAttachmentDraftStore'),
                import('./attachments/newSessionDraftAttachmentFlowId'),
            ]);
            await flushAttachmentDraftsForKey(newSessionAttachmentDraftKey(resolveNewSessionDraftAttachmentFlowId(outcome.draftId), params.scope));
        }
        return outcome;
    } catch {
        return { kind: 'unavailable', reason: 'navigation_unavailable' };
    }
}
